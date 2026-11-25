// Traduction de l'interface par Claude (`claude -p`, abonnement de l'utilisateur, voir
// src-tauri/src/languages.rs) et langues enregistrées.
//
// - identifyLanguage(texte)        « anglais », « English », « en » → { code: "en", name: "English" },
//                                  ou erreur « Langue inconnue »
// - startTranslation(code, name)   traduit les textes manquants ou modifiés, par lots, en
//                                  arrière-plan ; enregistré après chaque lot (une traduction
//                                  interrompue reprend où elle s'était arrêtée)
// - cancelTranslation()            arrête la traduction en cours
// - useTranslationJob()            avancement (composants React)
// - applyLanguage(code)            charge une langue enregistrée et l'affiche (null : français)
// - pendingCount(code)             textes encore à traduire pour une langue enregistrée
//
// Fichier d'une langue : `{ code, name, entries: { clé: { text, hash } } }`. `hash` est
// l'empreinte du texte français traduit : quand une nouvelle version de l'app modifie un
// texte, son empreinte change et seul ce texte est retraduit ; en attendant, il s'affiche
// en français. Une traduction dont les variables diffèrent du français est écartée (le
// texte reste en français).

import { useSyncExternalStore } from "react";
import { api, errorMessage } from "../api";
import { FR, SOURCE_LANGUAGE, currentLanguage, format, setLanguage, t, variablesOf, type MessageKey } from "./index";
import glossary from "../../GLOSSARY.md?raw";

/** Modèle des traductions : les textes d'interface ont des variables à ne pas casser. */
const MODEL = "sonnet";
/** Textes par appel, et appels en parallèle. */
const BATCH_SIZE = 70;
const PARALLEL = 3;

export interface LanguageFile {
  code: string;
  name: string;
  entries: Record<string, { text: string; hash: string }>;
}

/** Empreinte d'un texte (FNV-1a 32 bits) : suffit à repérer un texte modifié. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Code BCP 47 simple (mêmes règles que `valid_code` dans languages.rs). */
export const validCode = (code: string) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code);

/** Clés à (re)traduire : absentes du fichier, ou traduites d'un texte français qui a changé. */
export function pendingKeys(file: LanguageFile | null): MessageKey[] {
  return (Object.keys(FR) as MessageKey[]).filter((k) => file?.entries[k]?.hash !== hashText(FR[k]));
}

/** Textes traduits à jour (les autres s'affichent en français). */
export function upToDate(file: LanguageFile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, e] of Object.entries(file.entries)) if (k in FR && e.hash === hashText(FR[k as MessageKey])) out[k] = e.text;
  return out;
}

/**
 * Traduction acceptable : mêmes variables que le français, et le texte se met en forme
 * (accolades équilibrées, pluriels et choix lisibles).
 */
export function validTranslation(source: string, translated: string): boolean {
  if (typeof translated !== "string" || !translated.trim()) return false;
  try {
    const a = variablesOf(source);
    const b = variablesOf(translated);
    if (a.size !== b.size || [...a].some((v) => !b.has(v))) return false;
    format(translated, Object.fromEntries([...a].map((v) => [v, 1])));
    return true;
  } catch {
    return false;
  }
}

/** Premier objet JSON d'une réponse (Claude peut l'entourer d'un bloc de code). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

async function readFile(code: string): Promise<LanguageFile | null> {
  const v = (await api.languageRead(code)) as LanguageFile | null;
  return v && typeof v === "object" && v.entries ? v : null;
}

// ---- Langue affichée -------------------------------------------------------------------

/** Charge et affiche une langue enregistrée (`null` ou absente : français). */
export async function applyLanguage(code: string | null | undefined): Promise<void> {
  if (!code || code === SOURCE_LANGUAGE) {
    setLanguage(SOURCE_LANGUAGE);
    return;
  }
  const file = await readFile(code).catch(() => null);
  setLanguage(code, file ? upToDate(file) : {});
}

/** Textes encore à traduire pour une langue enregistrée. */
export async function pendingCount(code: string): Promise<number> {
  return pendingKeys(await readFile(code).catch(() => null)).length;
}

// ---- Identification de la langue -------------------------------------------------------

export const IDENTIFY_SYSTEM = `You identify human languages for a translation tool. The user message is what someone typed to name a language (in any language, possibly a code or with typos). Answer with a single JSON object and nothing else:
- if it names a real human language (or a regional variant) that a user interface can be written in: {"language": true, "code": "<BCP 47 code, e.g. en, pt-BR, zh-Hant>", "name": "<the language's name written in that language itself, e.g. English, Português (Brasil), 中文（繁體）>"}
- otherwise: {"language": false}. This includes languages invented for fiction or games (Klingon, Elvish/Sindarin, Dothraki, Na'vi…) even if they have a code, unknown names, things that are not languages, and gibberish. Constructed languages with a real community of speakers (Esperanto) count as real.`;

/** « anglais » → { code: "en", name: "English" }. Erreur lisible si ce n'est pas une langue. */
export async function identifyLanguage(input: string, job = "identify-" + Date.now()): Promise<{ code: string; name: string }> {
  const answer = await api.claudeAsk(job, MODEL, IDENTIFY_SYSTEM, input.trim());
  let v: { language?: boolean; code?: string; name?: string };
  try {
    v = extractJson(answer) as typeof v;
  } catch {
    throw new Error(tUnknown());
  }
  if (!v.language || !v.code || !validCode(v.code) || !v.name) throw new Error(tUnknown());
  return { code: v.code, name: v.name };
}

