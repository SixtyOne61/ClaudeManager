// Vue « Archives » : conversations archivées, à restaurer ou mettre à la Corbeille.

import { ArchiveRestore, Trash2 } from "lucide-react";
import type { ArchiveEntry, Config } from "../api";
import { formatDate } from "../util";
import { useScrollToFocus, type SearchFocus } from "./GlobalSearch";

interface Props {
  config: Config;
  onRestore: (a: ArchiveEntry) => void;
  onTrash: (a: ArchiveEntry) => void;
  /** Archive ouverte depuis la recherche globale : mise en évidence. */
  focus?: SearchFocus | null;
}

export function ArchivesView({ config, onRestore, onTrash, focus }: Props) {
  useScrollToFocus(focus);
  const archives = [...config.archives].sort((a, b) => b.archivedAt - a.archivedAt);
  const projectLabel = (a: ArchiveEntry) =>
    config.projects[a.projectKey]?.displayName || a.projectPath?.split(/[\\/]/).filter(Boolean).pop() || a.projectKey;

  return (
    <main className="main">
      <header className="project-header">
        <div className="project-title">
          <h2>Archives</h2>
        </div>
        <p className="muted">
          Les conversations archivées sont rangées dans <code>%APPDATA%\claude-manager\archive</code> et n'apparaissent plus dans Claude Code.
        </p>
      </header>
      <div className="session-list">
        {archives.length === 0 && <div className="empty">Aucune conversation archivée.</div>}
        {archives.map((a) => (
          <div key={a.sessionId} data-session-id={a.sessionId} className="session-row">
            <div className="session-main">
              <div className="session-title">{a.title}</div>
              <div className="session-meta">
                <span className="tag">{projectLabel(a)}</span>
                <span>archivée le {formatDate(new Date(a.archivedAt).toISOString())}</span>
                <span className="dot">·</span>
                <span>dernière activité {formatDate(a.updatedAt)}</span>
                <span className="dot">·</span>
                <span>{a.messageCount} messages</span>
              </div>
            </div>
            <div className="session-actions">
              <button className="btn small primary" onClick={() => onRestore(a)}>
                <ArchiveRestore size={13} /> Restaurer
              </button>
              <button className="icon-btn danger" title="Mettre à la Corbeille" onClick={() => onTrash(a)}>
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
