// Terminal intégré : appels au backend (src-tauri/src/pty.rs) et distribution des
// évènements de sortie à chaque terminal.
//
// Un terminal est repéré par une clé : l'identifiant de la conversation.
// - ptyApi.resume(...)        lance `claude --resume <id>` (ou retrouve le terminal ouvert)
// - ptyApi.write(key, texte)  envoie du texte au terminal (frappes, message à envoyer)
// - isTerminalRunning(key)    vrai si `claude` tourne dans le terminal de la conversation
// - subscribePty(key, ...)    reçoit la sortie et la fin de `claude` pour cette clé

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
    listen<{ key: string; data: string }>("pty-output", (e) => handlers.get(e.payload.key)?.onData(e.payload.data)),
    listen<{ key: string; code: number | null }>("pty-exit", (e) => {
      running.delete(e.payload.key);
      handlers.get(e.payload.key)?.onExit(e.payload.code);
    }),
  ]).then(() => undefined);
  return listening;
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
