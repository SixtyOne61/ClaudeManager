// Onglets des conversations ouvertes dans le terminal intégré.
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
  /** Onglet affiché, ou null quand c'est la vue du projet qui est affichée. */
  active: string | null;
  onSelect: (sessionId: string | null) => void;
  onClose: (t: OpenTerminal) => void;
}

export function TerminalTabBar({ terminals, active, onSelect, onClose }: BarProps) {
  // État de chaque conversation ouverte : pastille dans son onglet.
  const activities = useActivities();
  if (terminals.length === 0) return null;
  return (
    <div className="terminal-tabs" role="tablist">
      <button className={"terminal-tab home" + (active === null ? " active" : "")} onClick={() => onSelect(null)} title="Revenir au projet">
        <FolderKanban size={14} /> Projets
      </button>
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
        />
      ))}
    </div>
  );
}
