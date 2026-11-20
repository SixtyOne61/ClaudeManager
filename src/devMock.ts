// Faux backend pour travailler l'interface dans un simple navigateur (`npm run dev`,
// hors de Tauri). Chargé uniquement en développement, jamais dans l'exécutable.
// Les données sont fictives : aucune lecture de ~/.claude.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Config, ProjectInfo, ScanResult, SearchResult, SessionHits, SessionInfo } from "./api";

const now = Date.now();
const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();

function session(key: string, n: number, title: string, hoursAgo: number, source: SessionInfo["titleSource"] = "custom"): SessionInfo {
  return {
    id: `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    projectKey: key,
    cwd: null,
    title,
    titleSource: source,
    firstPrompt: `Premier message de « ${title} »`,
    createdAt: iso(hoursAgo + 3),
    updatedAt: iso(hoursAgo),
    messageCount: 10 + ((n * 7) % 90),
    fileSize: 1000,
    modifiedMs: now - hoursAgo * 3600_000,
    skippedLines: n === 3 ? 1 : 0,
  };
}

function project(name: string, sessions: [string, number][], opts: Partial<ProjectInfo> = {}): ProjectInfo {
  const path = `C:\\Users\\moi\\Projets\\${name}`;
  const key = path.replace(/[^A-Za-z0-9]/g, "-");
  const list = sessions.map(([t, h], i) => session(key, i + name.length * 10, t, h, i === 2 ? "prompt" : "custom"));
  return { key, path, exists: true, isTemp: false, lastActivity: list[0]?.updatedAt ?? null, sessions: list, ...opts };
}

let scan: ScanResult = {
  terminal: "Windows Terminal",
  claudeRoot: "C:\\Users\\moi\\.claude\\projects",
  appDir: "C:\\Users\\moi\\AppData\\Roaming\\claude-manager",
  projects: [
    project("SiteVitrine", [["Refonte de la page d'accueil", 1], ["Formulaire de contact", 30], ["Peux-tu corriger le bug du menu mobile qui ne se ferme pas ?", 80]]),
    project("JeuDeCartes", [["Moteur de règles", 5], ["Deck builder", 50]]),
    project("Scripts", [["Sauvegarde automatique", 200]]),
    project("AncienProjet", [["Migration", 900]], { exists: false }),
    project("Brouillon", [["Test", 3]], { isTemp: true, path: "C:\\Users\\moi\\AppData\\Local\\Temp\\Brouillon" }),
    project("Nouveau", []),
  ],
};

let config: Config = {
  version: 1,
  categories: [
    { id: "perso", name: "Perso", color: "#7c3aed", projectKeys: [scan.projects[1].key] },
    { id: "travail", name: "Travail", color: null, projectKeys: [scan.projects[0].key, scan.projects[2].key] },
  ],
  projects: { [scan.projects[0].key]: { color: "#fde68a", displayName: "Site vitrine" } },
  archives: [],
  showTempProjects: false,
};

/** Recherche globale fictive : chaque conversation « contient » la requête dans un message. */
function mockSearchAll(query: string): SearchResult {
  const q = query.trim();
  if (q.length < 2) return { sessions: [], truncated: false, cancelled: false, elapsedMs: 0 };
  const sessions: SessionHits[] = scan.projects
    .flatMap((p) => p.sessions.map((s) => ({ p, s })))
    .filter((_, i) => i % 2 === 0)
    .map(({ p, s }, i) => ({
      projectKey: p.key,
      projectPath: p.path,
      sessionId: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      archived: false,
      matchCount: 1 + (i % 5),
      hits: [
        { role: "user", line: 3, uuid: null, excerpt: { before: "Peux-tu regarder ", matched: q, after: " dans le menu principal ?" } },
        { role: "assistant", line: 8, uuid: null, excerpt: { before: "…j'ai modifié ", matched: q, after: " et ajouté un test." } },
      ].slice(0, 1 + (i % 2)) as SessionHits["hits"],
    }));
  for (const a of config.archives) {
    sessions.push({ projectKey: a.projectKey, projectPath: a.projectPath, sessionId: a.sessionId, title: a.title, updatedAt: a.updatedAt, archived: true, matchCount: 1, hits: [{ role: "user", line: 1, uuid: null, excerpt: { before: "", matched: q, after: " (archive)" } }] });
  }
  return { sessions, truncated: false, cancelled: false, elapsedMs: 12 };
}

export function installDevMock() {
  mockWindows("main");
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    console.info("[mock]", cmd, a);
    switch (cmd) {
      case "scan":
        return scan;
      case "get_config":
        return config;
      case "save_config":
        config = { ...(a.cfg as Config), archives: config.archives };
        return config;
      case "search_sessions":
        return [];
      case "search_all":
        return mockSearchAll(String(a.query ?? ""));
      case "archive_session": {
        const p = scan.projects.find((x) => x.key === a.projectKey)!;
        const s = p.sessions.find((x) => x.id === a.sessionId)!;
        p.sessions = p.sessions.filter((x) => x !== s);
        scan = { ...scan };
        config = {
          ...config,
          archives: [...config.archives, { sessionId: s.id, projectKey: p.key, projectPath: p.path, title: s.title, messageCount: s.messageCount, updatedAt: s.updatedAt, archivedAt: Date.now(), originalFile: "", originalDir: null, archivedFile: "", archivedDir: null }],
        };
        return config;
      }
      case "restore_archive":
      case "trash_archive":
        config = { ...config, archives: config.archives.filter((x) => x.sessionId !== a.sessionId) };
        return config;
      case "plugin:dialog|ask":
        return window.confirm(String(a.message));
      case "plugin:dialog|message":
        window.alert(String(a.message));
        return null;
      case "plugin:event|listen":
        return 1;
      case "plugin:app|version":
        return "0.1.0";
      case "plugin:updater|check":
        return null; // « Vous utilisez la dernière version »
      default:
        return null;
    }
  });
}
