// Onglets des conversations ouvertes dans le terminal intégré. Le premier onglet ramène à la
// vue principale (projet ou hub sélectionné dans la barre latérale).
// La barre d'onglets et les terminaux sont séparés : la barre s'affiche au-dessus de la
// vue courante, les terminaux restent tous montés (seul l'onglet actif est visible).
// Quand chaque onglet a un groupe (réglage « Regrouper les onglets », calculé dans App.tsx),
// les onglets sont rangés sous le nom de leur hub ou de leur projet.

import { FolderKanban, Network, SquareTerminal, X } from "lucide-react";
import { TerminalView } from "./TerminalView";
import { ActivityDot } from "./Activity";
import { useActivities } from "../activity";
import type { SearchFocus } from "./GlobalSearch";
import type { SuggestionActionHandler } from "./Suggestions";
import type { Suggestion } from "../suggestions";
import type { HandoffLineage } from "../handoff";
import { t as tr } from "../i18n";

/** Une conversation ouverte dans le terminal intégré. */
export interface OpenTerminal {
  sessionId: string;
  cwd: string;
  title: string;
  /** Nouvelle conversation créée par l'app : lancée avec `--session-id`. */
  isNew?: boolean;
}

/** Groupe d'un onglet : le hub de la conversation, sinon son projet. */
export interface TabGroup {
  /** Clé stable (`hub:<id>` ou `project:<clé>`). */
  key: string;
  kind: "hub" | "project";
  name: string;
  color: string | null;
}

/** Onglet de la barre, avec son groupe quand les onglets sont regroupés (voir les réglages). */
export type TabInfo = OpenTerminal & { group?: TabGroup };

/** Onglets rangés par groupe, les groupes dans l'ordre d'ouverture de leur premier onglet. */
function groupTabs(tabs: TabInfo[]): { group: TabGroup; tabs: TabInfo[] }[] {
  const groups = new Map<string, { group: TabGroup; tabs: TabInfo[] }>();
  for (const t of tabs) {
    if (!t.group) continue;
    const g = groups.get(t.group.key);
    if (g) g.tabs.push(t);
    else groups.set(t.group.key, { group: t.group, tabs: [t] });
  }
  return [...groups.values()];
}

interface BarProps {
  terminals: TabInfo[];
  /** Vue principale vers laquelle ramène le premier onglet. */
  home?: "project" | "hub";
  /** Conversation affichée, ou null quand c'est la vue principale (projet, hub…) qui est affichée. */
  active: string | null;
  onSelect: (tab: string | null) => void;
  onClose: (t: OpenTerminal) => void;
}

export function TerminalTabBar({ terminals, home = "project", active, onSelect, onClose }: BarProps) {
  // État de chaque conversation ouverte : pastille dans son onglet.
  const activities = useActivities();
  if (terminals.length === 0) return null;
  const renderTab = (t: TabInfo) => (
    <div
      key={t.sessionId}
      role="tab"
      aria-selected={active === t.sessionId}
      className={"terminal-tab" + (active === t.sessionId ? " active" : "")}
      onClick={() => onSelect(t.sessionId)}
      onAuxClick={(e) => e.button === 1 && onClose(t)}
      title={`${t.title}\n${t.cwd}`}
    >
      <SquareTerminal size={14} />
      <ActivityDot activity={activities.get(t.sessionId)} compact />
      <span className="terminal-tab-title">{t.title}</span>
      <button
        className="icon-btn bare"
        title={tr("common.close")}
        onClick={(e) => {
          e.stopPropagation();
          onClose(t);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
  const grouped = terminals.every((t) => t.group) ? groupTabs(terminals) : null;
  return (
    <div className="terminal-tabs" role="tablist">
      <button
        className={"terminal-tab home" + (active === null ? " active" : "")}
        onClick={() => onSelect(null)}
        title={home === "hub" ? tr("conversation.tabs.backToHub") : tr("conversation.tabs.backToProject")}
      >
        {home === "hub" ? <Network size={14} /> : <FolderKanban size={14} />} {home === "hub" ? tr("conversation.tabs.hub") : tr("conversation.tabs.projects")}
      </button>
      {grouped
        ? grouped.map(({ group, tabs }) => (
            <div
              key={group.key}
              className="terminal-tab-group"
              role="group"
              aria-label={tr(group.kind === "hub" ? "conversation.tabs.groupHub" : "conversation.tabs.groupProject", { name: group.name })}
              style={group.color ? ({ "--group-color": group.color } as React.CSSProperties) : undefined}
            >
              <span
                className="terminal-tab-group-label"
                title={tr(group.kind === "hub" ? "conversation.tabs.groupHub" : "conversation.tabs.groupProject", { name: group.name })}
              >
                {group.kind === "hub" ? <Network size={12} /> : <FolderKanban size={12} />}
                <span className="terminal-tab-group-name">{group.name}</span>
              </span>
              {tabs.map(renderTab)}
            </div>
          ))
        : terminals.map(renderTab)}
    </div>
  );
}

interface StackProps {
  terminals: OpenTerminal[];
  active: string | null;
  onClose: (t: OpenTerminal) => void;
  /** `claude` a démarré dans le terminal de cette conversation. */
  onStarted?: (t: OpenTerminal) => void;
  /** Résultat de la recherche globale à montrer dans la conversation ouverte concernée. */
  focus?: SearchFocus | null;
  /** « Ignorer » sur une suggestion (bandeau de l'onglet). */
  onDismissSuggestion?: (s: Suggestion) => void;
  /** Gestionnaires des actions des suggestions (voir SuggestionBanners). */
  suggestionActions?: Partial<Record<string, SuggestionActionHandler>>;
  /** Hand off d'une conversation (bouton de la barre d'outils et du bandeau de suggestion). */
  onHandoff?: (sessionId: string) => void;
  /** Parente et suite d'une conversation (liens de hand off). */
  lineageOf?: (sessionId: string) => HandoffLineage;
  /** Ouvre une conversation par son identifiant (onglet, ou archives). */
  onOpenConversation?: (sessionId: string) => void;
  /** Frappe dans une conversation (règle « conversation ancienne »). */
  onTyping?: (sessionId: string) => void;
}

export function TerminalStack({ terminals, active, onClose, onStarted, focus, onDismissSuggestion, suggestionActions, onHandoff, lineageOf, onOpenConversation, onTyping }: StackProps) {
  return (
    <div className="terminal-stack" style={{ display: active ? undefined : "none" }}>
      {terminals.map((t) => (
        <TerminalView
          key={t.sessionId}
          sessionId={t.sessionId}
          cwd={t.cwd}
          isNew={t.isNew}
          active={active === t.sessionId}
          onClose={() => onClose(t)}
          onStarted={() => onStarted?.(t)}
          focus={focus?.sessionId === t.sessionId ? focus : null}
          onDismissSuggestion={onDismissSuggestion}
          suggestionActions={suggestionActions}
          onHandoff={onHandoff && (() => onHandoff(t.sessionId))}
          lineage={lineageOf?.(t.sessionId)}
          onOpenConversation={onOpenConversation}
          onTyping={onTyping && (() => onTyping(t.sessionId))}
        />
      ))}
    </div>
  );
}
