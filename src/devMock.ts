// Faux backend pour travailler l'interface dans un simple navigateur (`npm run dev`,
// hors de Tauri). Chargé uniquement en développement, jamais dans l'exécutable.
// Les données sont fictives : aucune lecture de ~/.claude.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Config, ProjectInfo, ScanResult, SessionInfo } from "./api";

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

// ---- Faux terminal intégré : affiche une invite et renvoie ce qu'on tape. -------------
// « /exit » termine le faux `claude`, pour tester l'état « terminé » et « Relancer ».

const fakePtys = new Map<string, { cwd: string; line: string }>();
const ptyOut = (key: string, data: string) => setTimeout(() => emit("pty-output", { key, data }), 0);

function fakePty(cmd: string, a: Record<string, unknown>): unknown {
  const key = String(a.key ?? a.sessionId ?? "");
  switch (cmd) {
    case "pty_resume": {
      const cwd = String(a.cwd);
      if (!fakePtys.has(key)) {
        fakePtys.set(key, { cwd, line: "" });
        ptyOut(key, `\x1b[38;5;173m✻ Faux Claude Code\x1b[0m (npm run dev)\r\n  claude --resume ${key}\r\n  dans ${cwd}\r\n\r\n> `);
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
      case "search_sessions":
        return [];
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
      case "plugin:app|version":
        return "0.1.0";
      case "plugin:updater|check":
        return null; // « Vous utilisez la dernière version »
      default:
        return null;
    }
  }, { shouldMockEvents: true }); // `listen`/`emit` simulés : le faux terminal émet ses évènements.
}
