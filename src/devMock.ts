// Faux backend pour travailler l'interface dans un simple navigateur (`npm run dev`,
// hors de Tauri). Chargé uniquement en développement, jamais dans l'exécutable.
// Les données sont fictives : aucune lecture de ~/.claude.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Config, ProjectInfo, ScanResult, SearchResult, SessionHits, SessionInfo } from "./api";
import type { ConversationEntry, DiffLine } from "./conversation";
import type { SlashEntry } from "./slashCommands";

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

// Nouveau worktree (`--worktree [nom]`) : le « fichier » est rangé dans le dossier du worktree
// et la conversation apparaît sous le projet parent, avec le badge « worktree » (ticket 08).
// Faux dépôts git : SiteVitrine et JeuDeCartes.

const fakePtys = new Map<string, { cwd: string; line: string; worktree?: string }>();
const ptyOut = (key: string, data: string) => setTimeout(() => emit("pty-output", { key, data }), 0);
const fakeGitRepos = () => [site.path, jeu.path];

/** Simule l'écriture du `.jsonl` d'une nouvelle conversation au premier message. */
function fakeFirstMessage(id: string, cwd: string, text: string, worktree?: string) {
  if (scan.projects.some((p) => p.sessions.some((s) => s.id === id))) return;
  const p = scan.projects.find((x) => x.path === cwd);
  if (!p) return;
  let s: SessionInfo = { ...session(p.key, 0, text, 0), id, title: text, titleSource: "prompt", firstPrompt: text, messageCount: 2 };
  if (worktree !== undefined) {
    const name = worktree || "brave-jumping-otter";
    const path = `${p.path}\\.claude\\worktrees\\${name}`;
    s = { ...s, projectKey: path.replace(/[^A-Za-z0-9]/g, "-"), cwd: path, worktree: { name, path, exists: true } };
  }
  p.sessions = [s, ...p.sessions];
  scan = { ...scan };
  setTimeout(() => emit("sessions-changed", null), 300);
}

// ---- Faux fichiers de conversation (interface de conversation, ticket 05) ---------------
// Une conversation existante a une transcription de démonstration (messages, commande,
// lecture, modification avec différence) ; chaque message envoyé y ajoute une réponse
// fictive, écrite en plusieurs fois comme le ferait Claude Code. La « position » renvoyée
// est simplement le nombre de lignes déjà lues.

const transcripts = new Map<string, ConversationEntry[]>();

