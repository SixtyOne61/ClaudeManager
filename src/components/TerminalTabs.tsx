// Onglets des conversations ouvertes dans le terminal intégré.
// La barre d'onglets et les terminaux sont séparés : la barre s'affiche au-dessus de la
// vue courante, les terminaux restent tous montés (seul l'onglet actif est visible).

import { FolderKanban, SquareTerminal, X } from "lucide-react";
import { TerminalView } from "./TerminalView";

/** Une conversation ouverte dans le terminal intégré. */
export interface OpenTerminal {
  sessionId: string;
  cwd: string;
  title: string;
}

interface BarProps {
  terminals: OpenTerminal[];
  /** Onglet affiché, ou null quand c'est la vue du projet qui est affichée. */
  active: string | null;
  onSelect: (sessionId: string | null) => void;
  onClose: (t: OpenTerminal) => void;
}

export function TerminalTabBar({ terminals, active, onSelect, onClose }: BarProps) {
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
}

export function TerminalStack({ terminals, active, onClose }: StackProps) {
  return (
    <div className="terminal-stack" style={{ display: active ? undefined : "none" }}>
      {terminals.map((t) => (
        <TerminalView key={t.sessionId} sessionId={t.sessionId} cwd={t.cwd} active={active === t.sessionId} onClose={() => onClose(t)} />
      ))}
    </div>
  );
}
