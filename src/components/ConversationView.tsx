// Interface de conversation dessinée par l'app par-dessus le terminal intégré (ticket 05) :
// messages de l'utilisateur (bulles à droite), réponses de Claude (texte Markdown à gauche,
// sous une étiquette « Claude ») et ses actions, regroupées en lignes compactes
// (`ConversationActions`). Les messages entre conversations ont leur propre bulle (« Message
// de … » reçu, « Message à … » envoyé, voir src/messages.ts). La zone de saisie est `ConversationInput`.
// Les liens `http(s)` des réponses s'ouvrent dans le navigateur ; les blocs de commande
// (`bash`, `powershell`, `cmd`…) ont un bouton ▶ pour les exécuter (`CodeRunner`).

import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { baseName, composeMessage, isImagePath, splitAttachments } from "../attachments";
import { ChevronDown, ChevronRight, File as FileIcon, Image as ImageIcon, Inbox, Paperclip, Pencil, Send, SendHorizontal, Sparkle, Square, TriangleAlert, X } from "lucide-react";
import {
  groupEntries,
  messageKey,
  type ClaudeItem,
  type ConversationData,
  type ConversationEntry,
  type EditableMessage,
  type MessageEntry,
  type ToolResultEntry,
} from "../conversation";
import { ConversationLinksContext, resolvePeer, useMessagingDirectory } from "../messages";
import { renderMarkdown } from "../markdown";
import { GrillAnswers, grillHtml, isGrillAnswer } from "./Grill";
import { ActionGroup } from "./ConversationActions";
import type { SearchFocus } from "./GlobalSearch";
import { useSlashMenu } from "./SlashMenu";
import { AttachmentViewer } from "./AttachmentViewer";
import { CodeRunnerPortal, type RunnableBlock } from "./CodeRunner";
import { isRunnableLang } from "../runner";
import { t } from "../i18n";
import { tSplit } from "../i18n/rich";


/** Dossier de la conversation : les commandes des blocs ▶ s'y exécutent. */
const CwdContext = createContext<string | null>(null);
/** Identifiant de la conversation : copie d'une image jointe disparue (visionneuse). */
const SessionContext = createContext<string | null>(null);

interface Props {
  data: ConversationData;
  /** Résultat de recherche à faire défiler jusqu'à lui (ligne / uuid du message). */
  focus?: SearchFocus | null;
  /** Masquée (terminal affiché) : gardée montée pour conserver sa position de défilement. */
  hidden: boolean;
  /** Dossier de la conversation (commandes exécutées depuis les blocs de code). */
  cwd?: string | null;
  /** Identifiant de la conversation (visionneuse des pièces jointes). */
  sessionId?: string | null;
  /** Dernier message encore modifiable (Claude n'a pas commencé à répondre), ou null. */
  editable?: EditableMessage | null;
  onEdit?: (m: EditableMessage) => void;
  /** Messages remplacés par une modification (repères `messageKey`). */
  replaced?: ReadonlySet<string>;
}

