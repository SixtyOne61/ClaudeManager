// Faux backend pour travailler l'interface dans un simple navigateur (`npm run dev`,
// hors de Tauri). Chargé uniquement en développement, jamais dans l'exécutable.
// Les données sont fictives : aucune lecture de ~/.claude.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Config, Hub, HubRole, OpenConversation, ProjectInfo, ScanResult, SearchResult, SessionHits, SessionInfo } from "./api";
import type { ChunkMeta, ConversationEntry, DiffLine } from "./conversation";
import type { SlashEntry } from "./slashCommands";
import type { HubMessage, NameUse } from "./messages";
import type { ContextInfo, Suggestion } from "./suggestions";

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
  groupTabs: true,
  // Hub fictif : deux conversations de « SiteVitrine » et une de « JeuDeCartes ».
  hubs: [
    {
      id: "hub-demo",
      name: "Refonte du site",
      color: "#0891b2",
      members: [
        { conversationId: site.sessions[0].id, role: "coordinateur" },
        { conversationId: site.sessions[1].id, role: "executant" },
        { conversationId: jeu.sessions[1].id, role: "executant" },
      ],
      createdAt: now - 86_400_000,
      archived: null,
    },
  ],
};

/** Modifie un hub (mêmes règles que hubs.rs) ; erreur s'il n'existe plus. */
function changeHub(id: string, f: (h: Hub) => Hub): Config {
  if (!config.hubs?.some((h) => h.id === id)) throw "Ce hub n'existe plus.";
  config = { ...config, hubs: config.hubs.map((h) => (h.id === id ? f(h) : h)) };
  return config;
}

/** Range une conversation dans un hub (elle quitte les autres ; un seul coordinateur). */
function setHubMember(hubId: string, conversationId: string, role: HubRole): Config {
  changeHub(hubId, (h) => h);
  config = {
    ...config,
    hubs: (config.hubs ?? []).map((h) => {
      if (h.id !== hubId) return { ...h, members: h.members.filter((m) => m.conversationId !== conversationId) };
      const members = h.members.map((m) => (role === "coordinateur" && m.role === "coordinateur" ? { ...m, role: "executant" as HubRole } : m));
      const i = members.findIndex((m) => m.conversationId === conversationId);
      if (i >= 0) members[i] = { conversationId, role };
      else members.push({ conversationId, role });
      return { ...h, members };
    }),
  };
  return config;
}

/** Une conversation supprimée quitte son hub. */
function dropFromHubs(id: string) {
  config = { ...config, hubs: (config.hubs ?? []).map((h) => ({ ...h, members: h.members.filter((m) => m.conversationId !== id) })) };
}

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
      text: "J'ai trouvé le problème :\n\n1. le menu est **ouvert** mais jamais refermé ;\n2. `aria-expanded` n'est pas mis à jour.\n\n```js\nmenu.classList.toggle('open');\n```\n\nPour vérifier :\n\n```bash\nnpm test -- menu\n```\n\n```powershell\nGet-ChildItem src\n```\n\n| Fichier | Changement |\n| --- | --- |\n| menu.js | bascule |\n\nVoir [la doc](https://example.com) (ouverte dans le navigateur).",
    },
    { kind: "tool", line: 9, uuid: "d9", id: "t3", name: "Edit", title: "C:\\Users\\moi\\Projets\\SiteVitrine\\src\\menu.js", detail: null, path: "C:\\Users\\moi\\Projets\\SiteVitrine\\src\\menu.js", diff, diffTruncated: false },
    { kind: "toolResult", line: 10, toolUseId: "t3", text: "The file has been updated.", isError: false, truncated: false },
    { kind: "tool", line: 11, uuid: "d11", id: "t4", name: "Bash", title: "npm test", detail: "Lance les tests", path: null, diff: null, diffTruncated: false },
    { kind: "toolResult", line: 12, toolUseId: "t4", text: "Exit code 1\n1 test échoué : menu.test.js", isError: true, truncated: false },
    { kind: "tool", line: 12, uuid: "d12a", id: "t5", name: "Grep", title: "toggleMenu", detail: "src", path: null, diff: null, diffTruncated: false },
    { kind: "toolResult", line: 12, toolUseId: "t5", text: "src/menu.js:3\nsrc/menu.test.js:8", isError: false, truncated: false },
    {
      kind: "tool",
      line: 12,
      uuid: "d12b",
      id: "t6",
      name: "mcp__Claude_Browser__browser_batch",
      title: '{"actions":[{"name":"navigate","input":{"url":"http://localhost:1420"}},{"name":"computer","input":{"action":"screenshot"}}]}',
      detail: null,
      path: null,
      diff: null,
      diffTruncated: false,
    },
    { kind: "toolResult", line: 12, toolUseId: "t6", text: "Capture d'écran prise.", isError: false, truncated: false },
    { kind: "tool", line: 12, uuid: "d12c", id: "t7", name: "Read", title: "C:\\Users\\moi\\Projets\\SiteVitrine\\src\\menu.test.js", detail: null, path: null, diff: null, diffTruncated: false },
    { kind: "toolResult", line: 12, toolUseId: "t7", text: "1\timport { toggleMenu } from './menu.js';", isError: false, truncated: false },
    { kind: "assistant", line: 12, uuid: "d12d", text: "Le test attendait l'ancien comportement : je le mets à jour." },
    { kind: "user", line: 13, uuid: "d13", text: "/model opus", command: true },
    { kind: "notice", line: 14, uuid: "d14", text: "Modèle : opus" },
  ];
}

