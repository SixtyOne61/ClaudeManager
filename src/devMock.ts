// Faux backend pour travailler l'interface dans un simple navigateur (`npm run dev`,
// hors de Tauri). Chargé uniquement en développement, jamais dans l'exécutable.
// Les données sont fictives : aucune lecture de ~/.claude.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
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

let nextSessionNumber = 1;

function project(name: string, sessions: [string, number][], opts: Partial<ProjectInfo> = {}): ProjectInfo {
  const path = `C:\\Users\\moi\\Projets\\${name}`;
  const key = path.replace(/[^A-Za-z0-9]/g, "-");
  // Numéro unique par conversation (les identifiants ne doivent pas se répéter d'un projet à l'autre).
  const list = sessions.map(([t, h], i) => session(key, nextSessionNumber++, t, h, i === 2 ? "prompt" : "custom"));
  return { key, path, exists: true, isTemp: false, lastActivity: list[0]?.updatedAt ?? null, sessions: list, ...opts };
}

let scan: ScanResult = {
  terminal: "Windows Terminal",
  claudeRoot: "C:\\Users\\moi\\.claude\\projects",
  appDir: "C:\\Users\\moi\\AppData\\Roaming\\claude-manager",
  projects: [
    project("SiteVitrine", [["Refonte de la page d'accueil", 1], ["Formulaire de contact", 30], ["Peux-tu corriger le bug du menu mobile qui ne se ferme pas ?", 80]]),
    // « Ouverte dans Desktop » : modifiée il y a 30 s (avertissement à la reprise).
    project("JeuDeCartes", [["Ouverte dans Desktop", 30 / 3600], ["Moteur de règles", 5], ["Deck builder", 50]]),
    project("Scripts", [["Sauvegarde automatique", 200]]),
    project("AncienProjet", [["Migration", 900]], { exists: false }),
    project("Brouillon", [["Test", 3]], { isTemp: true, path: "C:\\Users\\moi\\AppData\\Local\\Temp\\Brouillon" }),
    project("Nouveau", []),
  ],
};

const site = scan.projects[0];
const jeu = scan.projects[1];