export function ConversationView({ data, focus, hidden, cwd = null, sessionId = null, editable = null, onEdit, replaced }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Tours de Claude et groupes d'actions consécutives.
  const blocks = useMemo(() => groupEntries(data.entries), [data.entries]);

  // Reste collé en bas quand de nouveaux éléments arrivent, si on y était déjà.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [data.entries, hidden]);

  // Résultat de la recherche globale : défile jusqu'au message, dès qu'il est affiché.
  const pendingFocus = useRef<SearchFocus | null>(null);
  useEffect(() => {
    pendingFocus.current = focus ?? null;
  }, [focus]);
  useEffect(() => {
    const f = pendingFocus.current;
    const root = scrollRef.current;
    if (!f || !root || hidden) return;
    const byUuid = f.uuid ? root.querySelector<HTMLElement>(`[data-uuid="${CSS.escape(f.uuid)}"]`) : null;
    const el = byUuid ?? (f.line != null ? root.querySelector<HTMLElement>(`[data-line="${f.line}"]`) : null);
    if (!el) return; // pas encore lu (ou hors de la partie affichée d'un gros fichier)
    pendingFocus.current = null;
    atBottom.current = false;
    el.scrollIntoView({ block: "center" });
    el.classList.add("search-focused");
    setTimeout(() => el.classList.remove("search-focused"), 2500);
  }, [focus, data.entries, hidden]);

  // La fenêtre de l'app ne navigue jamais : les liens `http(s)` de l'agent s'ouvrent dans le
  // navigateur par défaut, les autres (fichiers, ancres, `javascript:`…) ne sont pas suivis.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) openUrl(href).catch(() => {});
  };

  return (
    <div
      className="conversation"
      ref={scrollRef}
      style={{ visibility: hidden ? "hidden" : undefined }}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      onClick={onClick}
    >
      <CwdContext.Provider value={cwd}>
      <SessionContext.Provider value={sessionId}>
      <div className="conversation-inner">
        {data.headSkipped && <div className="conv-notice">{t("conversation.view.headSkipped")}</div>}
        {data.exists === false && <div className="conv-empty">{t("conversation.view.newConversation")}</div>}
        {data.exists && data.entries.length === 0 && <div className="conv-empty">{t("conversation.view.noMessages")}</div>}
        {blocks.map((b) => {
          switch (b.kind) {
            case "user":
              return (
                <UserBubble
                  key={b.key}
                  entry={b.entry}
                  replaced={replaced?.has(messageKey(b.entry)) ?? false}
                  onEdit={editable && onEdit && editable.line === b.entry.line ? () => onEdit(editable) : undefined}
                />
              );
            case "notice":
              return (
                <div key={b.key} className="conv-notice" data-line={b.entry.line} data-uuid={b.entry.uuid ?? undefined}>
                  {b.entry.code === "compacted"
                    ? t("conversation.notice.compacted")
                    : b.entry.code === "interrupted"
                      ? t("conversation.notice.interrupted")
                      : b.entry.text}
                </div>
              );
            case "message":
              return <CrossMessage key={b.key} entry={b.entry} />;
            case "claude":
              return <ClaudeTurn key={b.key} items={b.items} />;
          }
        })}
      </div>
      </SessionContext.Provider>
      </CwdContext.Provider>
    </div>
  );
}

interface BubbleProps {
  entry: Extract<ConversationEntry, { kind: "user" }>;
  /** Remplacé par une version modifiée (affiché en retrait). */
  replaced: boolean;
  /** Présent tant que le message peut être modifié. */
  onEdit?: () => void;
}

function UserBubble({ entry, replaced, onEdit }: BubbleProps) {
  return (
    <div className={"conv-user" + (replaced ? " replaced" : "")} data-line={entry.line} data-uuid={entry.uuid ?? undefined}>
      {onEdit && (
        <button className="conv-edit-btn" onClick={onEdit} title={t("conversation.bubble.editTitle")}>
          <Pencil size={13} />
        </button>
      )}
      <div className="conv-user-col">
        {replaced && <span className="conv-replaced-label">{t("conversation.bubble.replaced")}</span>}
        {!entry.command && isGrillAnswer(entry.text) ? (
          <div className="conv-bubble grill-answers">
            <GrillAnswers text={entry.text} />
          </div>
        ) : entry.command ? (
          <div className="conv-bubble command">{entry.text}</div>
        ) : (
          <UserText text={entry.text} />
        )}
      </div>
    </div>
  );
}

/** Texte d'un message, ses pièces jointes (mentions `@"chemin"`) en pastilles au-dessus. */
function UserText({ text }: { text: string }) {
  const parts = useMemo(() => splitAttachments(text), [text]);
  const cwd = useContext(CwdContext);
  const sessionId = useContext(SessionContext);
  const [viewing, setViewing] = useState<string | null>(null);
  return (
    <>
      {parts.paths.length > 0 && (
        <div className="conv-bubble-attachments">
          {parts.paths.map((p, i) => (
            <button key={i} type="button" className="conv-attachment clickable" title={t("conversation.attachment.title", { path: p })} onClick={() => setViewing(p)}>
              {isImagePath(p) ? <ImageIcon size={14} /> : <FileIcon size={14} />}
              <span className="conv-attachment-name">{baseName(p)}</span>
            </button>
          ))}
        </div>
      )}
      {parts.text && <div className="conv-bubble">{parts.text}</div>}
      {viewing && <AttachmentViewer path={viewing} sessionId={sessionId} cwd={cwd} onClose={() => setViewing(null)} />}
    </>
  );
}

