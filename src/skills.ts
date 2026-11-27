// Propositions de skills (voir GLOSSARY.md, « Terminer », « Analyse de fin de conversation »,
// « Proposition de skill », src-tauri/src/skills.rs et docs/adr/0003).
//
// Terminer : l'onglet disparaît mais le terminal intégré continue de tourner, caché (sa
// conversation est affichée comme fermée). runAnalysis() y tape la question, attend la fin du
// tour, fait lire et rattacher la réponse par le backend, puis arrête le terminal. Un échec
// est ignoré en silence.
//
// - runAnalysis(id, cwd)        analyse de fin de conversation, puis arrêt du terminal
// - cancelAnalysis(id)          abandon (la conversation est rouverte) ; attend l'arrêt
// - isAnalysing(id)             analyse en cours pour cette conversation
// - useAnalysing(id)            idem, pour un composant (indicateur « analyse… »)
// - onAnalysisDone(f)           appelé après chaque analyse (relecture du rappel)
// - skillSettings(cfg)          réglages, avec les valeurs par défaut ; setters bornés

import { useSyncExternalStore } from "react";
import { api, type Config, type SkillSettings } from "./api";
import { getActivity, setActivityHidden } from "./activity";
import { sendInterrupt, sendMessage } from "./conversation";
import { sleep, waitForTurnEnd } from "./handoff";
import { killTerminal } from "./pty";

export const SKILL_WINDOW_MIN = 1;
export const SKILL_WINDOW_MAX = 60;
export const SKILL_THRESHOLD_MIN = 2;
export const SKILL_THRESHOLD_MAX = 20;

const DEFAULTS: SkillSettings = { enabled: true, windowDays: 7, threshold: 3 };

/** Réglages des propositions de skills (valeurs par défaut pour un vieux fichier). */
export function skillSettings(cfg: Config): SkillSettings {
  return { ...DEFAULTS, ...cfg.skills };
}

const clamp = (n: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, n)));

export function setSkillsEnabled(cfg: Config, enabled: boolean): Config {
  return { ...cfg, skills: { ...skillSettings(cfg), enabled } };
}

export function setSkillWindowDays(cfg: Config, n: number): Config {
  return { ...cfg, skills: { ...skillSettings(cfg), windowDays: clamp(n, SKILL_WINDOW_MIN, SKILL_WINDOW_MAX) } };
}

export function setSkillThreshold(cfg: Config, n: number): Config {
  return { ...cfg, skills: { ...skillSettings(cfg), threshold: clamp(n, SKILL_THRESHOLD_MIN, SKILL_THRESHOLD_MAX) } };
}

// ---- Analyses en cours ------------------------------------------------------------------

/** Au-delà, l'analyse est abandonnée (permission demandée malgré la consigne, agent bloqué…). */
const ANALYSIS_TIMEOUT_MS = 3 * 60_000;
/** Relectures du `.jsonl` après la fin du tour (la dernière ligne peut arriver juste après). */
const READ_ATTEMPTS = 5;
const READ_RETRY_MS = 400;

interface Running {
  abort: AbortController;
  /** Résolue une fois le terminal arrêté. */
  done: Promise<void>;
}

let running: ReadonlyMap<string, Running> = new Map();
const listeners = new Set<() => void>();
const doneListeners = new Set<() => void>();

function setRunning(sessionId: string, r: Running | null) {
  const next = new Map(running);
  if (r) next.set(sessionId, r);
  else next.delete(sessionId);
  running = next;
  setActivityHidden(sessionId, r !== null);
  listeners.forEach((f) => f());
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

export function isAnalysing(sessionId: string): boolean {
  return running.has(sessionId);
}

/** Analyse de fin de conversation en cours pour cette conversation. */
export function useAnalysing(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => running.has(sessionId));
}

/** Appelé après chaque analyse terminée (réussie ou non). Renvoie le désabonnement. */
export function onAnalysisDone(f: () => void): () => void {
  doneListeners.add(f);
  return () => {
    doneListeners.delete(f);
  };
}

/** Abandonne l'analyse de cette conversation et attend l'arrêt de son terminal. */
export async function cancelAnalysis(sessionId: string): Promise<void> {
  const r = running.get(sessionId);
  if (!r) return;
  r.abort.abort();
  await r.done;
}

/**
 * Analyse de fin de conversation : tape la question dans le terminal (toujours ouvert, mais
 * plus affiché), attend la fin du tour, fait rattacher la réponse, puis arrête le terminal.
 * Résolue une fois le terminal arrêté.
 */
export function runAnalysis(sessionId: string, cwd: string): Promise<void> {
  const existing = running.get(sessionId);
  if (existing) return existing.done;
  const abort = new AbortController();
  const done = analyse(sessionId, cwd, abort)
    .catch(() => {})
    .then(async () => {
      // Abandon pendant que l'agent répond : on l'arrête avant de fermer, comme Échap.
      if (abort.signal.aborted && getActivity(sessionId)?.state === "running") await sendInterrupt(sessionId).catch(() => {});
      await killTerminal(sessionId).catch(() => {});
      setRunning(sessionId, null);
      doneListeners.forEach((f) => f());
    });
  setRunning(sessionId, { abort, done });
  return done;
}

async function analyse(sessionId: string, cwd: string, abort: AbortController): Promise<void> {
  const signal = abort.signal;
  const timer = setTimeout(() => abort.abort(), ANALYSIS_TIMEOUT_MS);
  try {
    const prompt = await api.skillsAnalysisPrompt(cwd);
    if (signal.aborted) return;
    // Abonnement avant l'envoi : le passage « en cours » ne doit pas être manqué.
    const turn = waitForTurnEnd(sessionId, signal);
    await sendMessage(sessionId, prompt);
    if ((await turn) !== "done") return;
    for (let i = 0; i < READ_ATTEMPTS && !signal.aborted; i++) {
      if (await api.skillsRecord(sessionId, cwd, prompt)) return;
      await sleep(READ_RETRY_MS);
    }
  } finally {
    clearTimeout(timer);
  }
}

