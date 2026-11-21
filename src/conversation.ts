// Interface de conversation (ticket 05) : lecture du `.jsonl` affiché en direct et envoi
// des messages au terminal intégré.
//
// - useConversation(id, cwd)   éléments de la conversation, relus en direct (seule la fin
//                              du fichier est relue à chaque changement, voir conversation.rs)
// - sendMessage(key, texte)    envoie un message au terminal (collage encadré puis Entrée)
// - sendInterrupt(key)         Échap : interrompt l'agent, comme dans Claude Code

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ptyApi } from "./pty";

export interface DiffLine {
  /** " " inchangée, "-" retirée, "+" ajoutée, "~" séparation entre deux modifications. */
  op: " " | "-" | "+" | "~";
  text: string;
}

/** Élément affiché de la conversation (voir `conversation::Entry` côté Rust). */
export type ConversationEntry =
  | { kind: "user"; line: number; uuid: string | null; text: string; command: boolean }
  | { kind: "assistant"; line: number; uuid: string | null; text: string }
  | {
      kind: "tool";
      line: number;
      uuid: string | null;
      id: string;
      name: string;
      title: string;
      detail: string | null;
      path: string | null;
      diff: DiffLine[] | null;
      diffTruncated: boolean;
    }
  | { kind: "toolResult"; line: number; toolUseId: string; text: string; isError: boolean; truncated: boolean }
  | { kind: "notice"; line: number; uuid: string | null; text: string };

interface Chunk {
  exists: boolean;
  reset: boolean;
  headSkipped: boolean;
  entries: ConversationEntry[];
  offset: number;
  line: number;
}

export const conversationApi = {
  read: (sessionId: string, cwd: string | null, offset: number, line: number) =>
    invoke<Chunk>("conversation_read", { sessionId, cwd, offset, line }),
};

export interface ConversationData {
  entries: ConversationEntry[];
  /** null : pas encore lu ; false : pas encore de fichier (nouvelle conversation). */
  exists: boolean | null;
  /** Gros fichier : seule la fin est affichée. */
  headSkipped: boolean;
}

/** Filet de sécurité si un évènement de changement est manqué (relecture de la fin seulement). */
const POLL_MS = 3000;

/** Conversation lue dans son `.jsonl`, mise à jour à chaque écriture de Claude Code. */
export function useConversation(sessionId: string, cwd: string | null): ConversationData {
  const [data, setData] = useState<ConversationData>({ entries: [], exists: null, headSkipped: false });

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let again = false;
    let offset = 0;
    let line = 0;

    /** Lit la suite du fichier ; une demande pendant une lecture relance une lecture après. */
    const pull = async () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          const c = await conversationApi.read(sessionId, cwd, offset, line);
          if (disposed) return;
          const fresh = c.reset || offset === 0;
          const unchanged = !fresh && c.entries.length === 0;
          offset = c.offset;
          line = c.line;
          setData((d) =>
            unchanged && d.exists === c.exists
              ? d
              : {
                  exists: c.exists,
                  headSkipped: fresh ? c.headSkipped : d.headSkipped,
                  entries: fresh ? c.entries : c.entries.length ? [...d.entries, ...c.entries] : d.entries,
                },
          );
        } while (again && !disposed);
      } catch {
        /* fichier momentanément illisible : la prochaine lecture réessaiera */
      } finally {
        busy = false;
      }
    };

    pull();
    const unlisten = listen<string>("conversation-changed", (e) => {
      if (e.payload === sessionId) pull();
    });
    const timer = setInterval(pull, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
      unlisten.then((f) => f());
    };
  }, [sessionId, cwd]);

  return data;
}

/** Délai entre le collage et l'Entrée, pour que Claude Code ait fini de traiter le collage. */
const ENTER_DELAY_MS = 60;

/**
 * Envoie un message au terminal. Le texte est collé (« bracketed paste », ESC[200~ … ESC[201~)
 * pour qu'un texte sur plusieurs lignes arrive en un seul message, puis Entrée. Une commande
 * `/…` est tapée telle quelle (son menu ou son autocomplétion fonctionnent comme au clavier).
 */
export async function sendMessage(key: string, text: string): Promise<void> {
  const isCommand = text.startsWith("/");
  await ptyApi.write(key, isCommand ? text : `\x1b[200~${text.replace(/\r\n?/g, "\n")}\x1b[201~`);
  await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
  await ptyApi.write(key, "\r");
}

/** Échap : interrompt l'agent (comme la touche Échap dans Claude Code). */
export function sendInterrupt(key: string): Promise<void> {
  return ptyApi.write(key, "\x1b");
}
