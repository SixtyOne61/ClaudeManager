// Terminal intégré : appels au backend (src-tauri/src/pty.rs) et distribution des
// évènements de sortie à chaque terminal.
//
// Un terminal est repéré par une clé : l'identifiant de la conversation.
// - ptyApi.resume(...)        lance `claude --resume <id>` (ou retrouve le terminal ouvert)
// - ptyApi.newSession(...)    lance `claude --session-id <id>` (nouvelle conversation)
// - startInNewWorktree(id, n) la nouvelle conversation démarrera avec `claude --worktree [n]`
// - ptyApi.write(key, texte)  envoie du texte au terminal (frappes, message à envoyer)
// - isTerminalRunning(key)    vrai si `claude` tourne dans le terminal de la conversation
// - subscribePty(key, ...)    reçoit la sortie et la fin de `claude` pour cette clé
// - watchPtyOutput(key, fn)   observe aussi la sortie (pied de conversation : mode affiché)

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface PtyInfo {
  key: string;
  cwd: string;
  running: boolean;
}

export const ptyApi = {
  resume: (sessionId: string, cwd: string, cols: number, rows: number) =>
    invoke<PtyInfo>("pty_resume", { sessionId, cwd, cols, rows }),
  /**
   * `claude --session-id <id>` (ou `--resume` si le fichier existe déjà). `worktree` : nom du
   * nouveau worktree (`claude --worktree [nom] --session-id <id>`, vide = nom choisi par Claude Code).
   */
  newSession: (sessionId: string, cwd: string, cols: number, rows: number, worktree?: string) =>
    invoke<PtyInfo>("pty_new_session", { sessionId, cwd, cols, rows, worktree: worktree ?? null }),
  write: (key: string, data: string) => invoke<void>("pty_write", { key, data }),
  resize: (key: string, cols: number, rows: number) => invoke<void>("pty_resize", { key, cols, rows }),
  kill: (key: string) => invoke<void>("pty_kill", { key }),
  list: () => invoke<PtyInfo[]>("pty_list"),
  /** Arrête tous les terminaux et ferme l'app (après confirmation de l'utilisateur). */
  quit: () => invoke<void>("pty_quit"),
};

export interface PtyHandlers {
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
}

const handlers = new Map<string, PtyHandlers>();
/** Clés dont `claude` tourne, d'après les lancements et les évènements reçus. */
const running = new Set<string>();
let listening: Promise<void> | null = null;

/** Abonnement unique aux évènements du backend, réparti ensuite par clé. */
function ensureListening(): Promise<void> {
  listening ??= Promise.all([
    listen<{ key: string; data: string }>("pty-output", (e) => {
      handlers.get(e.payload.key)?.onData(e.payload.data);
      outputWatchers.get(e.payload.key)?.forEach((w) => w(e.payload.data));
    }),
    listen<{ key: string; code: number | null }>("pty-exit", (e) => {
      running.delete(e.payload.key);
      handlers.get(e.payload.key)?.onExit(e.payload.code);
    }),
  ]).then(() => undefined);
  return listening;
}

/** Observateurs supplémentaires de la sortie (lecture seule, en plus du terminal affiché). */
const outputWatchers = new Map<string, Set<(data: string) => void>>();

/** Observe la sortie d'un terminal sans la consommer. Renvoie la fonction de désabonnement. */
export function watchPtyOutput(key: string, fn: (data: string) => void): () => void {
  let set = outputWatchers.get(key);
  if (!set) outputWatchers.set(key, (set = new Set()));
  set.add(fn);
  ensureListening();
  return () => {
    set.delete(fn);
    if (set.size === 0 && outputWatchers.get(key) === set) outputWatchers.delete(key);
  };
}

/** Reçoit la sortie d'un terminal. Renvoie la fonction de désabonnement. */
export async function subscribePty(key: string, h: PtyHandlers): Promise<() => void> {
  handlers.set(key, h);
  await ensureListening();
  return () => {
    if (handlers.get(key) === h) handlers.delete(key);
  };
}

/** Lance (ou retrouve) le terminal d'une conversation à reprendre. */
export async function resumeInTerminal(sessionId: string, cwd: string, cols: number, rows: number): Promise<PtyInfo> {
  await ensureListening();
  const info = await ptyApi.resume(sessionId, cwd, cols, rows);
  running.add(info.key);
  return info;
}

/**
 * Nouvelles conversations à démarrer dans un nouveau worktree : identifiant → nom du worktree
 * (vide = nom choisi par Claude Code). Renseigné à la création de la conversation, lu au
 * lancement du terminal ; gardé pour une relance avant le premier message.
 */
const newWorktrees = new Map<string, string>();

/** La prochaine ouverture de cette nouvelle conversation se fera dans un nouveau worktree. */
export function startInNewWorktree(sessionId: string, name: string) {
  newWorktrees.set(sessionId, name);
}

/** Caractères admis dans un nom de worktree (même règle que `validate_worktree_name` côté Rust). */
export function worktreeNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return null; // facultatif
  if (n.length > 64) return "64 caractères au plus.";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)) return "Lettres, chiffres, « - », « _ » ou « . » uniquement, en commençant par une lettre ou un chiffre.";
  if (n.includes("..") || n.endsWith(".") || n.toLowerCase().endsWith(".lock")) return "Pas de « .. », ni de « . » ou « .lock » à la fin.";
  return null;
}

/** Lance une nouvelle conversation dont l'app a choisi l'identifiant (ou la reprend si elle a déjà un fichier). */
export async function newSessionInTerminal(sessionId: string, cwd: string, cols: number, rows: number): Promise<PtyInfo> {
  await ensureListening();
  const info = await ptyApi.newSession(sessionId, cwd, cols, rows, newWorktrees.get(sessionId));
  running.add(info.key);
  return info;
}

export function isTerminalRunning(key: string): boolean {
  return running.has(key);
}

export function anyTerminalRunning(): boolean {
  return running.size > 0;
}

/** Envoie du texte au terminal d'une conversation. */
export function writeToTerminal(key: string, text: string): Promise<void> {
  return ptyApi.write(key, text);
}

/** Arrête `claude` dans ce terminal. */
export async function killTerminal(key: string): Promise<void> {
  running.delete(key);
  await ptyApi.kill(key);
}
