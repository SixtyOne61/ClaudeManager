// Interface de conversation dessinée par l'app par-dessus le terminal intégré (ticket 05) :
// messages de l'utilisateur, réponses de l'agent (Markdown) et une carte par action de
// l'agent (commande et sa sortie, fichier lu, fichier modifié avec la différence de code).
// Les résultats d'outils trop longs sont repliés. La zone de saisie est `ConversationInput`.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Bot, ChevronDown, ChevronRight, FilePen, FilePlus, FileText, Globe, ListTodo, Search, SendHorizontal, Square, SquareTerminal, Wrench } from "lucide-react";
import type { ConversationData, ConversationEntry, DiffLine } from "../conversation";
import { renderMarkdown } from "../markdown";
import type { SearchFocus } from "./GlobalSearch";
import { useSlashMenu } from "./SlashMenu";

type ToolEntry = Extract<ConversationEntry, { kind: "tool" }>;
type ResultEntry = Extract<ConversationEntry, { kind: "toolResult" }>;

/** Lignes affichées d'un résultat ou d'une différence replié. */
const FOLD_LINES = 12;
/** Au-delà de ces caractères, un résultat est aussi replié (lignes très longues). */
const FOLD_CHARS = 1500;

interface Props {
  data: ConversationData;
  /** Résultat de recherche à faire défiler jusqu'à lui (ligne / uuid du message). */
  focus?: SearchFocus | null;
  /** Masquée (terminal affiché) : gardée montée pour conserver sa position de défilement. */
  hidden: boolean;
}

export function ConversationView({ data, focus, hidden }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Résultats rattachés à leur appel d'outil.
  const results = useMemo(() => {
    const m = new Map<string, ResultEntry>();
    for (const e of data.entries) if (e.kind === "toolResult") m.set(e.toolUseId, e);
    return m;
  }, [data.entries]);

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

  // Les liens de l'agent ne sont pas suivis (la fenêtre de l'app ne navigue jamais).
  const onClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a")) e.preventDefault();
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
      <div className="conversation-inner">
        {data.headSkipped && <div className="conv-notice">Début de la conversation non affiché (fichier volumineux) : il reste visible dans le terminal.</div>}
        {data.exists === false && <div className="conv-empty">Nouvelle conversation : écris ton premier message ci-dessous.</div>}
        {data.exists && data.entries.length === 0 && <div className="conv-empty">Aucun message pour l'instant.</div>}
        {data.entries.map((e, i) => {
          const key = `${e.line}:${i}`;
          switch (e.kind) {
            case "user":
              return <UserBubble key={key} entry={e} />;
            case "assistant":
              return <AssistantText key={key} line={e.line} uuid={e.uuid} text={e.text} />;
            case "tool":
              return <ToolCard key={key} entry={e} result={results.get(e.id)} />;
            case "notice":
              return (
                <div key={key} className="conv-notice" data-line={e.line} data-uuid={e.uuid ?? undefined}>
                  {e.text}
                </div>
              );
            default:
              return null; // résultats : affichés dans la carte de leur appel
          }
        })}
      </div>
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
  return <div className="conv-assistant markdown" data-line={line} data-uuid={uuid ?? undefined} dangerouslySetInnerHTML={{ __html: html }} />;
});

/** Libellé et icône d'une action, d'après le nom de l'outil. */
function toolLabel(name: string) {
  switch (name) {
    case "Bash":
    case "PowerShell":
      return { label: "Commande", Icon: SquareTerminal };
    case "Read":
    case "NotebookRead":
      return { label: "Lecture", Icon: FileText };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { label: "Modification", Icon: FilePen };
    case "Write":
      return { label: "Écriture", Icon: FilePlus };
    case "Grep":
    case "Glob":
      return { label: "Recherche", Icon: Search };
    case "WebFetch":
    case "WebSearch":
      return { label: "Web", Icon: Globe };
    case "Task":
    case "Agent":
      return { label: "Sous-agent", Icon: Bot };
    case "TodoWrite":
      return { label: "Tâches", Icon: ListTodo };
    default:
      return { label: name, Icon: Wrench };
  }
}

const ToolCard = memo(function ToolCard({ entry, result }: { entry: ToolEntry; result: ResultEntry | undefined }) {
  const { label, Icon } = toolLabel(entry.name);
  // Lecture de fichier : contenu replié entièrement ; modification réussie : message de l'outil masqué.
  const isRead = entry.name === "Read";
  const hideResult = entry.diff != null && result != null && !result.isError;
  return (
    <div className={"tool-card" + (result?.isError ? " error" : "")} data-line={entry.line} data-uuid={entry.uuid ?? undefined}>
      <div className="tool-head">
        <Icon size={14} />
        <span className="tool-label">{label}</span>
        <span className="tool-title" title={entry.title}>
          {entry.title}
        </span>
        {!result && <span className="tool-pending">…</span>}
      </div>
      {entry.detail && <div className="tool-detail">{entry.detail}</div>}
      {entry.diff && <DiffView lines={entry.diff} truncated={entry.diffTruncated} />}
      {result && !hideResult && (
        <FoldedText text={result.text} truncated={result.truncated} startFolded={isRead} error={result.isError} />
      )}
    </div>
  );
});

function DiffView({ lines, truncated }: { lines: DiffLine[]; truncated: boolean }) {
  const [open, setOpen] = useState(false);
  const long = lines.length > FOLD_LINES * 2;
  const shown = long && !open ? lines.slice(0, FOLD_LINES * 2) : lines;
  return (
    <div className="tool-output diff">
      {shown.map((l, i) =>
        l.op === "~" ? (
          <div key={i} className="diff-sep" />
        ) : (
          <div key={i} className={"diff-line" + (l.op === "+" ? " add" : l.op === "-" ? " del" : "")}>
            <span className="diff-op">{l.op}</span>
            {l.text}
          </div>
        ),
      )}
      {long && (
        <button className="fold-btn" onClick={() => setOpen(!open)}>
          {open ? "Replier" : `Afficher tout (${lines.length} lignes${truncated ? ", tronqué" : ""})`}
        </button>
      )}
    </div>
  );
}

function FoldedText({ text, truncated, startFolded, error }: { text: string; truncated: boolean; startFolded: boolean; error: boolean }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const long = lines.length > FOLD_LINES || text.length > FOLD_CHARS;
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  if (startFolded && !open) {
    return (
      <button className="fold-btn standalone" onClick={() => setOpen(true)}>
        <ChevronRight size={13} /> Afficher le contenu ({lines.length} lignes)
      </button>
    );
  }
  const shown = long && !open ? lines.slice(0, FOLD_LINES).join("\n").slice(0, FOLD_CHARS) : text;
  return (
    <div className={"tool-output" + (error ? " error" : "")}>
      <pre>{shown}</pre>
      {(long || startFolded) && (
        <button className="fold-btn" onClick={() => setOpen(!open)}>
          {open ? (
            <>
              <ChevronDown size={13} /> Replier
            </>
          ) : (
            <>
              <ChevronRight size={13} /> Afficher tout ({lines.length} lignes)
            </>
          )}
        </button>
      )}
      {open && truncated && <div className="tool-truncated">Résultat tronqué : la suite est visible dans le terminal.</div>}
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