// Conversations de worktree, rangées sous « SiteVitrine » (fichier dans le dossier du worktree).
{
  const parent = site;
  for (const [n, name, title, h, exists] of [
    [101, "amazing-chatelet-759adf", "Essai d'un nouveau thème", 2, true],
    [102, "old-branch-1a2b3c", "Ancienne expérience", 120, false],
  ] as const) {
    const path = `${parent.path}\\.claude\\worktrees\\${name}`;
    const s = session(path.replace(/[^A-Za-z0-9]/g, "-"), n, title, h);
    parent.sessions.push({ ...s, cwd: path, worktree: { name, path, exists } });
  }
  parent.sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

let config: Config = {
  version: 2,
  categories: [
    { id: "perso", name: "Perso", color: "#7c3aed", projectKeys: [jeu.key] },
    { id: "travail", name: "Travail", color: null, projectKeys: [site.key, scan.projects[2].key] },
  ],
  projects: {
    [site.key]: {
      color: "#fde68a",
      displayName: "Site vitrine",
      sections: [
        { id: "sec-front", name: "Interface", color: "#2563eb", conversationIds: [site.sessions[0].id, site.sessions[2].id], collapsed: false },
        // « id-disparu » : conversation qui n'existe plus, ignorée à l'affichage.
        { id: "sec-back", name: "Formulaires", color: null, conversationIds: ["id-disparu"], collapsed: false },
      ],
    },
    [jeu.key]: { sections: [{ id: "sec-regles", name: "Règles", color: "#059669", conversationIds: [jeu.sessions[1].id], collapsed: true }] },
  },
  conversations: { [site.sessions[1].id]: { color: "#dc2626" }, [site.sessions[2].id]: { color: "#fde68a" } },
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

/** Conversations archivées, pour pouvoir les restaurer. */
const archived = new Map<string, SessionInfo>();


// ---- Faux terminal intégré : affiche une invite et renvoie ce qu'on tape. -------------
// « /exit » termine le faux `claude`, pour tester l'état « terminé » et « Relancer ».

// Nouvelle conversation (`--session-id`) : le premier message crée son « fichier » (elle
// apparaît dans le scan avec ce message pour titre) ; « /exit » avant tout message la laisse sans fichier.

const fakePtys = new Map<string, { cwd: string; line: string }>();
const ptyOut = (key: string, data: string) => setTimeout(() => emit("pty-output", { key, data }), 0);

/** Simule l'écriture du `.jsonl` d'une nouvelle conversation au premier message. */
function fakeFirstMessage(id: string, cwd: string, text: string) {
  if (scan.projects.some((p) => p.sessions.some((s) => s.id === id))) return;
  const p = scan.projects.find((x) => x.path === cwd);
  if (!p) return;
  const s: SessionInfo = { ...session(p.key, 0, text, 0), id, title: text, titleSource: "prompt", firstPrompt: text, messageCount: 2 };
  p.sessions = [s, ...p.sessions];
  scan = { ...scan };
  setTimeout(() => emit("sessions-changed", null), 300);
}

function fakePty(cmd: string, a: Record<string, unknown>): unknown {
  const key = String(a.key ?? a.sessionId ?? "");
  switch (cmd) {
    case "pty_resume":
    case "pty_new_session": {
      const cwd = String(a.cwd);
      const exists = scan.projects.some((p) => p.sessions.some((s) => s.id === key));
      const args = cmd === "pty_new_session" && !exists ? `--session-id ${key}` : `--resume ${key}`;
      if (!fakePtys.has(key)) {
        fakePtys.set(key, { cwd, line: "" });
        ptyOut(key, `\x1b[38;5;173m✻ Faux Claude Code\x1b[0m (npm run dev)\r\n  claude ${args}\r\n  dans ${cwd}\r\n\r\n> `);
      }
      return { key, cwd, running: true };
    }
    case "pty_write": {
      const t = fakePtys.get(key);
      if (!t) throw "Ce terminal n'est pas ouvert.";
      for (const ch of String(a.data)) {
        if (ch === "\r") {
          const line = t.line.trim();
          t.line = "";
          if (line === "/exit") {
            fakePtys.delete(key);
            ptyOut(key, "\r\nAu revoir.\r\n");
            setTimeout(() => emit("pty-exit", { key, code: 0 }), 10);
            return null;
          }
          if (line) fakeFirstMessage(key, t.cwd, line);
          ptyOut(key, `\r\n\x1b[2m(réponse fictive à « ${line} »)\x1b[0m\r\n> `);
        } else if (ch === "\x7f") {
          if (t.line) {
            t.line = t.line.slice(0, -1);
            ptyOut(key, "\b \b");
          }
        } else if (ch >= " ") {
          t.line += ch;
          ptyOut(key, ch);
        }
      }
      return null;
    }
    case "pty_kill":
      fakePtys.delete(key);
      return null;
    case "pty_list":
      return [...fakePtys].map(([k, t]) => ({ key: k, cwd: t.cwd, running: true }));
    default: // pty_resize, pty_quit
      return null;
  }
}

export function installDevMock() {
  mockWindows("main");
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd.startsWith("pty_")) return fakePty(cmd, a);
    console.info("[mock]", cmd, a);
    switch (cmd) {
      case "scan":
        return scan;
      case "get_config":
        return config;
      case "save_config":
        config = { ...(a.cfg as Config), archives: config.archives };
        return config;
      case "open_in_desktop":
        // Simule le worktree supprimé, puis l'échec de Claude Code (pour voir les dialogues).
        if (!a.force) throw "WORKTREE_MISSING: le dossier de cette conversation n'existe plus (worktree supprimé ?) : C:\\Users\\moi\\wt\nClaude Desktop affichera probablement « Failed to load session ».";
        throw "Error: Claude Desktop is not installed.";
      case "search_sessions":
        return [];
      case "check_open_elsewhere": {
        // Même règle que actions::may_be_open_elsewhere (2 minutes, sauf écriture de l'app).
        const s = scan.projects.flatMap((p) => p.sessions).find((x) => x.id === a.sessionId && x.projectKey === a.projectKey);
        const released = a.releasedAt as number | null;
        if (s && Date.now() - s.modifiedMs < 120_000 && !(released && s.modifiedMs <= released + 5000))
          throw "SESSION_ACTIVE: cette conversation a été modifiée il y a moins de 2 minutes, elle est peut-être ouverte dans Claude Desktop ou dans un autre terminal.";
        return null;
      }
      case "search_all":
        return mockSearchAll(String(a.query ?? ""));
      case "archive_session": {
        // Une conversation de worktree a une clé de stockage différente de son projet : recherche par id.
        const p = scan.projects.find((x) => x.sessions.some((s) => s.id === a.sessionId))!;
        const s = p.sessions.find((x) => x.id === a.sessionId)!;
        p.sessions = p.sessions.filter((x) => x !== s);
        archived.set(s.id, s);
        scan = { ...scan };
        config = {
          ...config,
          archives: [...config.archives, { sessionId: s.id, projectKey: p.key, projectPath: p.path, title: s.title, messageCount: s.messageCount, updatedAt: s.updatedAt, archivedAt: Date.now(), originalFile: "", originalDir: null, archivedFile: "", archivedDir: null }],
        };
        return config;
      }
      case "restore_archive": {
        // Remet la conversation dans son projet : elle retrouve sa section et sa couleur.
        const s = archived.get(String(a.sessionId));
        const p = s && scan.projects.find((x) => x.key === s.projectKey);
        if (s && p) {
          p.sessions = [...p.sessions, s].sort((x, y) => (y.updatedAt ?? "").localeCompare(x.updatedAt ?? ""));
          archived.delete(s.id);
          scan = { ...scan };
        }
        config = { ...config, archives: config.archives.filter((x) => x.sessionId !== a.sessionId) };
        return config;
      }
      case "trash_archive":
        config = { ...config, archives: config.archives.filter((x) => x.sessionId !== a.sessionId) };
        return config;
      case "plugin:dialog|ask":
        return window.confirm(String(a.message));
      case "plugin:dialog|message": {
        // `ask` avec des libellés personnalisés passe par ici : renvoie le libellé choisi.
        const custom = (a.buttons as { OkCancelCustom?: [string, string] } | undefined)?.OkCancelCustom;
        if (custom) return window.confirm(String(a.message)) ? custom[0] : custom[1];
        window.alert(String(a.message));
        return null;
      }
      case "plugin:app|version":
        return "0.1.0";
      case "plugin:updater|check":
        return null; // « Vous utilisez la dernière version »
      default:
        return null;
    }
  }, { shouldMockEvents: true }); // `listen`/`emit` simulés : le faux terminal émet ses évènements.
}
