// Vue « Rechercher partout » : cherche un mot dans le contenu de toutes les conversations
// (archives comprises) et affiche les résultats groupés par projet, avec un extrait.

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { api, errorMessage, type Config, type ProjectInfo, type SearchHit, type SearchResult, type SessionHits } from "../api";
import { formatDate, projectName } from "../util";

/** Longueur minimale d'une recherche (comme côté Rust). */
const MIN_CHARS = 2;

/**
 * Conversation ouverte depuis la recherche globale, avec la position du message trouvé
 * (`line`, `uuid`) : l'interface de conversation (ticket 05) pourra y faire défiler.
 * Un nouvel objet à chaque ouverture, pour repositionner même sur la même conversation.
 */
export interface SearchFocus {
  projectKey: string;
  sessionId: string;
  archived: boolean;
  line: number | null;
  uuid: string | null;
}

/** Fait défiler jusqu'à la ligne `[data-session-id]` repérée et la met en évidence un instant. */
export function useScrollToFocus(focus: SearchFocus | null | undefined) {
  useEffect(() => {
    if (!focus) return;
    // Après le rendu de la liste (le filtre de recherche du projet vient d'être vidé).
    const t = setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(focus.sessionId)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("search-focused");
      setTimeout(() => el.classList.remove("search-focused"), 2500);
    }, 50);
    return () => clearTimeout(t);
  }, [focus]);
}

interface Props {
  config: Config;
  projects: Map<string, ProjectInfo>;
  query: string;
  onQueryChange: (q: string) => void;
  /** Ouvre la conversation, positionnée sur le message trouvé. */
  onOpen: (s: SessionHits, hit: SearchHit | undefined) => void;
  onClose: () => void;
  onError: (msg: string) => void;
}

export function GlobalSearch(props: Props) {
  const { config, projects, query } = props;
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(0);

  useEffect(() => input.current?.focus(), []);

  // Recherche côté Rust, avec un petit délai de frappe. Seule la dernière réponse compte.
  useEffect(() => {
    if (query.trim().length < MIN_CHARS) {
      setResult(null);
      setSearching(false);
      return;
    }
    const id = ++latest.current;
    setSearching(true);
    const t = setTimeout(() => {
      api
        .searchAll(query)
        .then((r) => {
          if (id === latest.current && !r.cancelled) setResult(r);
        })
        .catch((e) => id === latest.current && props.onError(errorMessage(e)))
        .finally(() => id === latest.current && setSearching(false));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  /** Nom affiché d'un projet, y compris pour une archive dont le projet n'existe plus. */
  const label = (s: SessionHits) => {
    const p = projects.get(s.projectKey);
    if (p) return projectName(p, config);
    return config.projects[s.projectKey]?.displayName || s.projectPath?.split(/[\\/]/).filter(Boolean).pop() || s.projectKey;
  };

  // Groupes par projet, dans l'ordre de la conversation la plus récente de chacun.
  const groups = useMemo(() => {
    const map = new Map<string, SessionHits[]>();
    for (const s of result?.sessions ?? []) {
      const list = map.get(s.projectKey) ?? [];
      list.push(s);
      map.set(s.projectKey, list);
    }
    return [...map.entries()];
  }, [result]);

  const short = query.trim().length < MIN_CHARS;
  const count = result?.sessions.length ?? 0;

  return (
    <main className="main" onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
      <header className="project-header">
        <div className="project-title">
          <h2>Rechercher partout</h2>
        </div>
        <p className="muted">
          Dans les messages et les réponses de toutes les conversations, archives comprises. Casse et accents ignorés.
        </p>
      </header>

      <div className="search-bar">
        <Search size={15} />
        <input
          ref={input}
          value={query}
          onChange={(e) => props.onQueryChange(e.target.value)}
          placeholder="Un mot, une phrase…"
        />
        {searching && <span className="search-status">Recherche…</span>}
        {query && (
          <button className="icon-btn" onClick={() => props.onQueryChange("")} title="Effacer">
            <X size={14} />
          </button>
        )}
      </div>

      {result && !short && (
        <div className="search-summary">
          {count === 0
            ? "Aucune conversation ne contient ce texte."
            : `${count} conversation${count > 1 ? "s" : ""} dans ${groups.length} projet${groups.length > 1 ? "s" : ""}`}
          {result.truncated && " (liste limitée aux plus récentes)"}
          <span className="dot">·</span>
          {result.elapsedMs} ms
        </div>
      )}

      <div className="session-list">
        {short && <div className="empty">Tapez au moins {MIN_CHARS} caractères.</div>}
        {!short &&
          groups.map(([key, sessions]) => (
            <section key={key} className="search-group">
              <h3 className="search-group-title">
                {label(sessions[0])} <span className="count">{sessions.length}</span>
              </h3>
              {sessions.map((s) => (
                <div key={s.sessionId} className="search-result">
                  <button className="search-result-head" onClick={() => props.onOpen(s, s.hits[0])} title="Ouvrir la conversation">
                    <span className="session-title">{s.title}</span>
                    {s.archived && <span className="tag">archivée</span>}
                    <span className="session-meta">
                      {formatDate(s.updatedAt)}
                      <span className="dot">·</span>
                      {s.matchCount} message{s.matchCount > 1 ? "s" : ""}
                    </span>
                  </button>
                  {s.hits.map((h) => (
                    <button key={h.line} className="search-excerpt" onClick={() => props.onOpen(s, h)}>
                      <span className="search-role">{h.role === "user" ? "Vous" : "Claude"}</span>
                      <span>
                        {h.excerpt.before}
                        <mark>{h.excerpt.matched}</mark>
                        {h.excerpt.after}
                      </span>
                    </button>
                  ))}
                  {s.matchCount > s.hits.length && (
                    <div className="search-more">
                      et {s.matchCount - s.hits.length} autre{s.matchCount - s.hits.length > 1 ? "s" : ""} message
                      {s.matchCount - s.hits.length > 1 ? "s" : ""}
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
      </div>
    </main>
  );
}