/** Transcription de démonstration. Lignes 3 et 8 : messages trouvés par la fausse recherche. */
function demoTranscript(): ConversationEntry[] {
  const diff: DiffLine[] = [
    { op: " ", text: "function toggleMenu() {" },
    { op: "-", text: "  menu.classList.add('open');" },
    { op: "+", text: "  menu.classList.toggle('open');" },
    { op: "+", text: "  button.setAttribute('aria-expanded', menu.classList.contains('open'));" },
    { op: " ", text: "}" },
  ];
  const longOutput = Array.from({ length: 40 }, (_, i) => `${i + 1}\tligne ${i + 1} du fichier menu.js`).join("\n");
  return [
    { kind: "notice", line: 1, uuid: "d1", text: "Interrompu par l'utilisateur" },
    { kind: "user", line: 3, uuid: "d3", text: "Peux-tu regarder le menu principal ?\nIl ne se ferme pas sur mobile.", command: false },
    { kind: "assistant", line: 4, uuid: "d4", text: "Je regarde **le menu** et le script associé." },
    { kind: "tool", line: 5, uuid: "d5", id: "t1", name: "Bash", title: "git status --short", detail: "État du dépôt", path: null, diff: null, diffTruncated: false },
    { kind: "toolResult", line: 6, toolUseId: "t1", text: " M src/menu.js\n?? notes.txt", isError: false, truncated: false },
    { kind: "tool", line: 7, uuid: "d7", id: "t2", name: "Read", title: "C:\\Users\\moi\\Projets\\SiteVitrine\\src\\menu.js", detail: null, path: null, diff: null, diffTruncated: false },
    { kind: "toolResult", line: 7, toolUseId: "t2", text: longOutput, isError: false, truncated: false },
    {
      kind: "assistant",
      line: 8,
      uuid: "d8",
      text: "J'ai trouvé le problème :\n\n1. le menu est **ouvert** mais jamais refermé ;\n2. `aria-expanded` n'est pas mis à jour.\n\n```js\nmenu.classList.toggle('open');\n```\n\n| Fichier | Changement |\n| --- | --- |\n| menu.js | bascule |\n\nVoir [la doc](https://example.com) (lien non suivi).",
    },
    { kind: "tool", line: 9, uuid: "d9", id: "t3", name: "Edit", title: "C:\\Users\\moi\\Projets\\SiteVitrine\\src\\menu.js", detail: null, path: "C:\\Users\\moi\\Projets\\SiteVitrine\\src\\menu.js", diff, diffTruncated: false },
    { kind: "toolResult", line: 10, toolUseId: "t3", text: "The file has been updated.", isError: false, truncated: false },
    { kind: "tool", line: 11, uuid: "d11", id: "t4", name: "Bash", title: "npm test", detail: "Lance les tests", path: null, diff: null, diffTruncated: false },
    { kind: "toolResult", line: 12, toolUseId: "t4", text: "Exit code 1\n1 test échoué : menu.test.js", isError: true, truncated: false },
    { kind: "user", line: 13, uuid: "d13", text: "/model opus", command: true },
    { kind: "notice", line: 14, uuid: "d14", text: "Modèle : opus" },
  ];
}

function fakeTranscript(id: string): ConversationEntry[] | null {
  let t = transcripts.get(id);
  if (!t && scan.projects.some((p) => p.sessions.some((s) => s.id === id))) transcripts.set(id, (t = demoTranscript()));
  return t ?? null;
}

const changed = (id: string) => setTimeout(() => emit("conversation-changed", id), 0);

/** Message envoyé : ajouté au fichier, puis une réponse fictive arrive en plusieurs fois. */
function fakeReply(id: string, text: string) {
  const t = fakeTranscript(id) ?? (transcripts.set(id, []), transcripts.get(id)!);
  const next = () => (t.length ? t[t.length - 1].line + 1 : 0);
  t.push(text.startsWith("/") ? { kind: "user", line: next(), uuid: `m${next()}`, text, command: true } : { kind: "user", line: next(), uuid: `m${next()}`, text, command: false });
  changed(id);
  if (text.startsWith("/")) return;
  const steps: (() => void)[] = [
    () => t.push({ kind: "assistant", line: next(), uuid: `m${next()}`, text: `Je m'occupe de « ${text.split("\n")[0]} ».` }),
    () => t.push({ kind: "tool", line: next(), uuid: `m${next()}`, id: `x${next()}`, name: "Bash", title: "ls src", detail: null, path: null, diff: null, diffTruncated: false }),
    () => {
      const tool = [...t].reverse().find((e) => e.kind === "tool")!;
      t.push({ kind: "toolResult", line: next(), toolUseId: (tool as { id: string }).id, text: "menu.js\nstyles.css", isError: false, truncated: false });
    },
    () => t.push({ kind: "assistant", line: next(), uuid: `m${next()}`, text: "C'est fait. *Réponse fictive* du faux backend." }),
  ];
  steps.forEach((s, i) =>
    setTimeout(() => {
      s();
      changed(id);
    }, 400 * (i + 1)),
  );
}

function fakeConversationRead(a: Record<string, unknown>) {
  const t = fakeTranscript(String(a.sessionId));
  if (!t) return { exists: false, reset: false, headSkipped: false, entries: [], offset: 0, line: 0 };
  const from = Number(a.offset ?? 0);
  return { exists: true, reset: false, headSkipped: false, entries: t.slice(from), offset: t.length, line: t.length };
}

