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

/** Consommation de jetons d'une réponse de l'agent (`message.usage`). */
export interface Usage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

/** Modèle, mode et consommation relevés dans une partie lue (voir `conversation::Meta`). */
export interface ChunkMeta {
  model: string | null;
  modelIdentity: { id: string; name: string | null } | null;
  permissionMode: string | null;
  permissionModeLine: number | null;
  usage: Usage | null;
  outputs: { id: string; tokens: number }[];
}

interface Chunk {
  exists: boolean;
  reset: boolean;
  headSkipped: boolean;
  entries: ConversationEntry[];
  offset: number;
  line: number;
  meta?: ChunkMeta;
}

/** Informations du pied de conversation : dernières valeurs connues. */
export interface ConversationMeta {
  /** Modèle de la dernière réponse (`claude-opus-5-5`). */
  model: string | null;
  /** Dernier modèle annoncé par Claude Code (identifiant avec `[1m]`, nom lisible). */
  modelIdentity: { id: string; name: string | null } | null;
  /** Dernier mode de permission enregistré, et la ligne où il l'a été. */
  permissionMode: string | null;
  permissionModeLine: number | null;
  /** Consommation de la dernière réponse (contexte utilisé). */
  usage: Usage | null;
  /** Somme des jetons produits par les réponses lues. */
  outputTotal: number;
}

const EMPTY_META: ConversationMeta = { model: null, modelIdentity: null, permissionMode: null, permissionModeLine: null, usage: null, outputTotal: 0 };

/** Ajoute à `prev` les valeurs d'une partie lue (`outputs` : jetons produits par message). */
function mergeMeta(prev: ConversationMeta, m: ChunkMeta | undefined, outputs: Map<string, number>): ConversationMeta {
  if (!m) return prev;
  for (const o of m.outputs) outputs.set(o.id, o.tokens);
  let outputTotal = 0;
  for (const n of outputs.values()) outputTotal += n;
  const next: ConversationMeta = {
    model: m.model ?? prev.model,
    modelIdentity: m.modelIdentity ?? prev.modelIdentity,
    permissionMode: m.permissionMode ?? prev.permissionMode,
    permissionModeLine: m.permissionMode ? m.permissionModeLine : prev.permissionModeLine,
    usage: m.usage ?? prev.usage,
    outputTotal,
  };
  const same = (Object.keys(next) as (keyof ConversationMeta)[]).every((k) => next[k] === prev[k]);
  return same ? prev : next;
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
  /** Modèle, mode de permission et consommation (pied de conversation). */
  meta: ConversationMeta;
}

/** Filet de sécurité si un évènement de changement est manqué (relecture de la fin seulement). */
const POLL_MS = 3000;

/** Conversation lue dans son `.jsonl`, mise à jour à chaque écriture de Claude Code. */
export function useConversation(sessionId: string, cwd: string | null): ConversationData {
  const [data, setData] = useState<ConversationData>({ entries: [], exists: null, headSkipped: false, meta: EMPTY_META });

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let again = false;
    let offset = 0;
    let line = 0;
    /** Jetons produits par réponse (identifiant du message), pour la somme. */
    const outputs = new Map<string, number>();

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
          if (fresh) outputs.clear();
          setData((d) => {
            const meta = mergeMeta(fresh ? EMPTY_META : d.meta, c.meta, outputs);
            return unchanged && d.exists === c.exists && meta === d.meta
              ? d
              : {
                  exists: c.exists,
                  headSkipped: fresh ? c.headSkipped : d.headSkipped,
                  entries: fresh ? c.entries : c.entries.length ? [...d.entries, ...c.entries] : d.entries,
                  meta,
                };
          });
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

// ---- Regroupement pour l'affichage -----------------------------------------------------

export type ToolEntry = Extract<ConversationEntry, { kind: "tool" }>;
export type ToolResultEntry = Extract<ConversationEntry, { kind: "toolResult" }>;

/** Une action de l'agent avec son résultat (absent tant que l'outil tourne). */
export interface Action {
  tool: ToolEntry;
  result: ToolResultEntry | undefined;
}

/** Élément d'un tour de Claude : un texte, ou les actions consécutives entre deux textes. */
export type ClaudeItem =
  | { kind: "text"; key: string; entry: Extract<ConversationEntry, { kind: "assistant" }> }
  | { kind: "actions"; key: string; actions: Action[] };

/** Bloc affiché : message de l'utilisateur, notice, ou tour de Claude (textes et actions). */
export type ConversationBlock =
  | { kind: "user"; key: string; entry: Extract<ConversationEntry, { kind: "user" }> }
  | { kind: "notice"; key: string; entry: Extract<ConversationEntry, { kind: "notice" }> }
  | { kind: "claude"; key: string; items: ClaudeItem[] };

/**
 * Regroupe les éléments lus : les réponses et actions de Claude qui se suivent forment un
 * tour, et les actions consécutives (entre deux textes) un seul groupe. Les clés ne dépendent
 * que du premier élément de chaque bloc : elles restent stables quand la suite arrive.
 */
export function groupEntries(entries: ConversationEntry[]): ConversationBlock[] {
  const results = new Map<string, ToolResultEntry>();
  for (const e of entries) if (e.kind === "toolResult") results.set(e.toolUseId, e);

  const blocks: ConversationBlock[] = [];
  let turn: Extract<ConversationBlock, { kind: "claude" }> | null = null;
  entries.forEach((e, i) => {
    const key = `${e.line}:${i}`;
    switch (e.kind) {
      case "user":
      case "notice":
        turn = null;
        blocks.push(e.kind === "user" ? { kind: "user", key, entry: e } : { kind: "notice", key, entry: e });
        break;
      case "assistant":
      case "tool": {
        if (!turn) blocks.push((turn = { kind: "claude", key, items: [] }));
        const last = turn.items[turn.items.length - 1];
        if (e.kind === "assistant") turn.items.push({ kind: "text", key, entry: e });
        else if (last?.kind === "actions") last.actions.push({ tool: e, result: results.get(e.id) });
        else turn.items.push({ kind: "actions", key, actions: [{ tool: e, result: results.get(e.id) }] });
        break;
      }
      default:
        break; // résultats : rattachés à leur appel
    }
  });
  return blocks;
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
