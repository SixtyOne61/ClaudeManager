// Actions de l'agent dans la conversation, intégrées comme dans Claude Desktop : les actions
// consécutives entre deux textes forment une seule ligne compacte (dernière action, ou
// « N actions · dernière : … »), qui se déplie en une liste d'actions d'une ligne chacune ;
// une action dépliée montre ses détails (paramètres, sortie, différence de code).
// Les erreurs restent visibles sur la ligne repliée.

import { memo, useMemo, useState } from "react";
import {
  AlertCircle,
  Bot,
  ChevronDown,
  ChevronRight,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  ListTodo,
  Loader2,
  Plug,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { Action, DiffLine } from "../conversation";
import { t } from "../i18n";

/** Lignes affichées d'un résultat ou d'une différence replié. */
const FOLD_LINES = 12;
/** Au-delà de ces caractères, un résultat est aussi replié (lignes très longues). */
const FOLD_CHARS = 1500;

interface ToolDisplay {
  /** Type d'action (« Commande », « Lecture »…) ou nom lisible de l'outil MCP. */
  label: string;
  Icon: LucideIcon;
  /** Résumé court sur la ligne de l'action (nom de fichier, commande…), vide si aucun. */
  summary: string;
  /** Paramètres complets, montrés seulement dans les détails (JSON d'un outil MCP…). */
  input: string | null;
}

/** Nom de fichier seul, d'un chemin Windows ou Unix. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Outil MCP (`mcp__serveur__outil`) : « serveur · outil ». */
function mcpName(name: string): string | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const sep = rest.indexOf("__");
  return sep < 0 ? rest : `${rest.slice(0, sep)} · ${rest.slice(sep + 2)}`;
}

/** Libellé, icône et résumé d'une action, d'après le nom de l'outil. */
function toolDisplay(name: string, title: string): ToolDisplay {
  const file = (label: string, Icon: LucideIcon): ToolDisplay => ({ label, Icon, summary: title ? baseName(title) : "", input: title || null });
  const plain = (label: string, Icon: LucideIcon): ToolDisplay => ({ label, Icon, summary: title, input: title || null });
  switch (name) {
    case "Bash":
    case "PowerShell":
      return plain(t("conversation.actions.command"), SquareTerminal);
    case "Read":
    case "NotebookRead":
      return file(t("conversation.actions.read"), FileText);
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return file(t("conversation.actions.edit"), FilePen);
    case "Write":
      return file(t("conversation.actions.write"), FilePlus);
    case "Grep":
    case "Glob":
      return plain(t("conversation.actions.search"), Search);
    case "WebFetch":
    case "WebSearch":
      return plain(t("conversation.actions.web"), Globe);
    case "Task":
    case "Agent":
      return plain(t("conversation.actions.subagent"), Bot);
    case "Skill":
      return plain(t("conversation.actions.skill"), Sparkles);
    case "TodoWrite":
      return plain(t("conversation.actions.todos"), ListTodo);
  }
  // Outils MCP et inconnus : le titre est le JSON des paramètres, gardé pour les détails.
  const mcp = mcpName(name);
  return { label: mcp ?? name, Icon: mcp ? Plug : Wrench, summary: "", input: title ? prettyJson(title) : null };
}

/** JSON indenté s'il est lisible (il peut avoir été raccourci côté Rust), sinon tel quel. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Une action en une ligne : « Commande npm test ». */
function ActionLine({ action, display }: { action: Action; display: ToolDisplay }) {
  const { label, Icon, summary } = display;
  const pending = !action.result;
  const error = action.result?.isError ?? false;
  return (
    <>
      {pending ? <Loader2 size={13} className="spin action-icon" /> : error ? <AlertCircle size={13} className="action-icon error" /> : <Icon size={13} className="action-icon" />}
      <span className="action-label">{label}</span>
      {summary && (
        <span className="action-summary" title={action.tool.title}>
          {summary}
        </span>
      )}
    </>
  );
}