const AssistantText = memo(function AssistantText({ line, uuid, text }: { line: number; uuid: string | null; text: string }) {
  // Série de questions (skill « grilling ») : une carte par question.
  const html = useMemo(() => grillHtml(text) ?? renderMarkdown(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  const cwd = useContext(CwdContext);
  const [blocks, setBlocks] = useState<RunnableBlock[]>([]);

  // Blocs de commande : chacun est enveloppé (`.code-block`) et reçoit, sous son `<pre>`, un
  // emplacement où `CodeRunner` dessine son bouton ▶ et son terminal. Refait quand le HTML
  // change (React le remplace alors en entier).
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const found: RunnableBlock[] = [];
    root.querySelectorAll<HTMLElement>("pre > code").forEach((code, i) => {
      const lang = /(?:^|\s)language-([\w+-]+)/.exec(code.className)?.[1] ?? "";
      if (!isRunnableLang(lang)) return;
      const pre = code.parentElement!;
      let wrap = pre.parentElement!;
      if (!wrap.classList.contains("code-block")) {
        wrap = document.createElement("div");
        wrap.className = "code-block";
        pre.replaceWith(wrap);
        wrap.appendChild(pre);
      }
      let host = wrap.querySelector<HTMLElement>(":scope > .code-runner");
      if (!host) {
        host = document.createElement("div");
        host.className = "code-runner";
        wrap.appendChild(host);
      }
      found.push({ id: `${uuid ?? `l${line}`}-${i}`, lang, code: (code.textContent ?? "").replace(/\n$/, ""), host });
    });
    setBlocks(found);
  }, [html, uuid, line]);

  return (
    <>
      <div ref={ref} className="conv-assistant markdown" data-line={line} data-uuid={uuid ?? undefined} dangerouslySetInnerHTML={{ __html: html }} />
      {blocks.map((b) => (
        <CodeRunnerPortal key={b.id} block={b} cwd={cwd} />
      ))}
    </>
  );
});

/** Tour de Claude : étiquette « Claude », puis ses textes et groupes d'actions. */
function ClaudeTurn({ items }: { items: ClaudeItem[] }) {
  return (
    <div className="conv-claude">
      <div className="conv-claude-head">
        <span className="conv-claude-avatar">
          <Sparkle size={10} />
        </span>
        Claude
      </div>
      {items.map((it) =>
        it.kind === "text" ? (
          <AssistantText key={it.key} line={it.entry.line} uuid={it.entry.uuid} text={it.entry.text} />
        ) : it.kind === "message" ? (
          <CrossMessage key={it.key} entry={it.entry} result={it.result} />
        ) : (
          <ActionGroup key={it.key} actions={it.actions} />
        ),
      )}
    </div>
  );
}

/** Au-delà, un message qui a un résumé est replié (le résumé reste visible). */
const MESSAGE_FOLD_CHARS = 400;

/**
 * Message entre conversations : bulle distincte « Message de … » (reçu, à gauche) ou
 * « Message à … » (envoyé par Claude, dans son tour). Le nom de l'autre conversation est
 * cliquable quand elle est connue ; sinon son nom de messagerie brut est affiché.
 */
function CrossMessage({ entry, result }: { entry: MessageEntry; result?: ToolResultEntry }) {
  const links = useContext(ConversationLinksContext);
  const self = useContext(SessionContext);
  const names = useMessagingDirectory();
  const html = useMemo(() => renderMarkdown(entry.text), [entry.text]);
  const [open, setOpen] = useState(!entry.summary || entry.text.length <= MESSAGE_FOLD_CHARS);
  const peerId = resolvePeer(names, entry.peer, entry.timestamp);
  const id = peerId && peerId !== self ? peerId : null;
  const title = id && links ? links.titleOf(id) : null;
  const label = title ?? (entry.sent ? entry.peer : (entry.peerName ?? entry.peer));
  const [before, after] = tSplit(entry.sent ? "conversation.message.sent" : "conversation.message.received", "name");
  return (
    <div className={"conv-message " + (entry.sent ? "sent" : "received")} data-line={entry.line} data-uuid={entry.uuid ?? undefined}>
      <div className="conv-message-head">
        {entry.sent ? <Send size={12} /> : <Inbox size={12} />}
        {before.trim() && <span>{before.trim()}</span>}
        {id && title && links ? (
          <button className="link-btn" onClick={() => links.open(id)} title={t("conversation.message.openPeer", { title })}>
            <em>{label}</em>
          </button>
        ) : (
          <em title={entry.peer}>{label}</em>
        )}
        {after.trim() && <span>{after.trim()}</span>}
        {result?.isError && (
          <span className="conv-message-error" title={result.text}>
            {t("conversation.message.notDelivered")}
          </span>
        )}
      </div>
      {entry.summary && (
        <button className="conv-message-summary" onClick={() => setOpen((o) => !o)} title={open ? t("conversation.message.collapse") : t("conversation.message.expand")}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {entry.summary}
        </button>
      )}
      {open && <div className="conv-message-text markdown" dangerouslySetInnerHTML={{ __html: html }} />}
      {open && entry.truncated && <div className="conv-message-more">{t("conversation.message.truncated")}</div>}
    </div>
  );
}

