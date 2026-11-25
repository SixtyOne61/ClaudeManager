// Visionneuse d'une pièce jointe, ouverte par un clic sur sa pastille (message envoyé ou zone
// de saisie) : image, texte (Markdown rendu pour `.md`) ou PDF, lus par le backend
// (`attachment_preview`). Une image collée supprimée depuis est montrée d'après la copie que
// Claude Code garde dans la conversation. Les autres fichiers s'ouvrent avec l'application
// par défaut.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, X } from "lucide-react";
import { baseName } from "../attachments";
import { renderMarkdown } from "../markdown";
import { t } from "../i18n";
import { errorMessage } from "../api";

type Preview =
  | { kind: "image"; src: string; transcript: boolean }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "pdf"; data: string }
  | { kind: "unsupported" }
  | { kind: "missing" };

interface Props {
  path: string;
  /** Conversation du message : copie d'une image disparue. */
  sessionId?: string | null;
  cwd?: string | null;
  onClose: () => void;
}

export function AttachmentViewer({ path, sessionId = null, cwd = null, onClose }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    invoke<Preview>("attachment_preview", { path, sessionId, cwd })
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [path, sessionId, cwd]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // PDF : affiché par le lecteur intégré du webview, depuis une URL `blob:`.
  const pdfUrl = useMemo(() => {
    if (preview?.kind !== "pdf") return null;
    const bytes = Uint8Array.from(atob(preview.data), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  }, [preview]);
  useEffect(() => () => void (pdfUrl && URL.revokeObjectURL(pdfUrl)), [pdfUrl]);

  const isMarkdown = /\.(md|markdown)$/i.test(path);
  const markdownHtml = useMemo(
    () => (preview?.kind === "text" && isMarkdown ? renderMarkdown(preview.text) : null),
    [preview, isMarkdown],
  );

  const openExternal = () => invoke("open_attachment", { path }).catch((e) => setError(errorMessage(e)));
  const onDisk = preview !== null && preview.kind !== "missing" && !(preview.kind === "image" && preview.transcript);

  let body;
  if (error) body = <div className="viewer-message">{error}</div>;
  else if (!preview) body = <div className="viewer-message">{t("tools.attachment.loading")}</div>;
  else if (preview.kind === "image") body = <img className="viewer-image" src={preview.src} alt={baseName(path)} />;
  else if (preview.kind === "pdf") body = pdfUrl && <iframe className="viewer-pdf" src={pdfUrl} title={baseName(path)} />;
  else if (preview.kind === "text")
    body = (
      <>
        {markdownHtml !== null ? (
          <div className="viewer-text markdown" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
        ) : (
          <pre className="viewer-text">{preview.text}</pre>
        )}
        {preview.truncated && <div className="viewer-note">{t("tools.attachment.truncated")}</div>}
      </>
    );
  else if (preview.kind === "unsupported")
    body = <div className="viewer-message">{t("tools.attachment.unsupported")}</div>;
  else
    body = (
      <div className="viewer-message">{t("tools.attachment.missing")}</div>
    );

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="viewer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="viewer-header">
          <div className="viewer-title">
            <span className="viewer-name">{baseName(path)}</span>
            <span className="viewer-path" title={path}>
              {preview?.kind === "image" && preview.transcript ? t("tools.attachment.transcriptCopy") : path}
            </span>
          </div>
          <button className="btn small" onClick={openExternal} disabled={!onDisk} title={t("tools.attachment.openTitle")}>
            <ExternalLink size={13} /> {t("tools.attachment.open")}
          </button>
          <button className="btn small ghost" onClick={onClose} title={t("tools.attachment.closeTitle")}>
            <X size={14} />
          </button>
        </div>
        <div className="viewer-body">{body}</div>
      </div>
    </div>,
    document.body,
  );
}
