// Messages entre conversations (voir GLOSSARY.md, « Message entre conversations » et « Nom de
// messagerie », ADR 0002 et src-tauri/src/messages.rs) : l'app les lit dans les `.jsonl`,
// elle ne les transporte pas.
//
// - useHubThread(hub)           fil d'un hub (Vue Hub), relu quand un membre écrit
// - useMessagingDirectory()     noms de messagerie connus (en cours et déjà vus)
// - resolvePeer(names, …)       conversation qui portait un nom au moment d'un message
// - ConversationLinks           titres et ouverture des conversations (fournis par App.tsx)

import { createContext, useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Hub } from "./api";

/** Un nom de messagerie (ou `local_<uuid>` de Claude Desktop) porté par une conversation à partir d'un moment. */
export interface NameUse {
  name: string;
  sessionId: string;
  /** ms depuis l'époque Unix (0 : inconnu). */
  since: number;
}

/** Une extrémité d'un message du fil d'un hub. */
export interface HubPeer {
  /** Conversation, si elle est connue. */
  conversationId: string | null;
  /** Nom brut à afficher sinon (nom de messagerie, `local_<uuid>`, nom donné par l'expéditeur). */
  name: string;
}

/** Un message du fil d'un hub (un envoi et sa réception ne font qu'un). */
export interface HubMessage {
  from: HubPeer;
  to: HubPeer;
  summary: string | null;
  text: string;
  timestamp: string | null;
}

export const messagesApi = {
  /** Fil des messages entre les conversations d'un hub, dans l'ordre chronologique. */
  hubMessages: (hubId: string) => invoke<HubMessage[]>("hub_messages", { hubId }),
  /** Noms de messagerie connus. */
  messagingDirectory: () => invoke<NameUse[]>("messaging_directory"),
  /** Nom de messagerie actuel d'une conversation, null si elle ne tourne pas. */
  messagingName: (sessionId: string) => invoke<string | null>("messaging_name", { sessionId }),
};

/**
 * Conversation qui portait ce nom au moment du message (même règle que `messages::resolve`) :
 * la plus récente à l'avoir pris avant ce moment, sinon la première à l'avoir pris.
 */
export function resolvePeer(names: readonly NameUse[], peer: string, timestamp: string | null): string | null {
  const at = timestamp ? Date.parse(timestamp) : NaN;
  const candidates = names.filter((n) => n.name === peer);
  if (candidates.length === 0) return null;
  const before = candidates.filter((n) => Number.isNaN(at) || n.since <= at);
  const pick = before.length ? before.reduce((a, b) => (b.since > a.since ? b : a)) : candidates.reduce((a, b) => (b.since < a.since ? b : a));
  return pick.sessionId;
}

// ---- Noms de messagerie (partagés, lus seulement quand un message est affiché) -----------

let directory: NameUse[] = [];
const subscribers = new Set<() => void>();
let stopListening: (() => void) | null = null;

function fetchDirectory() {
  messagesApi
    .messagingDirectory()
    .then((d) => {
      directory = d;
      subscribers.forEach((f) => f());
    })
    .catch(() => {});
}

function subscribe(f: () => void) {
  subscribers.add(f);
  if (subscribers.size === 1) {
    fetchDirectory();
    // Une conversation lancée ou relancée prend un nouveau nom : relu avec les conversations.
    const unlisten = listen("sessions-changed", fetchDirectory);
    stopListening = () => void unlisten.then((u) => u());
  }
  return () => {
    subscribers.delete(f);
    if (subscribers.size === 0) {
      stopListening?.();
      stopListening = null;
    }
  };
}

/** Noms de messagerie connus, mis à jour quand les conversations changent. */
export function useMessagingDirectory(): readonly NameUse[] {
  return useSyncExternalStore(subscribe, () => directory);
}

// ---- Fil d'un hub --------------------------------------------------------------------------

/** Filet de sécurité si un évènement de changement est manqué. */
const HUB_POLL_MS = 15_000;
/** Regroupe les écritures en rafale d'un membre actif. */
const HUB_DEBOUNCE_MS = 400;

/**
 * Fil des messages d'un hub, relu quand un de ses membres écrit dans son `.jsonl` (le backend
 * ne relit que les fichiers modifiés). `null` : pas encore lu.
 */
export function useHubThread(hub: Hub | null): HubMessage[] | null {
  const [thread, setThread] = useState<HubMessage[] | null>(null);
  const hubId = hub?.id ?? null;
  const memberKey = hub ? hub.members.map((m) => m.conversationId).join(",") : "";

  useEffect(() => {
    setThread(null);
    if (!hubId) return;
    const members = new Set(memberKey.split(",").filter(Boolean));
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pull = () => {
      messagesApi
        .hubMessages(hubId)
        .then((t) => !disposed && setThread(t))
        .catch(() => !disposed && setThread((x) => x ?? []));
    };
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(pull, HUB_DEBOUNCE_MS);
    };
    pull();
    const unlisten = listen<string>("conversation-changed", (e) => {
      if (members.has(e.payload)) later();
    });
    const poll = setInterval(pull, HUB_POLL_MS);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      unlisten.then((u) => u());
    };
  }, [hubId, memberKey]);

  return thread;
}

// ---- Liens vers les conversations ----------------------------------------------------------

/** Titres et ouverture des conversations, pour les bulles « Message de … » / « Message à … ». */
export interface ConversationLinks {
  /** Titre d'une conversation (projet ou archives), null si inconnue. */
  titleOf: (id: string) => string | null;
  /** Ouvre une conversation (onglet, ou archives). */
  open: (id: string) => void;
}

export const ConversationLinksContext = createContext<ConversationLinks | null>(null);

/** Libellé court d'un message : son résumé, sinon le début de sa première ligne. */
export function messageHeadline(m: { summary: string | null; text: string }, max = 120): string {
  const first = (m.summary ?? m.text).trim().split(/\r?\n/)[0] ?? "";
  return first.length > max ? first.slice(0, max - 1) + "…" : first;
}