// ---- Pièces jointes --------------------------------------------------------------------

/** Pièce jointe en attente dans la zone de saisie. */
interface Attachment {
  id: number;
  path: string;
  name: string;
  /** Aperçu (images collées). */
  preview?: string;
}

let nextAttachmentId = 1;

const toAttachments = (paths: string[]): Attachment[] => paths.map((path) => ({ id: nextAttachmentId++, path, name: baseName(path) }));

const readDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

/** Image collée → fichier temporaire (côté Rust), chemin renvoyé. */
async function savePastedImage(file: File): Promise<Attachment> {
  const ext = file.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
  const path = await invoke<string>("save_pasted_image", new Uint8Array(await file.arrayBuffer()), { headers: { "x-ext": ext } });
  return { id: nextAttachmentId++, path, name: baseName(path), preview: await readDataUrl(file) };
}

// ---- Zone de saisie --------------------------------------------------------------------

interface InputProps {
  /** `claude` tourne dans le terminal : on peut envoyer. */
  enabled: boolean;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  /** Mise au point de la zone (conversation affichée). */
  autoFocus: boolean;
  /** Dossier et identifiant de la conversation : commandes `/…` proposées (SlashMenu). */
  cwd?: string | null;
  sessionId?: string | null;
  /** Message en cours de modification : son texte est mis dans la zone, un bandeau l'indique. */
  editing?: EditableMessage | null;
  /** Abandon de la modification (Échap ou ✕) : le brouillon d'avant revient. */
  onCancelEdit?: () => void;
  /** L'utilisateur tape un message (règle « conversation ancienne », voir src/suggestions.ts). */
  onTyping?: () => void;
}

