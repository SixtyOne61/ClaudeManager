// État des conversations (voir src-tauri/src/activity.rs et GLOSSARY.md, « État »).
// Les hooks de Claude Code écrivent l'état brut (running / waiting + kind), le backend
// l'émet ici ; l'interface l'affiche selon quatre états :
// - en cours        l'agent travaille (vert qui pulse) ;
// - action requise  une permission ou une question attend (orange), ou une erreur d'API a
//                   interrompu le tour (rouge, comptée avec les actions requises) ;
// - à toi           l'agent a fini son tour et attend le prochain message (bleu discret) ;
// - fermée          aucun terminal intégré ne tourne (pas de pastille).
//
// - useActivities()               états de toutes les conversations (composants React)
// - getActivity(id)               état actuel d'une conversation (null = fermée)
// - subscribeActivity(id, f)      appelé à chaque changement d'état de cette conversation
// - activityDisplay(a)            "running" | "action" | "yours" | "closed", pour l'affichage
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

/** Conversations dont le terminal intégré tourne (les autres sont fermées). */
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

/** État actuel d'une conversation ; null : fermée (pas de terminal intégré qui tourne). */
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

/** État affiché : en cours, action requise, à toi, fermée. */
export type ActivityDisplay = "running" | "action" | "yours" | "closed";

export function activityDisplay(a: Activity | null | undefined): ActivityDisplay {
  if (!a || a.state === "ended") return "closed";
  if (a.state === "running") return "running";
  // Permission, question ou erreur d'API : l'utilisateur doit intervenir.
  if (a.kind === "permission" || a.kind === "question" || a.kind === "error") return "action";
  // Fin de tour, lancement, notification d'inactivité : l'agent attend le prochain message.
  return "yours";
}

/** L'agent attend une permission ou la réponse à une question (pas une simple fin de tour). */
export function isAwaitingPermission(a: Activity | null | undefined): boolean {
  return a?.state === "waiting" && (a.kind === "permission" || a.kind === "question");
}

/** Libellé de l'état, pour les info-bulles. */
export function activityLabel(a: Activity | null | undefined): string {
  const d = activityDisplay(a);
  if (!a || d === "closed") return "Fermée";
  if (d === "running") return "En cours";
  if (d === "yours") return "À toi : Claude attend ton prochain message";
  switch (a.kind) {
    case "permission":
      return "Action requise : permission demandée";
    case "question":
      return "Action requise : question posée";
    default:
      return "Action requise : erreur" + (a.detail ? ` (${a.detail})` : "") + ", relance ton message";
  }
}

/** Compteurs d'un projet ou d'une catégorie (« à toi » n'est pas compté). */
export interface ActivityCount {
  running: number;
  action: number;
}

/** Nombre de conversations en cours et avec une action requise parmi `ids`. */
export function countActivities(activities: ReadonlyMap<string, Activity>, ids: Iterable<string>): ActivityCount {
  let running = 0;
  let action = 0;
  for (const id of ids) {
    const d = activityDisplay(activities.get(id));
    if (d === "running") running++;
    else if (d === "action") action++;
  }
  return { running, action };
}