// ---- Faux messages entre conversations du hub fictif (voir src/messages.ts) ---------------
// Le coordinateur confie le formulaire à un exécutant, qui rend compte ; une conversation hors
// du hub (Claude Desktop, nom brut « local_… ») écrit aussi au coordinateur.

const DEMO_COORD = site.sessions[0].id;
const DEMO_EXEC = site.sessions[1].id;
const DEMO_TASK = [
  "Peux-tu prendre le **formulaire de contact** ?",
  "",
  "- validation côté client ;",
  "- message de confirmation après l'envoi.",
  "",
  "Rends-moi compte avec SendMessage quand c'est fait.",
].join("\n");
const DEMO_REPORT = "Formulaire terminé : validation des champs, message de confirmation, tests à jour (`npm test` passe).";
const DEMO_OUTSIDE = "J'ai relevé deux contrastes insuffisants sur la page d'accueil (boutons secondaires).";

/** Noms de messagerie du faux backend. */
const fakeNames: NameUse[] = [
  { name: "sitevitrine-c0", sessionId: DEMO_COORD, since: now - 86_400_000 },
  { name: "sitevitrine-e1", sessionId: DEMO_EXEC, since: now - 86_400_000 },
];

/** Messages ajoutés aux transcriptions des membres du hub fictif. */
function demoMessages(id: string): ConversationEntry[] {
  const m = (line: number, sent: boolean, peer: string, text: string, hoursAgo: number, summary: string | null = null, peerName: string | null = null): ConversationEntry => ({
    kind: "message",
    line,
    uuid: `msg${line}`,
    id: sent ? `tm${line}` : null,
    sent,
    peer,
    peerName,
    summary,
    text,
    truncated: false,
    timestamp: iso(hoursAgo),
  });
  if (id === DEMO_COORD)
    return [
      m(15, true, "sitevitrine-e1", DEMO_TASK, 5, "Ticket : formulaire de contact"),
      m(16, false, "sitevitrine-e1", DEMO_REPORT, 2, null, "sitevitrine-e1"),
      m(17, false, "local_5b2e9a7c-0000-4000-8000-000000000000", DEMO_OUTSIDE, 1, null, "Revue d'accessibilité"),
    ];
  if (id === DEMO_EXEC)
    return [m(15, false, "sitevitrine-c0", DEMO_TASK, 5, null, "sitevitrine-c0"), m(16, true, "sitevitrine-c0", DEMO_REPORT, 2, "Formulaire terminé")];
  return [];
}

