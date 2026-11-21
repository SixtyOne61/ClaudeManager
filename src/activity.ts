// État des conversations (voir src-tauri/src/activity.rs) : en cours, attend ta réponse,
// terminée. Les hooks de Claude Code écrivent l'état, le backend l'émet ici.
//
// - useActivities()               états de toutes les conversations (composants React)
// - getActivity(id)               état actuel d'une conversation (null = terminée)
// - subscribeActivity(id, f)      appelé à chaque changement d'état de cette conversation
// - activityStatus(a)             "running" | "waiting" | "ended", pour l'affichage
// - isAwaitingPermission(a)       l'agent attend une permission ou la réponse à une question
//                                 (pour faire remonter le terminal, ticket 05)

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ActivityState = "running" | "waiting" | "ended";

/** Raison précise de l'état (évènement de hook d'origine résumé). */
export type ActivityKind =
  | "prompt" // message envoyé
  | "tool" // outil en cours
  | "permission" // demande de permission
  | "question" // question posée à l'utilisateur (AskUserQuestion, formulaire MCP)
  | "turn" // fin de tour
  | "error" // tour interrompu par une erreur d'API
  | "start" // conversation lancée ou reprise
  | "end"; // session terminée

export interface Activity {
  sessionId: string;
  state: ActivityState;
  kind: ActivityKind;
  /** Évènement de hook (`PreToolUse`, `Notification`…) ou `Launch`. */
  event: string;
  /** Type de notification, nom de l'outil, type d'erreur ou raison de fin. */
  detail?: string | null;
  /** Millisecondes depuis 1970. */
  at: number;
}

/** Conversations dont le terminal intégré tourne (les autres sont terminées). */
let store: ReadonlyMap<string, Activity> = new Map();
const listeners = new Set<() => void>();
const perSession = new Map<string, Set<(a: Activity | null) => void>>();
let started = false;

function set(sessionId: string, a: Activity | null) {
  const next = new Map(store);
  if (a && a.state !== "ended") next.set(sessionId, a);
  else next.delete(sessionId);
  store = next;
  listeners.forEach((f) => f());
  perSession.get(sessionId)?.forEach((f) => f(a && a.state !== "ended" ? a : null));
}

function ensureStarted() {
  if (started) return;
  started = true;
  listen<{ sessionId: string; activity: Activity | null }>("conversation-activity", (e) => set(e.payload.sessionId, e.payload.activity));
  // État initial (rechargement de la fenêtre alors que des terminaux tournent).
  invoke<Activity[]>("activity_list")
    .then((list) => list.forEach((a) => !store.has(a.sessionId) && set(a.sessionId, a)))
    .catch(() => {});
}

function subscribeAll(f: () => void) {
  ensureStarted();
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/** États de toutes les conversations actives ; le composant se redessine à chaque changement. */
export function useActivities(): ReadonlyMap<string, Activity> {
  return useSyncExternalStore(subscribeAll, () => store);
}

/** État actuel d'une conversation ; null : terminée (pas de terminal intégré qui tourne). */
export function getActivity(sessionId: string): Activity | null {
  ensureStarted();
  return store.get(sessionId) ?? null;
}

/** Appelé à chaque changement d'état de la conversation. Renvoie la fonction de désabonnement. */
export function subscribeActivity(sessionId: string, f: (a: Activity | null) => void): () => void {
  ensureStarted();
  let subs = perSession.get(sessionId);
  if (!subs) perSession.set(sessionId, (subs = new Set()));
  subs.add(f);
  return () => {
    subs.delete(f);
    if (subs.size === 0) perSession.delete(sessionId);
  };
}

/** États de toutes les conversations actives (hors React). */
export function getActivities(): ReadonlyMap<string, Activity> {
  ensureStarted();
  return store;
}

/**
 * Ce que fermer la conversation interromprait, ou null s'il n'y a rien à interrompre
 * (l'agent a fini son tour et attend simplement un message).
 */
export function interruptionWarning(a: Activity | null | undefined): string | null {
  if (a?.state === "running") return "L'agent est en train de travailler : fermer l'arrêtera en cours de route.";
  if (isAwaitingPermission(a)) return "Une action attend ta permission : fermer l'annulera.";
  return null;
}

export function activityStatus(a: Activity | null | undefined): ActivityState {
  return a?.state ?? "ended";
}

/** L'agent attend une permission ou la réponse à une question (pas une simple fin de tour). */
export function isAwaitingPermission(a: Activity | null | undefined): boolean {
  return a?.state === "waiting" && (a.kind === "permission" || a.kind === "question");
}

/** Libellé de l'état, pour les info-bulles. */
export function activityLabel(a: Activity | null | undefined): string {
  if (!a || a.state === "ended") return "Terminée";
  if (a.state === "running") return "En cours";
  switch (a.kind) {
    case "permission":
      return "Attend ta réponse : permission demandée";
    case "question":
      return "Attend ta réponse : question posée";
    case "error":
      return "Attend ta réponse : erreur" + (a.detail ? ` (${a.detail})` : "");
    default:
      return "Attend ta réponse";
  }
}

/** Nombre de conversations en cours et en attente de réponse parmi `ids`. */
export function countActivities(activities: ReadonlyMap<string, Activity>, ids: Iterable<string>) {
  let running = 0;
  let waiting = 0;
  for (const id of ids) {
    const s = activities.get(id)?.state;
    if (s === "running") running++;
    else if (s === "waiting") waiting++;
  }
  return { running, waiting };
}
