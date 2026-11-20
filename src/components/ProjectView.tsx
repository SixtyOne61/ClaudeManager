// Vue d'un projet : en-tête (nom, couleur, catégorie, actions) et liste des conversations.

import { useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  Archive,
  FileSearch,
  FolderOpen,
  MessageSquarePlus,
  Pencil,
  Play,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { api, errorMessage, type Config, type ProjectInfo, type SessionInfo } from "../api";
import { colorStyle, formatDate, projectName, relativeDate } from "../util";
import { ColorPicker } from "./ColorPicker";

interface Props {
  project: ProjectInfo;
  config: Config;
  terminal: string;
  onLaunch: (sessionId?: string) => void;
  onOpenInDesktop: (s: SessionInfo) => void;
  onArchive: (s: SessionInfo) => void;
  onTrash: (s: SessionInfo) => void;
  onRename: () => void;
  onColor: (color: string | null) => void;
  onMove: (categoryId: string | null) => void;
  onForget: () => void;
  onError: (msg: string) => void;
}

export function ProjectView(props: Props) {
  const { project: p, config } = props;
  const [query, setQuery] = useState("");
  const [deep, setDeep] = useState(false);
  const [deepHits, setDeepHits] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);

  // Nouvelle recherche quand on change de projet.
  useEffect(() => {
    setQuery("");
    setDeepHits(null);
  }, [p.key]);

  // Recherche dans le contenu des conversations (côté Rust), avec un petit délai de frappe.
  useEffect(() => {
    if (!deep || query.trim().length < 2) {
      setDeepHits(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      api
        .searchSessions(p.key, query)
        .then((ids) => !cancelled && setDeepHits(new Set(ids)))
        .catch((e) => !cancelled && props.onError(errorMessage(e)))
        .finally(() => !cancelled && setSearching(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deep, query, p.key]);

  /** Filtre local instantané (titre, premier message, id) + résultats plein texte. */
  const sessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return p.sessions;
    return p.sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.firstPrompt ?? "").toLowerCase().includes(q) ||
        s.id.startsWith(q) ||
        deepHits?.has(s.id),
    );
  }, [p.sessions, query, deepHits]);

  const categoryId = config.categories.find((c) => c.projectKeys.includes(p.key))?.id ?? "";
  const color = config.projects[p.key]?.color;
  const canLaunch = p.exists && !!p.path;

  return (
    <main className="main">
      <header className="project-header" style={colorStyle(color)}>
        <div className="project-title">
          <h2>{projectName(p, config)}</h2>
          <button className="icon-btn" title="Renommer (nom d'affichage)" onClick={props.onRename}>
            <Pencil size={15} />
          </button>
        </div>
        <button
          className="project-path"
          title="Ouvrir dans l'Explorateur"
          disabled={!canLaunch}
          onClick={() => p.path && api.openFolder(p.path).catch((e) => props.onError(errorMessage(e)))}
        >
          <FolderOpen size={13} /> {p.path ?? "Chemin inconnu"}
        </button>
        <div className="project-actions">
          <button className="btn primary" disabled={!canLaunch} onClick={() => props.onLaunch()} title={`Ouvre ${props.terminal} et lance « claude »`}>
            <MessageSquarePlus size={15} /> Nouvelle conversation
          </button>
          <ColorPicker value={color} onChange={props.onColor} title="Couleur" />
          <select className="select" value={categoryId} onChange={(e) => props.onMove(e.target.value || null)} title="Catégorie">
            <option value="">Non classés</option>
            {config.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {p.sessions.length === 0 && (
            <button className="btn ghost" onClick={props.onForget} title="Retire ce projet de la liste (le dossier n'est pas touché)">
              <X size={14} /> Retirer de la liste
            </button>
          )}
        </div>
      </header>

      {!p.exists && (
        <div className="banner warn">
          <TriangleAlert size={15} /> Le dossier de ce projet est introuvable : impossible de lancer Claude depuis ici.
        </div>
      )}

      <div className="search-bar">
        <Search size={15} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher une conversation…" />
        {query && (
          <button className="icon-btn" onClick={() => setQuery("")} title="Effacer">
            <X size={14} />
          </button>
        )}
        <label className={"toggle" + (deep ? " on" : "")} title="Cherche aussi dans le texte de tous les messages">
          <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
          <FileSearch size={14} /> Dans le contenu {searching && "…"}
        </label>
      </div>

      <div className="session-list">
        {sessions.length === 0 && (
          <div className="empty">{p.sessions.length === 0 ? "Aucune conversation dans ce projet." : "Aucune conversation ne correspond à la recherche."}</div>
        )}
        {sessions.map((s) => (
          <div key={s.id} className="session-row" onDoubleClick={() => canLaunch && props.onLaunch(s.id)}>
            <div className="session-main">
              <div className="session-title" title={s.firstPrompt ?? s.title}>
                {s.title}
              </div>
              <div className="session-meta">
                <span title={`Créée le ${formatDate(s.createdAt)}`}>{formatDate(s.updatedAt)}</span>
                <span className="dot">·</span>
                <span>{relativeDate(s.updatedAt)}</span>
                <span className="dot">·</span>
                <span>
                  {s.messageCount} message{s.messageCount > 1 ? "s" : ""}
                </span>
                {s.skippedLines > 0 && (
                  <span className="warn" title="Lignes illisibles ignorées dans le fichier">
                    · {s.skippedLines} ligne(s) ignorée(s)
                  </span>
                )}
                <span className="session-id">{s.id.slice(0, 8)}</span>
              </div>
            </div>
            <div className="session-actions">
              <button className="btn small primary" disabled={!canLaunch} onClick={() => props.onLaunch(s.id)} title="claude --resume">
                <Play size={13} /> Reprendre
              </button>
              <button className="icon-btn" onClick={() => props.onOpenInDesktop(s)} title="Ouvrir dans Desktop (claude --desktop --resume)">
                <AppWindow size={15} />
              </button>
              <button className="icon-btn" title="Archiver" onClick={() => props.onArchive(s)}>
                <Archive size={15} />
              </button>
              <button className="icon-btn danger" title="Mettre à la Corbeille" onClick={() => props.onTrash(s)}>
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
