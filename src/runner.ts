// Commandes proposées par l'agent (blocs `bash`, `powershell`, `cmd`… de ses réponses),
// exécutées à la demande de l'utilisateur (backend : src-tauri/src/run.rs).
//
// - runExternal(...)        nouvelle fenêtre de terminal, qui reste ouverte ensuite
// - prepareRun(blockId, …)  terminal intégré sous le bloc : le lancement est fait par le
//                           panneau (`CodeRunner`), une fois xterm dimensionné (launchRun)
// - useRun(blockId)         état du lancement d'un bloc (null : jamais lancé, ou refermé)
//
// Les lancements sont gardés ici, hors des composants : le Markdown d'une réponse peut être
// redessiné (et ses blocs recréés) sans perdre le terminal ni sa sortie.

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { errorMessage } from "./api";
import { ptyApi, subscribePty, type PtyInfo } from "./pty";

/** Langues de bloc exécutables (même liste que `Shell::from_lang` côté Rust). */
const RUNNABLE = new Set(["powershell", "pwsh", "ps", "ps1", "cmd", "bat", "batch", "dos", "bash", "sh", "shell", "zsh", "console", "shell-session", "shellsession"]);

export function isRunnableLang(lang: string): boolean {
  return RUNNABLE.has(lang.trim().toLowerCase());
}

/** Nom du shell affiché sur le bouton. */
export function shellLabel(lang: string): string {
  const l = lang.trim().toLowerCase();
  if (["powershell", "pwsh", "ps", "ps1"].includes(l)) return "PowerShell";
  if (["cmd", "bat", "batch", "dos"].includes(l)) return "cmd";
  return "Git Bash";
}

export type RunState =
  | { kind: "pending" }
  | { kind: "running" }
  | { kind: "exited"; code: number | null }
  | { kind: "error"; message: string };

export interface Run {
  runId: string;
  /** Clé du terminal côté backend. */
  key: string;
  lang: string;
  code: string;
  cwd: string;
  state: RunState;
}

interface RunEntry extends Run {
  /** Sortie reçue jusqu'ici (rejouée si le panneau est recréé). */
  output: string;
  /** Panneau affiché qui reçoit la sortie en direct. */
  sink: ((data: string) => void) | null;
  unsubscribe: (() => void) | null;
}

/** Au-delà, le début de la sortie gardée pour un panneau recréé est oublié. */
const OUTPUT_MAX = 1_000_000;

const runs = new Map<string, RunEntry>();
const listeners = new Set<() => void>();
/** Instantanés immuables pour `useSyncExternalStore`. */
const snapshots = new Map<string, Run>();

function changed(blockId: string) {
  const r = runs.get(blockId);
  if (r) snapshots.set(blockId, { runId: r.runId, key: r.key, lang: r.lang, code: r.code, cwd: r.cwd, state: r.state });
  else snapshots.delete(blockId);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useRun(blockId: string): Run | null {
  return useSyncExternalStore(subscribe, () => snapshots.get(blockId) ?? null);
}

function setState(blockId: string, runId: string, state: RunState) {
  const r = runs.get(blockId);
  if (!r || r.runId !== runId) return; // relancé ou refermé entre-temps
  r.state = state;
  changed(blockId);
}

/** Ouvre le panneau d'un bloc pour un nouveau lancement (l'ancien est arrêté). */
export function prepareRun(blockId: string, lang: string, code: string, cwd: string) {
  closeRun(blockId);
  const runId = crypto.randomUUID();
  runs.set(blockId, { runId, key: `run-${runId}`, lang, code, cwd, state: { kind: "pending" }, output: "", sink: null, unsubscribe: null });
  changed(blockId);
}

/** Lance le terminal intégré préparé par `prepareRun` (appelé par le panneau, aux bonnes dimensions). */
export async function launchRun(blockId: string, cols: number, rows: number) {
  const r = runs.get(blockId);
  if (!r || r.state.kind !== "pending") return;
  const { runId, key } = r;
  r.state = { kind: "running" };
  changed(blockId);
  try {
    r.unsubscribe = await subscribePty(key, {
      onData: (d) => {
        r.output += d;
        if (r.output.length > OUTPUT_MAX) r.output = r.output.slice(-OUTPUT_MAX / 2);
        r.sink?.(d);
      },
      onExit: (code) => setState(blockId, runId, { kind: "exited", code }),
    });
    await invoke<PtyInfo>("run_integrated", { runId, lang: r.lang, code: r.code, cwd: r.cwd, cols, rows });
  } catch (e) {
    r.unsubscribe?.();
    setState(blockId, runId, { kind: "error", message: errorMessage(e) });
  }
}

/**
 * Le panneau affiché reçoit la sortie : d'abord celle déjà reçue (`replay`), puis en direct.
 * Renvoie la fonction de détachement.
 */
export function attachRun(blockId: string, replay: (past: string) => void, live: (data: string) => void): () => void {
  const r = runs.get(blockId);
  if (!r) return () => {};
  if (r.output) replay(r.output);
  r.sink = live;
  return () => {
    if (r.sink === live) r.sink = null;
  };
}

export function writeRun(blockId: string, data: string) {
  const r = runs.get(blockId);
  if (r?.state.kind === "running") ptyApi.write(r.key, data).catch(() => {});
}

export function resizeRun(blockId: string, cols: number, rows: number) {
  const r = runs.get(blockId);
  if (r?.state.kind === "running") ptyApi.resize(r.key, cols, rows).catch(() => {});
}

/** Arrête la commande ; le panneau reste affiché avec sa sortie. */
export function stopRun(blockId: string) {
  const r = runs.get(blockId);
  if (r?.state.kind !== "running") return;
  ptyApi.kill(r.key).catch(() => {});
  setState(blockId, r.runId, { kind: "exited", code: null });
}

/** Arrête la commande et referme le panneau. */
export function closeRun(blockId: string) {
  const r = runs.get(blockId);
  if (!r) return;
  if (r.state.kind === "running") ptyApi.kill(r.key).catch(() => {});
  r.unsubscribe?.();
  runs.delete(blockId);
  changed(blockId);
}

/** Exécute le bloc dans une nouvelle fenêtre de terminal, qui reste ouverte ensuite. */
export function runExternal(lang: string, code: string, cwd: string): Promise<void> {
  return invoke<void>("run_external", { runId: crypto.randomUUID(), lang, code, cwd });
}
