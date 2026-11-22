// Vue « Archives » : conversations archivées, à restaurer ou mettre à la Corbeille.

import { ArchiveRestore, FolderArchive, Trash2 } from "lucide-react";
import type { ArchiveEntry, Config } from "../api";
import { colorStyle, formatDate } from "../util";
import { conversationColor } from "../sections";
import { useScrollToFocus, type SearchFocus } from "./GlobalSearch";

interface Props {
  config: Config;
  onRestore: (a: ArchiveEntry) => void;
  onTrash: (a: ArchiveEntry) => void;
  /** Restaure un projet archivé et les conversations archivées avec lui. */
  onRestoreProject: (key: string, name: string) => void;
  /** Archive ouverte depuis la recherche globale : mise en évidence. */
  focus?: SearchFocus | null;
}

const lastSegment = (path: string | null | undefined) => path?.split(/[\\/]/).filter(Boolean).pop();

export function ArchivesView({ config, onRestore, onTrash, onRestoreProject, focus }: Props) {
  useScrollToFocus(focus);
  const archives = [...config.archives].sort((a, b) => b.archivedAt - a.archivedAt);
  const projectLabel = (a: ArchiveEntry) =>
    config.projects[a.projectKey]?.displayName || lastSegment(a.projectPath) || a.projectKey;

  // Projets archivés, du plus récent au plus ancien, avec leurs conversations encore dans les archives.
  const archivedIds = new Set(config.archives.map((a) => a.sessionId));
  const projects = Object.entries(config.projects)
    .flatMap(([key, prefs]) => (prefs.archived ? [{ key, prefs, archived: prefs.archived }] : []))
    .sort((a, b) => b.archived.archivedAt - a.archived.archivedAt)
    .map((x) => ({
      ...x,
      name: x.prefs.displayName || lastSegment(x.prefs.path) || x.key,
      count: x.archived.sessionIds.filter((id) => archivedIds.has(id)).length,
    }));

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
        {projects.length > 0 && (
          <>
            <h3 className="archives-heading">Projets archivés</h3>
            {projects.map((p) => (
              <div key={p.key} className={"session-row" + (p.prefs.color ? " colored" : "")} style={colorStyle(p.prefs.color)}>
                <div className="session-main">
                  <div className="session-title">
                    <FolderArchive size={14} className="archives-project-icon" /> {p.name}
                  </div>
                  <div className="session-meta">
                    <span>archivé le {formatDate(new Date(p.archived.archivedAt).toISOString())}</span>
                    <span className="dot">·</span>
                    <span>{p.count > 0 ? `${p.count} conversation${p.count > 1 ? "s" : ""}` : "aucune conversation"}</span>
                    {p.prefs.path && (
                      <>
                        <span className="dot">·</span>
                        <span>{p.prefs.path}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="session-actions">
                  <button
                    className="btn small primary"
                    onClick={() => onRestoreProject(p.key, p.name)}
                    title="Remet le projet dans la barre latérale, avec les conversations archivées avec lui"
                  >
                    <ArchiveRestore size={13} /> Restaurer le projet
                  </button>
                </div>
              </div>
            ))}
            <h3 className="archives-heading">Conversations archivées</h3>
          </>
        )}
        {archives.length === 0 && <div className="empty">Aucune conversation archivée.</div>}
        {archives.map((a) => (
          <div key={a.sessionId} data-session-id={a.sessionId} className={"session-row" + (conversationColor(config, a.sessionId) ? " colored" : "")} style={colorStyle(conversationColor(config, a.sessionId))}>
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
