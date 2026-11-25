// Hand off (voir GLOSSARY.md, « Hand off », et src-tauri/src/handoff.rs) : une conversation
// dont le contexte est trop rempli passe le relais à une nouvelle conversation du même projet,
// qui démarre avec un résumé de passation écrit par l'ancienne. Tout part d'un clic de
// l'utilisateur (ADR 0002) ; l'app tape seulement des messages, elle ne répond jamais à une
// permission.
//
// Déroulé (conduit par App.tsx) :
// 1. requestSummary()        tape la consigne dans le terminal de la parente, attend la fin du
//                            tour et lit sa réponse dans le `.jsonl` (handoff_summary) ;
// 2. la suite est créée dans le même dossier, puis sendWhenReady() lui tape son premier
//    message dès que Claude Code a démarré ;
// 3. api.handoffFinish()     section et couleur de la parente pour la suite, lien
//                            parente → suite, archivage de la parente.
//
// - useHandoffBlocker(id)    raison pour laquelle Hand off est grisé (null : disponible)
// - useHandoffState(id)      hand off en cours pour cette conversation (bandeau, Annuler)
// - cancelHandoff(id)        « Annuler » pendant la rédaction du résumé
// - handoffPrompt(cfg)       consigne du résumé de passation (réglages, ou texte par défaut)
// - successorOf / parentOf   lien parente → suite enregistré dans config.json

import { useSyncExternalStore } from "react";
import { api, errorMessage, type Config, type HandoffSummary } from "./api";
import { activityDisplay, getActivity, subscribeActivity, useActivities, type Activity } from "./activity";
import { sendInterrupt, sendMessage } from "./conversation";
import { t } from "./i18n";

/** Consigne par défaut du résumé de passation (modifiable dans les réglages). Envoyée à la
 *  conversation : non traduite. */
export const DEFAULT_HANDOFF_PROMPT =
  "Rédige un résumé de passation pour une nouvelle conversation qui reprendra ce travail sans voir celle-ci : objectif, état actuel, décisions prises et pourquoi, fichiers touchés, points en suspens, prochaines étapes. Réponds uniquement par ce résumé, en Markdown.";

/** Explication du bouton Hand off grisé. */
export const handoffUnavailable = () => t("handoff.blocker.unavailable");

/** Consigne du résumé de passation : celle des réglages, sinon le texte par défaut. */
export function handoffPrompt(cfg: Config): string {
  return cfg.handoffPrompt?.trim() || DEFAULT_HANDOFF_PROMPT;
}

/** Change la consigne (null, vide ou texte par défaut : retour au texte par défaut). */
export function setHandoffPrompt(cfg: Config, text: string | null): Config {
  const trimmed = text?.trim();
  return { ...cfg, handoffPrompt: trimmed && trimmed !== DEFAULT_HANDOFF_PROMPT ? trimmed : null };
}

/** Suite d'une conversation, si elle a passé le relais. */
export function successorOf(cfg: Config, parentId: string): string | null {
  return cfg.handoffLinks?.[parentId]?.successorId ?? null;
}

/** Parente et suite d'une conversation, avec leur titre, pour les liens de l'interface. */
export interface HandoffLineage {
  parent: { id: string; title: string } | null;
  successor: { id: string; title: string } | null;
}

/** Parente d'une conversation, si elle est la suite d'un hand off. */
export function parentOf(cfg: Config, successorId: string): string | null {
  for (const [parent, link] of Object.entries(cfg.handoffLinks ?? {})) if (link.successorId === successorId) return parent;
  return null;
}

// ---- Hand off en cours -----------------------------------------------------------------

/** Étape d'un hand off en cours : rédaction du résumé (annulable), puis création de la suite. */
export type HandoffPhase = "summary" | "creating";

interface Running {
  phase: HandoffPhase;
  abort: AbortController;
}

let running: ReadonlyMap<string, Running> = new Map();
const listeners = new Set<() => void>();

