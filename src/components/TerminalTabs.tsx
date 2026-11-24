// Onglets des conversations ouvertes dans le terminal intégré, et des hubs ouverts (« Vue
// Hub », onglet `hub:<id>`, voir HubView.tsx).
// La barre d'onglets et les terminaux sont séparés : la barre s'affiche au-dessus de la
// vue courante, les terminaux restent tous montés (seul l'onglet actif est visible).

import { FolderKanban, SquareTerminal, X } from "lucide-react";
import { TerminalView } from "./TerminalView";
import { ActivityDot } from "./Activity";
import { useActivities } from "../activity";
import type { SearchFocus } from "./GlobalSearch";
import type { SuggestionActionHandler } from "./Suggestions";
import type { Suggestion } from "../suggestions";
import type { HandoffLineage } from "../handoff";
import type { Hub } from "../api";

/** Préfixe de l'onglet d'un hub (`hub:<id>`) ; un identifiant de conversation n'en a jamais. */
export const HUB_TAB_PREFIX = "hub:";

/** Identifiant du hub d'un onglet, ou null pour un onglet de conversation (ou aucun). */
export function hubTabId(tab: string | null): string | null {
  return tab?.startsWith(HUB_TAB_PREFIX) ? tab.slice(HUB_TAB_PREFIX.length) : null;
}

/** Une conversation ouverte dans le terminal intégré. */
export interface OpenTerminal {
  sessionId: string;
  cwd: string;
  title: string;
  /** Nouvelle conversation créée par l'app : lancée avec `--session-id`. */
  isNew?: boolean;
}

interface BarProps {
  terminals: OpenTerminal[];
  /** Hubs ouverts (Vue Hub). */
  hubs?: Hub[];
  /** Onglet affiché (identifiant de conversation, ou `hub:<id>`), ou null quand c'est la vue du projet qui est affichée. */
  active: string | null;
  onSelect: (tab: string | null) => void;
  onClose: (t: OpenTerminal) => void;
  onCloseHub?: (hubId: string) => void;
}

export function TerminalTabBar({ terminals, hubs = [], active, onSelect, onClose, onCloseHub }: BarProps) {
  // État de chaque conversation ouverte : pastille dans son onglet.
  const activities = useActivities();
  if (terminals.length === 0 && hubs.length === 0) return null;
  return (
    <div className="terminal-tabs" role="tablist">
      <button className={"terminal-tab home" + (active === null ? " active" : "")} onClick={() => onSelect(null)} title="Revenir au projet">
        <FolderKanban size={14} /> Projets
      </button>
      {hubs.map((h) => {
        const tab = HUB_TAB_PREFIX + h.id;
        return (
          <div
            key={tab}
            role="tab"
            aria-selected={active === tab}
            className={"terminal-tab hub-tab" + (active === tab ? " active" : "")}
            onClick={() => onSelect(tab)}
            onAuxClick={(e) => e.button === 1 && onCloseHub?.(h.id)}
            title={`Hub « ${h.name} »`}
          >
            <span className="hub-link-icon" aria-hidden>
              🔗
            </span>
            <span className="terminal-tab-title">{h.name}</span>
            <button
              className="icon-btn bare"
              title="Fermer"
              onClick={(e) => {
                e.stopPropagation();
                onCloseHub?.(h.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      {terminals.map((t) => (
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
            title="Fermer"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t);
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
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
}

export function TerminalStack({ terminals, active, onClose, onStarted, focus, onDismissSuggestion, suggestionActions, onHandoff, lineageOf, onOpenConversation }: StackProps) {
  return (
    <div className="terminal-stack" style={{ display: active && !hubTabId(active) ? undefined : "none" }}>
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
        />
      ))}
    </div>
  );
}