// ---- Faux états des conversations (hooks) ---------------------------------------------
// Une conversation reprise attend un message ; un message la passe « en cours », puis
// elle attend une réponse (une permission si le message contient « permission »).
// Deux conversations tournent dès le départ et changent d'état toutes les 3 s.

type FakeActivity = { state: "running" | "waiting"; kind: string; detail?: string; event?: string };
const activities = new Map<string, FakeActivity & { sessionId: string; event: string; at: number }>();
const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setActivity(key: string, a: FakeActivity | null) {
  const full = a && { sessionId: key, event: "Mock", at: Date.now(), ...a };
  if (full) activities.set(key, full);
  else activities.delete(key);
  setTimeout(() => emit("conversation-activity", { sessionId: key, activity: full }), 0);
}

function fakeTurn(key: string, line: string) {
  clearTimeout(activityTimers.get(key));
  setActivity(key, { state: "running", kind: "prompt" });
  activityTimers.set(
    key,
    setTimeout(() => {
      if (!fakePtys.has(key)) return;
      setActivity(key, line.includes("permission") ? { state: "waiting", kind: "permission", detail: "Bash" } : { state: "waiting", kind: "turn" });
    }, 2500),
  );
}

const demoCycle: FakeActivity[] = [
  { state: "running", kind: "tool", detail: "Edit" },
  { state: "waiting", kind: "permission", detail: "Bash" },
  { state: "running", kind: "tool", detail: "Bash" },
  { state: "waiting", kind: "turn" },
];

function startDemoActivity() {
  // Identifiants uniques (ceux de SiteVitrine et JeuDeCartes se recoupent dans ce faux jeu de données).
  const ids = [site.sessions.find((s) => s.worktree?.exists)!.id, scan.projects[2].sessions[0].id];
  ids.forEach((id) => fakePtys.set(id, { cwd: "C:\\Users\\moi\\Projets", line: "" }));
  let step = 0;
  const tick = () => {
    ids.forEach((id, i) => fakePtys.has(id) && setActivity(id, demoCycle[(step + i) % demoCycle.length]));
    step++;
  };
  tick();
  setInterval(tick, 3000);
}

/** Commandes `/…` fictives (menu de la zone de saisie), une de chaque provenance au moins. */
function fakeSlashCommands(): SlashEntry[] {
  const e = (name: string, description: string, source: SlashEntry["source"], argumentHint: string | null = null): SlashEntry => ({
    name,
    description,
    source,
    argumentHint,
  });
  return [
    e("add-dir", "Ajouter un dossier de travail à la session", "builtin", "<chemin>"),
    e("clear", "Nouvelle conversation, contexte vidé", "builtin", "[nom]"),
    e("code-review", "Relire les changements en cours ou une PR", "builtin", "[niveau] [pr|branche|chemin]"),
    e("compact", "Résumer la conversation pour libérer du contexte", "builtin", "[instructions]"),
    e("config", "Ouvrir les réglages", "builtin", "[clé=valeur]"),
    e("context", "Visualiser l'occupation du contexte", "builtin"),
    e("help", "Afficher l'aide et les commandes disponibles", "builtin"),
    e("init", "Créer un guide CLAUDE.md pour le projet", "builtin"),
    e("mcp", "Gérer les serveurs MCP", "builtin"),
    e("model", "Changer de modèle", "builtin", "[modèle]"),
    e("permissions", "Gérer les règles de permission des outils", "builtin"),
    e("resume", "Reprendre une conversation", "builtin", "[session]"),
    e("usage", "Coût de la session et limites d'utilisation", "builtin"),
    e("deployer", "Déployer le site sur l'hébergement de test", "project", "[environnement]"),
    e("revue-css", "Vérifier les styles avant une mise en ligne", "user"),
    e("outils:format", "Formater un fichier selon les règles de l'équipe", "user", "[fichier]"),
    e("mon-plugin:tdd", "Développement piloté par les tests : rouge, vert, refactorisation", "plugin"),
    e("mon-plugin:diagnostic", "Boucle de diagnostic pour les bugs difficiles et les régressions de performance, avec une description assez longue pour être coupée", "plugin"),
  ];
}