function setRunning(sessionId: string, r: Running | null) {
  const next = new Map(running);
  if (r) next.set(sessionId, r);
  else next.delete(sessionId);
  running = next;
  listeners.forEach((f) => f());
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/** Étape du hand off en cours pour cette conversation, ou null. */
export function useHandoffState(sessionId: string): HandoffPhase | null {
  return useSyncExternalStore(subscribe, () => running.get(sessionId)?.phase ?? null);
}

export function isHandoffRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

/** Passe le hand off à l'étape suivante (création de la suite : il n'est plus annulable). */
export function markHandoffCreating(sessionId: string) {
  const r = running.get(sessionId);
  if (r) setRunning(sessionId, { ...r, phase: "creating" });
}

/** Fin du hand off (réussi, annulé ou en échec). */
export function endHandoff(sessionId: string) {
  setRunning(sessionId, null);
}

/** « Annuler » pendant la rédaction du résumé : rien n'est créé ni archivé. */
export function cancelHandoff(sessionId: string) {
  const r = running.get(sessionId);
  if (r?.phase === "summary") r.abort.abort();
}

/** Raison pour laquelle Hand off est indisponible (null : disponible). */
export function handoffBlocker(a: Activity | null | undefined, phase: HandoffPhase | null): string | null {
  if (phase) return t("handoff.blocker.running");
  // « À toi » : fin de tour, ou conversation démarrée (mais pas juste lancée : Claude Code
  // n'a peut-être pas encore fini de démarrer).
  if (activityDisplay(a) !== "yours" || (a?.kind === "start" && a.event === "Launch")) return handoffUnavailable();
  return null;
}

/** Comme handoffBlocker, mis à jour à chaque changement d'état (composants React). */
export function useHandoffBlocker(sessionId: string): string | null {
  const activity = useActivities().get(sessionId);
  return handoffBlocker(activity, useHandoffState(sessionId));
}

// ---- Étapes -------------------------------------------------------------------------------

export type SummaryResult = { kind: "ok"; summary: HandoffSummary } | { kind: "cancelled" } | { kind: "failed"; message: string };

/** Relectures du `.jsonl` après la fin du tour (la dernière ligne peut arriver juste après). */
const READ_ATTEMPTS = 5;
const READ_RETRY_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Attend la fin du tour lancé par la consigne : l'agent passe « en cours », puis « à toi ».
 * Une permission ou une question en cours de route se règle dans le terminal, comme d'habitude.
 */
function waitForTurnEnd(sessionId: string, signal: AbortSignal): Promise<"done" | "error" | "closed" | "cancelled"> {
  return new Promise((resolve) => {
    let started = false;
    let unsubscribe = () => {};
    const finish = (r: "done" | "error" | "closed" | "cancelled") => {
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = () => finish("cancelled");
    unsubscribe = subscribeActivity(sessionId, (a) => {
      if (!a) return finish("closed");
      if (a.state === "running") started = true;
      else if (started && a.kind === "error") finish("error");
      else if (started && a.kind === "turn") finish("done");
    });
    signal.addEventListener("abort", onAbort);
  });
}

/**
 * Étape 1 : tape la consigne dans le terminal de la parente, attend la fin du tour et lit
 * sa réponse. Marque le hand off comme en cours (il le reste jusqu'à `endHandoff`, sauf
 * annulation ou échec ici).
 */
export async function requestSummary(sessionId: string, cwd: string | null, prompt: string, parentTitle: string): Promise<SummaryResult> {
  if (running.has(sessionId)) return { kind: "cancelled" };
  const abort = new AbortController();
  setRunning(sessionId, { phase: "summary", abort });
  const fail = (message: string): SummaryResult => {
    endHandoff(sessionId);
    return { kind: "failed", message };
  };
  // Abonnement avant l'envoi : le passage « en cours » ne doit pas être manqué.
  const turn = waitForTurnEnd(sessionId, abort.signal);
  try {
    await sendMessage(sessionId, prompt);
  } catch (e) {
    abort.abort();
    return fail(t("handoff.failed.impossible", { error: errorMessage(e) }));
  }
  const outcome = await turn;
  if (outcome === "cancelled") {
    // L'agent rédigeait encore : on l'arrête, comme la touche Échap.
    if (getActivity(sessionId)?.state === "running") sendInterrupt(sessionId).catch(() => {});
    endHandoff(sessionId);
    return { kind: "cancelled" };
  }
  if (outcome === "closed") return fail(t("handoff.failed.terminalClosed"));
  if (outcome === "error") return fail(t("handoff.failed.turnError"));
  for (let i = 0; i < READ_ATTEMPTS; i++) {
    if (abort.signal.aborted) {
      endHandoff(sessionId);
      return { kind: "cancelled" };
    }
    try {
      const summary = await api.handoffSummary(sessionId, cwd, prompt, parentTitle);
      if (summary) {
        markHandoffCreating(sessionId);
        return { kind: "ok", summary };
      }
    } catch (e) {
      return fail(t("handoff.failed.impossible", { error: errorMessage(e) }));
    }
    await sleep(READ_RETRY_MS);
  }
  return fail(t("handoff.failed.emptySummary"));
}

/** Délai maximal de démarrage de Claude Code dans la suite. */
const READY_TIMEOUT_MS = 90_000;
/** Après le démarrage, petit délai pour que la zone de saisie de Claude Code soit prête. */
const READY_DELAY_MS = 800;

/**
 * Étape 2 : tape le premier message de la suite dès que Claude Code y a démarré (hook
 * `SessionStart`). Renvoie false si le terminal s'est fermé ou n'a pas démarré à temps.
 */
export function sendWhenReady(sessionId: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let seen = false;
    let done = false;
    let unsubscribe = () => {};
    const finish = async (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      if (!ok) return resolve(false);
      await sleep(READY_DELAY_MS);
      try {
        await sendMessage(sessionId, text);
        resolve(true);
      } catch {
        resolve(false);
      }
    };
    const check = (a: Activity | null) => {
      if (a) seen = true;
      if (a?.kind === "start" && a.event !== "Launch") finish(true);
      else if (!a && seen) finish(false);
    };
    const timer = setTimeout(() => finish(false), READY_TIMEOUT_MS);
    unsubscribe = subscribeActivity(sessionId, check);
    check(getActivity(sessionId));
  });
}
