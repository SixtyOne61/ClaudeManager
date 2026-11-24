// Vue « Archives » : projets et hubs archivés, conversations archivées, à restaurer ou mettre
// à la Corbeille.

import { ArchiveRestore, ArrowLeft, ArrowRight, FolderArchive, Trash2 } from "lucide-react";
import type { ArchiveEntry, Config, Hub } from "../api";
import { archivedHubs } from "../hubs";
import { colorStyle, formatDate } from "../util";
import { conversationColor } from "../sections";
import { useScrollToFocus, type SearchFocus } from "./GlobalSearch";
import type { HandoffLineage } from "../handoff";

interface Props {
  config: Config;
  onRestore: (a: ArchiveEntry) => void;
  onTrash: (a: ArchiveEntry) => void;
  /** Restaure un projet archivé et les conversations archivées avec lui. */
  onRestoreProject: (key: string, name: string) => void;
  /** Restaure un hub archivé et les conversations archivées avec lui. */
  onRestoreHub: (hub: Hub) => void;
  /** Archive ouverte depuis la recherche globale : mise en évidence. */
  focus?: SearchFocus | null;
  /** Parente et suite d'une conversation (liens de hand off). */
  lineageOf?: (sessionId: string) => HandoffLineage;
  /** Ouvre une conversation par son identifiant (onglet, ou archives). */
  onOpenConversation?: (sessionId: string) => void;
}

const lastSegment = (path: string | null | undefined) => path?.split(/[\\/]/).filter(Boolean).pop();

export function ArchivesView({ config, onRestore, onTrash, onRestoreProject, onRestoreHub, focus, lineageOf, onOpenConversation }: Props) {
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
  const hubs = archivedHubs(config);

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
          </>
        )}
        {hubs.length > 0 && (
          <>
            <h3 className="archives-heading">Hubs archivés</h3>
            {hubs.map((h) => {
              const count = h.archived!.sessionIds.filter((id) => archivedIds.has(id)).length;
              return (
                <div key={h.id} className={"session-row" + (h.color ? " colored" : "")} style={colorStyle(h.color)}>
                  <div className="session-main">
                    <div className="session-title">🔗 {h.name}</div>
                    <div className="session-meta">
                      <span>archivé le {formatDate(new Date(h.archived!.archivedAt).toISOString())}</span>
                      <span className="dot">·</span>
                      <span>{count > 0 ? `${count} conversation${count > 1 ? "s" : ""}` : "aucune conversation"}</span>
                    </div>
                  </div>
                  <div className="session-actions">
                    <button
                      className="btn small primary"
                      onClick={() => onRestoreHub(h)}
                      title="Remet le hub dans la barre latérale, avec les conversations archivées avec lui"
                    >
                      <ArchiveRestore size={13} /> Restaurer le hub
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
        {(projects.length > 0 || hubs.length > 0) && <h3 className="archives-heading">Conversations archivées</h3>}
        {archives.length === 0 && <div className="empty">Aucune conversation archivée.</div>}
        {archives.map((a) => {
          const lineage = lineageOf?.(a.sessionId);
          return (
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
                  {lineage?.parent && (
                    <>
                      <span className="dot">·</span>
                      <button className="link-btn" onClick={() => onOpenConversation?.(lineage.parent!.id)} title="Ouvrir la conversation d'origine de ce hand off">
                        <ArrowLeft size={11} /> Suite de <em>{lineage.parent.title}</em>
                      </button>
                    </>
                  )}
                  {lineage?.successor && (
                    <>
                      <span className="dot">·</span>
                      <button className="link-btn" onClick={() => onOpenConversation?.(lineage.successor!.id)} title="Ouvrir la conversation qui a pris le relais">
                        Suite : <em>{lineage.successor.title}</em> <ArrowRight size={11} />
                      </button>
                    </>
                  )}
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
          );
        })}
      </div>
    </main>
  );
}