/** Fil du hub fictif (même résultat que `messages::hub_thread`). */
function fakeHubMessages(hubId: string): HubMessage[] {
  const hub = config.hubs?.find((h) => h.id === hubId);
  const members = new Set(hub?.members.map((m) => m.conversationId) ?? []);
  const peer = (id: string, name: string) => ({ conversationId: members.has(id) ? id : null, name });
  const list: HubMessage[] = [];
  if (members.has(DEMO_COORD) || members.has(DEMO_EXEC)) {
    list.push({ from: peer(DEMO_COORD, "sitevitrine-c0"), to: peer(DEMO_EXEC, "sitevitrine-e1"), summary: "Ticket : formulaire de contact", text: DEMO_TASK, timestamp: iso(5) });
    list.push({ from: peer(DEMO_EXEC, "sitevitrine-e1"), to: peer(DEMO_COORD, "sitevitrine-c0"), summary: "Formulaire terminé", text: DEMO_REPORT, timestamp: iso(2) });
  }
  if (members.has(DEMO_COORD))
    list.push({ from: { conversationId: null, name: "Revue d'accessibilité" }, to: peer(DEMO_COORD, "sitevitrine-c0"), summary: null, text: DEMO_OUTSIDE, timestamp: iso(1) });
  return list;
}

function fakeTranscript(id: string): ConversationEntry[] | null {
  let t = transcripts.get(id);
  if (!t && scan.projects.some((p) => p.sessions.some((s) => s.id === id))) transcripts.set(id, (t = [...demoTranscript(), ...demoMessages(id)]));
  return t ?? null;
}

const changed = (id: string) => setTimeout(() => emit("conversation-changed", id), 0);

const DEMO_GRILL = `Avant de toucher au menu, trois points à trancher.

---

❓ **Q1** - **Où ranger l'état du menu ?** : aujourd'hui il vit dans une classe CSS.
- **(a)** Garder la classe \`open\`.
- **(b)** Un attribut \`data-state\`.

➡️ Je recommande (a) : c'est ce que les tests vérifient déjà.

---

❓ **Q2 - Fermer le menu au clic en dehors ?** Sur mobile, c'est le comportement attendu.

➡️ Oui, avec un seul écouteur sur \`document\`.

---

❓ **Q3** - **Quel nom pour le fichier de tests ?**: aucune convention dans le projet.

Réponds quand tu veux.`;

/** Réponse fictive à la consigne du résumé de passation. */
const FAKE_HANDOFF_SUMMARY = [
  "## Objectif",
  "Corriger le menu mobile qui ne se ferme pas.",
  "",
  "## État actuel",
  "Le script bascule désormais la classe `open` ; un test reste à mettre à jour.",
  "",
  "## Décisions",
  "- Garder la classe `open` (les tests la vérifient déjà).",
  "",
  "## Fichiers touchés",
  "- `src/menu.js`",
  "",
  "## Prochaines étapes",
  "1. Mettre à jour `menu.test.js`.",
  "2. Vérifier sur mobile.",
].join("\n");

