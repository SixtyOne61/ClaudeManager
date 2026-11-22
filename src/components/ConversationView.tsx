// Interface de conversation dessinée par l'app par-dessus le terminal intégré (ticket 05) :
// messages de l'utilisateur (bulles à droite), réponses de Claude (texte Markdown à gauche,
// sous une étiquette « Claude ») et ses actions, regroupées en lignes compactes
// (`ConversationActions`). La zone de saisie est `ConversationInput`.
// Les liens `http(s)` des réponses s'ouvrent dans le navigateur ; les blocs de commande
// (`bash`, `powershell`, `cmd`…) ont un bouton ▶ pour les exécuter (`CodeRunner`).

import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SendHorizontal, Sparkle, Square } from "lucide-react";
import { groupEntries, type ClaudeItem, type ConversationData, type ConversationEntry } from "../conversation";
import { renderMarkdown } from "../markdown";
import { ActionGroup } from "./ConversationActions";
import type { SearchFocus } from "./GlobalSearch";
import { useSlashMenu } from "./SlashMenu";
import { CodeRunnerPortal, type RunnableBlock } from "./CodeRunner";
import { isRunnableLang } from "../runner";

/** Dossier de la conversation : les commandes des blocs ▶ s'y exécutent. */
const CwdContext = createContext<string | null>(null);

interface Props {
  data: ConversationData;
  /** Résultat de recherche à faire défiler jusqu'à lui (ligne / uuid du message). */
  focus?: SearchFocus | null;
  /** Masquée (terminal affiché) : gardée montée pour conserver sa position de défilement. */
  hidden: boolean;
  /** Dossier de la conversation (commandes exécutées depuis les blocs de code). */
  cwd?: string | null;
}

export function ConversationView({ data, focus, hidden, cwd = null }: Props) {
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
      <div className="conversation-inner">
        {data.headSkipped && <div className="conv-notice">Début de la conversation non affiché (fichier volumineux) : il reste visible dans le terminal.</div>}
        {data.exists === false && <div className="conv-empty">Nouvelle conversation : écris ton premier message ci-dessous.</div>}
        {data.exists && data.entries.length === 0 && <div className="conv-empty">Aucun message pour l'instant.</div>}
        {blocks.map((b) => {
          switch (b.kind) {
            case "user":
              return <UserBubble key={b.key} entry={b.entry} />;
            case "notice":
              return (
                <div key={b.key} className="conv-notice" data-line={b.entry.line} data-uuid={b.entry.uuid ?? undefined}>
                  {b.entry.text}
                </div>
              );
            case "claude":
              return <ClaudeTurn key={b.key} items={b.items} />;
          }
        })}
      </div>
      </CwdContext.Provider>
    </div>
  );
}

function UserBubble({ entry }: { entry: Extract<ConversationEntry, { kind: "user" }> }) {
  return (
    <div className="conv-user" data-line={entry.line} data-uuid={entry.uuid ?? undefined}>
      <div className={"conv-bubble" + (entry.command ? " command" : "")}>{entry.text}</div>
    </div>
  );
}

const AssistantText = memo(function AssistantText({ line, uuid, text }: { line: number; uuid: string | null; text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
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
        ) : (
          <ActionGroup key={it.key} actions={it.actions} />
        ),
      )}
    </div>
  );
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
}

export function ConversationInput({ enabled, onSend, onStop, autoFocus, cwd = null, sessionId = null }: InputProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const slash = useSlashMenu({ text, setText, cwd, sessionId });

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // Hauteur ajustée au texte (jusqu'à une limite, puis défilement).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const send = async () => {
    const t = text.trim();
    if (!t || !enabled || sending) return;
    setSending(true);
    try {
      await onSend(t);
      setText("");
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
    // Entrée envoie, Maj+Entrée va à la ligne.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="conv-input">
      {enabled && slash.menu}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={enabled ? "Message à Claude… (Entrée : envoyer, Maj+Entrée : nouvelle ligne)" : "Claude Code ne tourne pas dans ce terminal."}
        disabled={!enabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button className="btn small" onClick={onStop} disabled={!enabled} title="Interrompre l'agent (Échap)">
        <Square size={12} /> Arrêter
      </button>
      <button className="btn small primary" onClick={send} disabled={!enabled || !text.trim() || sending} title="Envoyer (Entrée)">
        <SendHorizontal size={13} /> Envoyer
      </button>
    </div>
  );
}