export function ConversationInput({ enabled, onSend, onStop, autoFocus, cwd = null, sessionId = null, editing = null, onCancelEdit, onTyping }: InputProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const slash = useSlashMenu({ text, setText, cwd, sessionId, inputRef: ref });
  /** Brouillon en cours quand la modification a commencé. */
  const draft = useRef<{ text: string; attachments: Attachment[] } | null>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // Début de modification : le texte et les pièces jointes du message remplacent le brouillon
  // (gardé de côté), curseur à la fin. Fin sans envoi : le brouillon revient.
  const editingKey = editing ? messageKey(editing) : null;
  useEffect(() => {
    if (!editing) {
      if (draft.current !== null) {
        setText(draft.current.text);
        setAttachments(draft.current.attachments);
      }
      draft.current = null;
      return;
    }
    if (draft.current === null) draft.current = { text, attachments };
    const parts = splitAttachments(editing.text);
    setText(parts.text);
    setAttachments(toAttachments(parts.paths));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingKey]);

  // Hauteur ajustée au texte (jusqu'à une limite, puis défilement).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const addPaths = (paths: string[]) =>
    setAttachments((a) => [
      ...a,
      ...toAttachments(paths.filter((p) => !a.some((x) => x.path === p))),
    ]);

  // Fichiers glissés depuis l'explorateur : le webview donne leurs chemins ; pris en compte
  // quand le curseur est au-dessus de cette zone de saisie (visible).
  const addPathsRef = useRef(addPaths);
  addPathsRef.current = addPaths;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type !== "drop" || !enabledRef.current) return;
        const rect = wrapRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        const x = e.payload.position.x / window.devicePixelRatio;
        const y = e.payload.position.y / window.devicePixelRatio;
        if (x >= rect.left && x <= rect.right && y >= rect.top - 40 && y <= rect.bottom) addPathsRef.current(e.payload.paths);
      })
      .then((fn) => (cancelled ? fn() : (off = fn)))
      .catch(() => {});
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const pickFiles = async () => {
    try {
      const r = await openFileDialog({ multiple: true, title: t("conversation.input.pickFilesDialog") });
      if (r) addPaths(Array.isArray(r) ? r : [r]);
    } catch {
      /* dialogue annulé ou indisponible */
    }
    ref.current?.focus();
  };

  // Ctrl+V : une image du presse-papiers (capture d'écran) devient une pièce jointe ; le texte
  // collé garde son comportement habituel.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.items]
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (!files.length) return;
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    Promise.all(files.map(savePastedImage))
      .then((added) => setAttachments((a) => [...a, ...added]))
      .catch(() => {});
  };

  const canSend = !!(text.trim() || attachments.length);

  const send = async () => {
    const trimmed = text.trim();
    if (!canSend || !enabled || sending) return;
    setSending(true);
    try {
      await onSend(composeMessage(trimmed, attachments.map((a) => a.path)));
      draft.current = null;
      setText("");
      setAttachments([]);
    } catch {
      /* terminal fermé entre-temps : le texte reste dans la zone */
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Menu des commandes `/…` ouvert : il prend ↑ ↓ Tab Entrée Échap.
    if (slash.onKeyDown(e)) return;
    if (e.key === "Escape" && editing) {
      e.preventDefault();
      onCancelEdit?.();
      return;
    }
    // Entrée envoie, Maj+Entrée va à la ligne.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <>
    {editing && (
      <div className="conv-edit-banner">
        <Pencil size={13} />
        <span className="conv-edit-title">{t("conversation.input.editBanner")}</span>
        {editing.actions > 0 && (
          <span className="conv-edit-warn">
            <TriangleAlert size={12} />
            {t("conversation.input.editWarning", { actions: editing.actions, fileChanges: editing.fileChanges })}
          </span>
        )}
        <button className="btn small ghost" onClick={onCancelEdit} title={t("conversation.input.cancelEditTitle")}>
          <X size={12} />
        </button>
      </div>
    )}
    <div className="conv-input" ref={wrapRef}>
      {enabled && slash.menu}
      {attachments.length > 0 && (
        <div className="conv-attachments">
          {attachments.map((a) => (
            <span key={a.id} className="conv-attachment" title={a.path}>
              <span className="conv-attachment-open" onClick={() => setViewing(a.path)} title={t("conversation.attachment.title", { path: a.path })}>
                {a.preview ? <img src={a.preview} alt="" /> : <FileIcon size={14} />}
                <span className="conv-attachment-name">{a.name}</span>
              </span>
              <button type="button" onClick={() => setAttachments((l) => l.filter((x) => x.id !== a.id))} title={t("conversation.input.removeAttachment")}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {viewing && <AttachmentViewer path={viewing} sessionId={sessionId} cwd={cwd} onClose={() => { setViewing(null); ref.current?.focus(); }} />}
      <button className="btn small" onClick={pickFiles} disabled={!enabled} title={t("conversation.input.attachTitle")}>
        <Paperclip size={13} />
      </button>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={enabled ? t("conversation.input.placeholder") : t("conversation.input.placeholderDisabled")}
        disabled={!enabled}
        onChange={(e) => {
          setText(e.target.value);
          slash.onSelect(e);
          onTyping?.();
        }}
        onKeyDown={onKeyDown}
        onSelect={slash.onSelect}
        onPaste={onPaste}
      />
      <button className="btn small" onClick={onStop} disabled={!enabled} title={t("conversation.input.stopTitle")}>
        <Square size={12} /> {t("conversation.input.stop")}
      </button>
      <button className="btn small primary" onClick={send} disabled={!enabled || !canSend || sending} title={t("conversation.input.sendTitle")}>
        <SendHorizontal size={13} /> {editing ? t("conversation.input.resend") : t("conversation.input.send")}
      </button>
    </div>
    </>
  );
}