const tUnknown = () => t("settings.language.unknown");

// ---- Traduction ------------------------------------------------------------------------

export function translateSystem(code: string, name: string): string {
  return `You translate the user interface of Claude Manager, a desktop client for Claude Code (Anthropic's coding agent), from French into ${name} (${code}).

The user message is a JSON object: interface text key → French text. Answer with a single JSON object with exactly the same keys, each mapped to its translation, and nothing else (no comments, no code block).

Rules:
- Texts use ICU MessageFormat. Keep every variable {name} exactly as is (same name, never translated). In {x, plural, ...} and {x, select, ...}, keep the variable name, the keyword (plural/select) and the selectors (one, other, =0, and select values like yes, exists, elsewhere) unchanged; translate only the text inside the branches; keep # (the number). You may add the plural categories ${name} needs (zero, two, few, many) next to one/other.
- Keep line breaks (\\n), ellipses (…), emoji, keyboard keys and shortcuts, slash commands (/model…), file paths, code and tool names (SendMessage, TodoWrite) as they are. Use the target language's own quotation marks instead of « ».
- Keep product names: Claude, Claude Code, Claude Desktop, Claude Manager, Opus, Sonnet, Haiku. Keep these app terms untranslated: Hub, Hand off, Worktree.
- Translate every other app term consistently, using the glossary below to understand what it means. Short, natural interface wording; same tone as the French (informal "tu"/"toi" becomes the target language's usual informal or neutral interface tone).

Glossary of the app (French):
${glossary}`;
}

export type TranslationJob = {
  code: string;
  name: string;
  done: number;
  total: number;
  /** null : en cours ; sinon terminée (avec une erreur éventuelle). */
  finished: null | { error: string | null; cancelled: boolean };
};

let job: TranslationJob | null = null;
const running = new Set<string>();
let cancelled = false;
const listeners = new Set<() => void>();
const publish = (j: TranslationJob | null) => {
  job = j;
  listeners.forEach((f) => f());
};

/** Avancement de la traduction en cours (ou de la dernière terminée), null s'il n'y en a pas eu. */
export function useTranslationJob(): TranslationJob | null {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => job,
  );
}

export const translationRunning = () => job !== null && job.finished === null;

/** Avancement (hors React). */
export const getTranslationJob = () => job;

/** Arrête la traduction en cours (les lots déjà traduits restent enregistrés). */
export function cancelTranslation() {
  cancelled = true;
  for (const id of running) api.claudeCancel(id).catch(() => {});
}

/** Oublie une traduction terminée (bandeau d'avancement refermé). */
export function clearTranslationJob() {
  if (!translationRunning()) publish(null);
}

/**
 * Traduit les textes manquants ou modifiés de `code` (créé s'il n'existe pas) et les
 * enregistre lot par lot ; si c'est la langue affichée, ses nouveaux textes apparaissent
 * au fur et à mesure. Une seule traduction à la fois.
 */
export async function startTranslation(code: string, name: string): Promise<void> {
  if (translationRunning()) return;
  cancelled = false;
  const file: LanguageFile = (await readFile(code).catch(() => null)) ?? { code, name, entries: {} };
  file.name = file.name || name;
  const keys = pendingKeys(file);
  const batches: MessageKey[][] = [];
  for (let i = 0; i < keys.length; i += BATCH_SIZE) batches.push(keys.slice(i, i + BATCH_SIZE));
  publish({ code, name: file.name, done: 0, total: keys.length, finished: null });
  // Fichier créé tout de suite : la langue apparaît dans la liste même si on annule.
  await api.languageWrite(code, file).catch(() => {});

  const system = translateSystem(code, file.name);
  let error: string | null = null;
  let done = 0;
  // Écritures du fichier l'une après l'autre (les lots finissent dans le désordre).
  let saving = Promise.resolve();

  const runBatch = async (batch: MessageKey[], n: number) => {
    const id = `translate-${code}-${n}-${Date.now()}`;
    running.add(id);
    try {
      const source = Object.fromEntries(batch.map((k) => [k, FR[k]]));
      const answer = await api.claudeAsk(id, MODEL, system, JSON.stringify(source, null, 1));
      const out = extractJson(answer) as Record<string, string>;
      for (const k of batch) {
        if (validTranslation(FR[k], out[k])) file.entries[k] = { text: out[k], hash: hashText(FR[k]) };
      }
      done += batch.length;
      saving = saving
        .then(() => api.languageWrite(code, file))
        .then(() => {
          if (currentLanguage() === code) setLanguage(code, upToDate(file));
        });
      await saving;
      if (job) publish({ ...job, done });
    } finally {
      running.delete(id);
    }
  };

  const queue = batches.map((b, i) => [b, i] as const);
  const worker = async () => {
    while (queue.length && !cancelled && !error) {
      const [batch, n] = queue.shift()!;
      try {
        await runBatch(batch, n);
      } catch (e) {
        if (!cancelled) error = e instanceof SyntaxError || (e as Error).message === "no JSON" ? t("settings.language.badAnswer") : errorMessage(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
  publish({ code, name: file.name, done, total: keys.length, finished: { error, cancelled } });
}