/** Actions consécutives de l'agent, repliées en une seule ligne. */
export const ActionGroup = memo(function ActionGroup({ actions }: { actions: Action[] }) {
  const [open, setOpen] = useState(false);
  const displays = useMemo(() => actions.map((a) => toolDisplay(a.tool.name, a.tool.title)), [actions]);
  const last = actions[actions.length - 1];
  const errors = actions.filter((a) => a.result?.isError).length;
  const first = actions[0].tool;
  return (
    <div className={"action-group" + (open ? " open" : "")} data-line={first.line} data-uuid={first.uuid ?? undefined}>
      <button className="action-row action-head" onClick={() => setOpen(!open)} title={open ? t("conversation.actions.collapseGroup") : t("conversation.actions.expandGroup")}>
        {open ? <ChevronDown size={13} className="action-chevron" /> : <ChevronRight size={13} className="action-chevron" />}
        {actions.length > 1 && <span className="action-count">{t("conversation.actions.countLast", { count: actions.length })}</span>}
        <ActionLine action={last} display={displays[displays.length - 1]} />
        {errors > 0 && (
          <span className="action-errors" title={t("conversation.actions.failedTitle")}>
            <AlertCircle size={12} /> {t("conversation.actions.errors", { count: errors })}
          </span>
        )}
      </button>
      {open && (
        <div className="action-list">
          {actions.map((a, i) => (
            <ActionItem key={a.tool.id || i} action={a} display={displays[i]} />
          ))}
        </div>
      )}
    </div>
  );
});

/** Une action de la liste dépliée ; un clic montre ses détails. */
const ActionItem = memo(function ActionItem({ action, display }: { action: Action; display: ToolDisplay }) {
  const [open, setOpen] = useState(false);
  const { tool, result } = action;
  return (
    <div className={"action-item" + (result?.isError ? " error" : "")} data-line={tool.line} data-uuid={tool.uuid ?? undefined}>
      <button className="action-row" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} className="action-chevron" /> : <ChevronRight size={12} className="action-chevron" />}
        <ActionLine action={action} display={display} />
      </button>
      {open && <ActionDetails action={action} display={display} />}
    </div>
  );
});

function ActionDetails({ action, display }: { action: Action; display: ToolDisplay }) {
  const { tool, result } = action;
  // Lecture de fichier : contenu replié entièrement ; modification réussie : message de l'outil masqué.
  const isRead = tool.name === "Read";
  const hideResult = tool.diff != null && result != null && !result.isError;
  return (
    <div className="action-details">
      {tool.detail && <div className="action-detail">{toolDetail(tool.name, tool.detail)}</div>}
      {display.input && <pre className="action-input">{display.input}</pre>}
      {tool.diff && <DiffView lines={tool.diff} truncated={tool.diffTruncated} />}
      {result && !hideResult && <FoldedText text={result.text} truncated={result.truncated} startFolded={isRead} error={result.isError} />}
      {!result && <div className="action-detail">{t("conversation.actions.running")}</div>}
    </div>
  );
}

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
          {open
            ? t("common.collapse")
            : truncated
              ? t("conversation.actions.showAllTruncated", { count: lines.length })
              : t("conversation.actions.showAll", { count: lines.length })}
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
        <ChevronRight size={13} /> {t("conversation.actions.showContent", { count: lines.length })}
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
              <ChevronDown size={13} /> {t("common.collapse")}
            </>
          ) : (
            <>
              <ChevronRight size={13} /> {t("conversation.actions.showAll", { count: lines.length })}
            </>
          )}
        </button>
      )}
      {open && truncated && <div className="tool-truncated">{t("conversation.actions.resultTruncated")}</div>}
    </div>
  );
}

/** Détail d'un outil ; celui de TodoWrite (« N tâche(s) », écrit par le backend) dans la langue de l'interface. */
function toolDetail(name: string, detail: string): string {
  const n = name === "TodoWrite" ? parseInt(detail, 10) : NaN;
  return Number.isFinite(n) ? t("conversation.actions.todoCount", { count: n }) : detail;
}