function fakePty(cmd: string, a: Record<string, unknown>): unknown {
  const key = String(a.key ?? a.sessionId ?? "");
  switch (cmd) {
    case "pty_resume":
    case "pty_new_session": {
      const cwd = String(a.cwd);
      const exists = scan.projects.some((p) => p.sessions.some((s) => s.id === key));
      const wt = cmd === "pty_new_session" && !exists && typeof a.worktree === "string" ? a.worktree : undefined;
      const args =
        cmd === "pty_new_session" && !exists
          ? `${wt === undefined ? "" : `--worktree ${wt ? wt + " " : ""}`}--session-id ${key}`
          : `--resume ${key}`;
      if (!fakePtys.has(key)) {
        fakePtys.set(key, { cwd, line: "", worktree: wt });
        ptyOut(key, `\x1b[38;5;173m✻ Faux Claude Code\x1b[0m (npm run dev)\r\n  claude ${args}\r\n  dans ${cwd}\r\n\r\n> `);
        // Lancement (« Launch »), puis le hook SessionStart : tout de suite pour une reprise,
        // après une fausse question de confiance (2,5 s) pour une nouvelle conversation.
        setActivity(key, { state: "waiting", kind: "start", event: "Launch" });
        if (!exists) ptyOut(key, "Faire confiance à ce dossier ? (fictif)\r\n> ");
        setTimeout(() => fakePtys.has(key) && setActivity(key, { state: "waiting", kind: "start", event: "SessionStart" }), exists ? 300 : 2500);
      }
      return { key, cwd, running: true };
    }
    case "pty_write": {
      const t = fakePtys.get(key);
      if (!t) throw "Ce terminal n'est pas ouvert.";
      const data = String(a.data);
      if (data === "\x1b") {
        // Échap (« Arrêter ») : interrompt la réponse en cours.
        ptyOut(key, "\r\n\x1b[2m(interrompu)\x1b[0m\r\n> ");
        setActivity(key, { state: "waiting", kind: "turn" });
        return null;
      }
      // Collage encadré (ESC[200~ … ESC[201~) : les retours à la ligne font partie du message.
      for (const ch of data.replace(/\x1b\[20[01]~/g, "")) {
        if (ch === "\n") {
          t.line += "\n";
          ptyOut(key, "\r\n  ");
        } else if (ch === "\r") {
          const line = t.line.trim();
          t.line = "";
          if (line === "/exit") {
            fakePtys.delete(key);
            ptyOut(key, "\r\nAu revoir.\r\n");
            setTimeout(() => emit("pty-exit", { key, code: 0 }), 10);
            setActivity(key, null);
            return null;
          }
          if (line) fakeReply(key, line);
          if (line) fakeFirstMessage(key, t.cwd, line.split("\n")[0], t.worktree);
          ptyOut(key, `\r\n\x1b[2m(réponse fictive à « ${line} »)\x1b[0m\r\n> `);
          // Une commande `/…` locale (menu) ne déclenche aucun hook.
          if (!line.startsWith("/")) fakeTurn(key, line);
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
      setActivity(key, null);
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
    if (cmd === "activity_list") return [...activities.values()];
    if (cmd === "conversation_read") return fakeConversationRead(a);
    if (cmd === "list_slash_commands") return fakeSlashCommands();
    console.info("[mock]", cmd, a);
    switch (cmd) {
      case "scan":
        return scan;
      case "get_config":
        return config;
      case "is_git_repo":
        return fakeGitRepos().includes(String(a.path));
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
  startDemoActivity();
}