/** Message envoyé : ajouté au fichier, puis une réponse fictive arrive en plusieurs fois. */
function fakeReply(id: string, text: string) {
  const t = fakeTranscript(id) ?? (transcripts.set(id, []), transcripts.get(id)!);
  const next = () => (t.length ? t[t.length - 1].line + 1 : 0);
  const mode = fakeModeState(id);
  Object.assign(mode, { recorded: mode.current, line: next(), index: t.length });
  t.push(text.startsWith("/") ? { kind: "user", line: next(), uuid: `m${next()}`, text, command: true } : { kind: "user", line: next(), uuid: `m${next()}`, text, command: false });
  changed(id);
  if (text.startsWith("/")) return;
  // Consigne du hand off : le résumé de passation arrive en une réponse (voir handoff.ts).
  if (/résumé de passation/i.test(text)) {
    setTimeout(() => {
      t.push({ kind: "assistant", line: next(), uuid: `m${next()}`, text: FAKE_HANDOFF_SUMMARY });
      changed(id);
    }, 1200);
    return;
  }
  // « grill » : une série de questions (formulaire de réponse, voir Grill.tsx).
  if (/grill/i.test(text)) {
    setTimeout(() => {
      t.push({ kind: "assistant", line: next(), uuid: `m${next()}`, text: DEMO_GRILL });
      changed(id);
    }, 400);
    return;
  }
  const steps: (() => void)[] = [
    () => {
      fakeTurns.set(id, (fakeTurns.get(id) ?? 0) + 1);
      t.push({ kind: "assistant", line: next(), uuid: `m${next()}`, text: `Je m'occupe de « ${text.split("\n")[0]} ».` });
    },
    () => t.push({ kind: "tool", line: next(), uuid: `m${next()}`, id: `x${next()}`, name: "Bash", title: "ls src", detail: null, path: null, diff: null, diffTruncated: false }),
    () => {
      const tool = [...t].reverse().find((e) => e.kind === "tool")!;
      t.push({ kind: "toolResult", line: next(), toolUseId: (tool as { id: string }).id, text: "menu.js\nstyles.css", isError: false, truncated: false });
    },
    // Deuxième action du même groupe : la ligne repliée suit la dernière action en direct.
    () => t.push({ kind: "tool", line: next(), uuid: `m${next()}`, id: `x${next()}`, name: "Read", title: "C:\\Users\\moi\\Projets\\SiteVitrine\\src\\menu.js", detail: null, path: null, diff: null, diffTruncated: false }),
    () => {
      const tool = [...t].reverse().find((e) => e.kind === "tool")!;
      t.push({ kind: "toolResult", line: next(), toolUseId: (tool as { id: string }).id, text: "1\tfunction toggleMenu() {}", isError: false, truncated: false });
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

// Pied de conversation : modèle, mode de permission et consommation de la fausse
// transcription. Le mode n'est « enregistré » qu'avec le message suivant, comme dans Claude
// Code ; le faux terminal, lui, l'affiche tout de suite après Maj+Tab (« … on (shift+tab to cycle) »).
const FAKE_MODES = ["default", "acceptEdits", "plan", "auto"] as const;
const FAKE_INDICATORS: Record<string, string> = { acceptEdits: "⏵⏵ accept edits on", plan: "⏸ plan mode on", auto: "⏵⏵ auto mode on" };
/** Mode courant du faux terminal, et dernier mode écrit dans la transcription (avec sa ligne). */
const fakeModes = new Map<string, { current: string; recorded: string; line: number; index: number }>();
/** Nombre de réponses fictives (la consommation grandit à chacune). */
const fakeTurns = new Map<string, number>();

function fakeModeState(id: string) {
  let m = fakeModes.get(id);
  if (!m) fakeModes.set(id, (m = { current: "auto", recorded: "auto", line: 3, index: 1 }));
  return m;
}

/** Maj+Tab dans le faux terminal : mode suivant, affiché sous la fausse zone de saisie. */
function fakeCycleMode(key: string) {
  const m = fakeModeState(key);
  m.current = FAKE_MODES[(FAKE_MODES.indexOf(m.current as (typeof FAKE_MODES)[number]) + 1) % FAKE_MODES.length];
  const ind = FAKE_INDICATORS[m.current];
  ptyOut(key, `\r\n\x1b[2m${ind ? `${ind} (shift+tab to cycle)` : "? for shortcuts"}\x1b[0m\r\n> `);
}

function fakeMeta(id: string, from: number, t: ConversationEntry[]): ChunkMeta {
  const m = fakeModeState(id);
  const turns = fakeTurns.get(id) ?? 0;
  const fresh = from === 0;
  const recordedNow = m.index >= from;
  const cacheRead = 142_000 + turns * 9_000;
  return {
    model: fresh || turns ? "claude-opus-5-5" : null,
    modelIdentity: fresh ? { id: "claude-opus-5-5", name: "Opus 5.5" } : null,
    modelLine: fresh || turns ? 1 : null,
    modelSwitch: null,
    permissionMode: recordedNow ? m.recorded : null,
    permissionModeLine: recordedNow ? m.line : null,
    usage: fresh || from < t.length ? { inputTokens: 6, cacheCreationInputTokens: 1_850, cacheReadInputTokens: cacheRead, outputTokens: 420 } : null,
    outputs: fresh ? [{ id: "msg_d1", tokens: 1_210 }, { id: "msg_d2", tokens: 3_400 }, ...Array.from({ length: turns }, (_, i) => ({ id: `msg_r${i}`, tokens: 420 }))] : from < t.length && turns ? [{ id: `msg_r${turns - 1}`, tokens: 420 }] : [],
  };
}

function fakeConversationRead(a: Record<string, unknown>) {
  const id = String(a.sessionId);
  const t = fakeTranscript(id);
  if (!t) return { exists: false, reset: false, headSkipped: false, entries: [], offset: 0, line: 0 };
  const from = Number(a.offset ?? 0);
  return { exists: true, reset: false, headSkipped: false, entries: t.slice(from), offset: t.length, line: t.length, meta: fakeMeta(id, from, t) };
}

// ---- Faux états des conversations (hooks) ---------------------------------------------
// Une conversation reprise attend un message ; un message la passe « en cours », puis
// elle est « à toi » (ou « action requise » si le message contient « permission »).
// Deux conversations parcourent les quatre états (demoCycle) toutes les 3 s.

type FakeActivity = { state: "running" | "waiting"; kind: string; detail?: string; event?: string };
const activities = new Map<string, FakeActivity & { sessionId: string; event: string; at: number }>();
const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setActivity(key: string, a: FakeActivity | null) {
  const full = a && { sessionId: key, event: "Mock", at: Date.now(), ...a };
  if (full) activities.set(key, full);
  else activities.delete(key);
  setTimeout(() => emit("conversation-activity", { sessionId: key, activity: full }), 0);
}

// ---- Fausses limites d'utilisation (ligne d'état) --------------------------------------
// Aucune au démarrage ; la première conversation lancée les fait apparaître, et chaque
// message fait monter la fenêtre de 5 h (orange au-delà de 80 %, rouge à partir de 95 %).
let usageLimits: { fiveHour: { usedPercentage: number; resetsAt: number } | null; sevenDay: { usedPercentage: number; resetsAt: number } | null; at: number } | null = null;

function bumpUsage() {
  const nowS = Math.floor(Date.now() / 1000);
  const five = usageLimits?.fiveHour?.usedPercentage ?? 30;
  usageLimits = {
    fiveHour: { usedPercentage: Math.min(100, five + 12), resetsAt: nowS + 2 * 3600 + 17 * 60 },
    sevenDay: { usedPercentage: (usageLimits?.sevenDay?.usedPercentage ?? 17) + 1, resetsAt: nowS + 3 * 86400 + 5 * 3600 },
    at: Date.now() - 4 * 60_000,
  };
  setTimeout(() => emit("usage-limits", usageLimits), 0);
}

// Contexte de chaque conversation (ligne d'état) : « Refonte de la page d'accueil » est déjà
// remplie à 72 % (suggestion de hand off) ; chaque message envoyé ajoute 9 points.
const contexts = new Map<string, ContextInfo>([
  [site.sessions[0].id, { sessionId: site.sessions[0].id, usedPercentage: 72, at: now, since: now - 3600_000 }],
  [jeu.sessions[1].id, { sessionId: jeu.sessions[1].id, usedPercentage: 35, at: now, since: now - 3600_000 }],
]);

/** Même règle que suggestions.rs (seuil réglable, paliers 80 et 90, « Ignorer » jusqu'au palier suivant). */
function fakeSuggestions() {
  const archivedIds = new Set(config.archives.map((a) => a.sessionId));
  const threshold = Math.min(95, Math.max(10, config.suggestions?.contextThreshold ?? 60));
  const enabled = !(config.suggestions?.disabled ?? []).includes("context");
  const suggestions: Suggestion[] = [];
  for (const c of enabled ? contexts.values() : []) {
    const level = [threshold, ...[80, 90].filter((t) => t > threshold)].filter((t) => c.usedPercentage >= t).pop();
    if (level === undefined || archivedIds.has(c.sessionId)) continue;
    const d = config.conversations[c.sessionId]?.dismissedSuggestions?.context;
    if (d && d.level >= level && d.at >= c.since) continue;
    suggestions.push({ rule: "context", sessionId: c.sessionId, key: "context", level, since: c.since, data: { percent: Math.round(c.usedPercentage) } });
  }
  suggestions.push(...fakeHubSuggestions(archivedIds));
  return { contexts: [...contexts.values()], suggestions };
}

// Échanges fictifs entre conversations (règle « hub ») : deux conversations hors de tout hub
// (« Créer un hub »), et une conversation qui a écrit au coordinateur du hub fictif (« Ajouter
// au hub »).
const fakeExchanges = [
  { from: site.sessions[2].id, to: jeu.sessions[2].id },
  { from: jeu.sessions[0].id, to: site.sessions[0].id },
];

/** Même règle que `detect_hub` (suggestions.rs). */
function fakeHubSuggestions(archivedIds: Set<string>): Suggestion[] {
  if ((config.suggestions?.disabled ?? []).includes("hub")) return [];
  const hubOfId = (id: string) => config.hubs?.find((h) => !h.archived && h.members.some((m) => m.conversationId === id)) ?? null;
  const out: Suggestion[] = [];
  for (const e of fakeExchanges) {
    const [hf, ht] = [hubOfId(e.from), hubOfId(e.to)];
    if ((hf && ht && hf.id === ht.id) || archivedIds.has(e.from) || archivedIds.has(e.to)) continue;
    for (const [me, other, mine, theirs] of [
      [e.from, e.to, hf, ht],
      [e.to, e.from, ht, hf],
    ] as const) {
      const key = `hub:${other}`;
      if (config.conversations[me]?.dismissedSuggestions?.[key]) continue;
      const hub = mine ?? theirs;
      const joiner = mine ? other : theirs ? me : null;
      const leaves = mine && theirs ? theirs.name : null;
      out.push({ rule: "hub", sessionId: me, key, level: 1, since: null, data: { other, from: e.from, to: e.to, hubId: hub?.id ?? null, hubName: hub?.name ?? null, joiner, leaves } });
    }
  }
  return out;
}
const emitSuggestions = () => setTimeout(() => emit("suggestions", fakeSuggestions()), 0);

function bumpContext(key: string) {
  const prev = contexts.get(key);
  const pct = Math.min(100, (prev?.usedPercentage ?? 5) + 9);
  contexts.set(key, { sessionId: key, usedPercentage: pct, at: Date.now(), since: prev?.since ?? Date.now() });
  emitSuggestions();
}

function fakeTurn(key: string, line: string) {
  bumpUsage();
  bumpContext(key);
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

// Les quatre états : en cours, action requise (permission, question, erreur), à toi, fermée (null).
const demoCycle: (FakeActivity | null)[] = [
  { state: "running", kind: "tool", detail: "Edit" },
  { state: "waiting", kind: "permission", detail: "Bash" },
  { state: "running", kind: "tool", detail: "Bash" },
  { state: "waiting", kind: "turn" },
  { state: "waiting", kind: "question", detail: "AskUserQuestion" },
  { state: "waiting", kind: "error", detail: "rate_limit" },
  { state: "waiting", kind: "turn", event: "Notification", detail: "idle_prompt" },
  null,
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
      if (data === "\x1b[Z") {
        fakeCycleMode(key);
        return null;
      }
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

/** Commande d'un bloc ▶ exécutée « dans le terminal intégré » : fausse sortie, puis fin. */
function fakeRun(a: Record<string, unknown>) {
  const key = `run-${a.runId}`;
  const shown = String(a.code).replace(/\n/g, "\r\n$ ");
  ptyOut(key, `\x1b[2m$ ${shown}\x1b[0m\r\n(sortie fictive, dans ${a.cwd})\r\n`);
  setTimeout(() => emit("pty-exit", { key, code: 0 }), 800);
  return { key, cwd: a.cwd, running: true };
}

export function installDevMock() {
  mockWindows("main");
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd.startsWith("pty_")) return fakePty(cmd, a);
    // Les hubs changent : suggestions recalculées (règle « hub »), comme lib.rs.
    if (cmd.startsWith("hub_") && cmd !== "hub_messages") emitSuggestions();
    if (cmd === "activity_list") return [...activities.values()];
    if (cmd === "usage_limits") return usageLimits;
    if (cmd === "suggestions_list") return fakeSuggestions();
    if (cmd === "conversation_read") return fakeConversationRead(a);
    if (cmd === "hub_messages") return fakeHubMessages(String(a.hubId));
    if (cmd === "messaging_directory") return fakeNames;
    // Nom de messagerie actuel : seulement si la conversation « tourne » (terminal fictif ouvert).
    if (cmd === "messaging_name") {
      const id = String(a.sessionId);
      return fakePtys.has(id) ? (fakeNames.find((n) => n.sessionId === id)?.name ?? `fictif-${id.slice(0, 4)}`) : null;
    }
    if (cmd === "list_slash_commands") return fakeSlashCommands();
    if (cmd === "run_integrated") return fakeRun(a);
    if (cmd === "plugin:opener|open_url") return void window.open(String(a.url), "_blank");
    console.info("[mock]", cmd, a);
    switch (cmd) {
      case "scan":
        return scan;
      case "get_config":
        return config;
      case "is_git_repo":
        return fakeGitRepos().includes(String(a.path));
      case "worktree_offer": {
        // Même règle que worktrees::worktree_offer (≥ 2 conversations hors worktree, dépôt git).
        const norm = (d: string) => d.replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();
        const dir = String(a.path);
        const open = a.open as OpenConversation[];
        const n = open.filter((c) => c.running && !c.inWorktree && !/[\\/]\.claude[\\/]worktrees[\\/]/i.test(c.cwd) && norm(c.cwd) === norm(dir)).length;
        return n >= 2 && fakeGitRepos().includes(dir) ? n : null;
      }
      case "save_config":
        config = { ...(a.cfg as Config), archives: config.archives, handoffLinks: config.handoffLinks, hubs: config.hubs };
        emitSuggestions();
        return config;
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
      case "trash_session": {
        const p = scan.projects.find((x) => x.sessions.some((s) => s.id === a.sessionId))!;
        const s = p.sessions.find((x) => x.id === a.sessionId)!;
        if (!a.force && Date.now() - s.modifiedMs < 120_000)
          throw "SESSION_ACTIVE: cette conversation a été modifiée il y a moins de 2 minutes, elle est peut-être ouverte dans Claude Desktop ou dans un autre terminal.";
        p.sessions = p.sessions.filter((x) => x !== s);
        scan = { ...scan };
        dropFromHubs(s.id);
        return null;
      }
      case "archive_session": {
        // Une conversation de worktree a une clé de stockage différente de son projet : recherche par id.
        const p = scan.projects.find((x) => x.sessions.some((s) => s.id === a.sessionId))!;
        const s = p.sessions.find((x) => x.id === a.sessionId)!;
        if (!a.force && Date.now() - s.modifiedMs < 120_000)
          throw "SESSION_ACTIVE: cette conversation a été modifiée il y a moins de 2 minutes, elle est peut-être ouverte dans Claude Desktop ou dans un autre terminal.";
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
      case "handoff_summary": {
        // Même règle que handoff::last_reply : textes de l'agent après le dernier message de
        // l'utilisateur (et après sa dernière action).
        const t = fakeTranscript(String(a.sessionId)) ?? [];
        const after = t.slice(t.map((e) => e.kind).lastIndexOf("user") + 1);
        const summary = after
          .slice(after.map((e) => e.kind).lastIndexOf("tool") + 1)
          .flatMap((e) => (e.kind === "assistant" ? [e.text] : []))
          .join("\n\n")
          .trim();
        if (!summary) return null;
        const firstMessage = `Cette conversation prend la suite de « ${a.parentTitle} », dont le contexte était trop rempli. Voici le résumé de passation qu'elle a rédigé pour toi :\n\n${summary}`;
        return { summary, firstMessage };
      }
      case "handoff_finish": {
        // Même règle que lib.rs : la parente est archivée, la suite prend sa section, sa
        // couleur et le lien parente → suite.
        const parent = String(a.parentId);
        const successor = String(a.successorId);
        const p = scan.projects.find((x) => x.sessions.some((s) => s.id === parent));
        const s = p?.sessions.find((x) => x.id === parent);
        if (p && s) {
          p.sessions = p.sessions.filter((x) => x !== s);
          archived.set(s.id, s);
          scan = { ...scan };
          const entry = { sessionId: s.id, projectKey: p.key, projectPath: p.path, title: s.title, messageCount: s.messageCount, updatedAt: s.updatedAt, archivedAt: Date.now(), originalFile: "", originalDir: null, archivedFile: "", archivedDir: null };
          config = { ...config, archives: [...config.archives, entry] };
        }
        const projects = Object.fromEntries(
          Object.entries(config.projects).map(([k, prefs]) => [
            k,
            {
              ...prefs,
              sections: (prefs.sections ?? []).map((sec) => {
                const ids = sec.conversationIds.filter((id) => id !== successor);
                const i = ids.indexOf(parent);
                return { ...sec, conversationIds: i < 0 ? ids : [...ids.slice(0, i + 1), successor, ...ids.slice(i + 1)] };
              }),
            },
          ]),
        );
        const color = config.conversations[parent]?.color;
        config = {
          ...config,
          projects,
          conversations: color ? { ...config.conversations, [successor]: { ...config.conversations[successor], color } } : config.conversations,
          handoffLinks: { ...config.handoffLinks, [parent]: { successorId: successor, at: Date.now() } },
          // La suite prend la place et le rôle de la parente dans son hub.
          hubs: (config.hubs ?? []).map((h) =>
            h.members.some((m) => m.conversationId === parent)
              ? { ...h, members: h.members.filter((m) => m.conversationId !== successor).map((m) => (m.conversationId === parent ? { ...m, conversationId: successor } : m)) }
              : h,
          ),
        };
        emitSuggestions();
        setTimeout(() => emit("sessions-changed", null), 300);
        return { config, archiveError: null };
      }
      case "trash_archive":
        config = { ...config, archives: config.archives.filter((x) => x.sessionId !== a.sessionId) };
        dropFromHubs(String(a.sessionId));
        return config;
      case "hub_create": {
        const name = String(a.name ?? "").trim();
        if (!name) throw "Le nom du hub est vide.";
        const hub: Hub = { id: `hub-${Date.now().toString(16)}`, name, color: (a.color as string | null) ?? null, members: [], createdAt: Date.now(), archived: null };
        config = { ...config, hubs: [...(config.hubs ?? []), hub] };
        return { config, hubId: hub.id };
      }
      case "hub_update":
        return changeHub(String(a.hubId), (h) => ({ ...h, name: String(a.name).trim() || h.name, color: (a.color as string | null) ?? null }));
      case "hub_delete":
        changeHub(String(a.hubId), (h) => h);
        config = { ...config, hubs: (config.hubs ?? []).filter((h) => h.id !== a.hubId) };
        return config;
      case "hub_set_member":
        return setHubMember(String(a.hubId), String(a.conversationId), a.role as HubRole);
      case "hub_remove_member":
        return changeHub(String(a.hubId), (h) => ({ ...h, members: h.members.filter((m) => m.conversationId !== a.conversationId) }));
      case "hub_mark_archived":
        return changeHub(String(a.hubId), (h) => ({ ...h, archived: { archivedAt: Date.now(), sessionIds: a.sessionIds as string[] } }));
      case "hub_restore": {
        // Même règle que lib.rs : les conversations archivées avec le hub reviennent, puis le hub.
        const hub = config.hubs?.find((h) => h.id === a.hubId);
        const ids = hub?.archived?.sessionIds ?? [];
        let restored = 0;
        for (const id of ids) {
          const s = archived.get(id);
          // Projet affiché au moment de l'archivage (une conversation de worktree a une autre clé de stockage).
          const key = config.archives.find((x) => x.sessionId === id)?.projectKey;
          const p = s && scan.projects.find((x) => x.key === key);
          if (s && p) {
            p.sessions = [...p.sessions, s].sort((x, y) => (y.updatedAt ?? "").localeCompare(x.updatedAt ?? ""));
            archived.delete(id);
            restored++;
          }
        }
        scan = { ...scan };
        config = { ...config, archives: config.archives.filter((x) => !ids.includes(x.sessionId)) };
        changeHub(String(a.hubId), (h) => ({ ...h, archived: null }));
        return { config, restored, errors: [] };
      }
      case "mark_project_archived":
        config = {
          ...config,
          projects: { ...config.projects, [String(a.projectKey)]: { ...config.projects[String(a.projectKey)], archived: { archivedAt: Date.now(), sessionIds: a.sessionIds as string[] } } },
        };
        return config;
      case "restore_project": {
        // Même règle que lib.rs : les conversations archivées avec le projet reviennent, puis le projet.
        const key = String(a.projectKey);
        const ids = config.projects[key]?.archived?.sessionIds ?? [];
        let restored = 0;
        for (const id of ids) {
          const s = archived.get(id);
          const p = s && scan.projects.find((x) => x.key === key);
          if (s && p) {
            p.sessions = [...p.sessions, s].sort((x, y) => (y.updatedAt ?? "").localeCompare(x.updatedAt ?? ""));
            archived.delete(id);
            restored++;
          }
        }
        scan = { ...scan };
        config = {
          ...config,
          archives: config.archives.filter((x) => !ids.includes(x.sessionId)),
          projects: { ...config.projects, [key]: { ...config.projects[key], archived: null } },
        };
        return { config, restored, errors: [] };
      }
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
