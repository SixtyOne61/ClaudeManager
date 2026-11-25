// Suggestions de bonnes pratiques (voir GLOSSARY.md, « Suggestion », et src-tauri/src/suggestions.rs).
// Le backend détecte les situations (règles pures, testées côté Rust) et émet, à chaque
// changement, le contexte de chaque conversation et les suggestions à afficher. L'interface
// les montre (icône 💡 dans la barre latérale, bandeau dans l'onglet de la conversation) ;
// l'action ne part que sur un clic de l'utilisateur.
//
// - useSuggestions()                  contexte et suggestions (composants React)
// - getSuggestions()                  idem, hors React
// - suggestionsOf(snap, id)           suggestions d'une conversation
// - hasSuggestion(snap, ids)          au moins une suggestion parmi ces conversations
// - SUGGESTION_RULES                  présentation de chaque règle : texte, action, réglage
// - dismissSuggestion(cfg, s)         « Ignorer » (jusqu'au palier suivant), à enregistrer
// - hubSuggestionData(s)              données de la règle « hub » (deux conversations qui ont échangé)
// - noteTyping(id, cfg)               frappe dans une conversation : règle « conversation ancienne »
// - dismissStale / forgetStale        « Ignorer » et fermeture pour cette règle (en mémoire)
// - suggestionSettings(cfg)           réglages, avec leurs valeurs par défaut
// - setRuleEnabled / setContextThreshold   modification des réglages
//
// Ajouter une règle : la détection dans suggestions.rs (`RULES`), puis sa présentation ici
// dans SUGGESTION_RULES. Exception : la règle « conversation ancienne » se déclenche à la
// frappe, donc côté interface (voir plus bas), et ses suggestions sont ajoutées à celles du
// backend. Une règle sans bandeau (fenêtre au moment d'une action, comme le
// worktree à la troisième conversation) peut n'y déclarer que son libellé de réglage.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Config, SuggestionSettings } from "./api";
import { t } from "./i18n";

/** Évènement émis par le backend (charge utile : SuggestionsSnapshot). */
export const EVT_SUGGESTIONS = "suggestions";

/** Dernier remplissage connu du contexte d'une conversation (voir context.rs). */
export interface ContextInfo {
  sessionId: string;
  /** Part du contexte utilisée, de 0 à 100. */
  usedPercentage: number;
  /** Dernière mise à jour (ms depuis 1970). */
  at: number;
  /** Début du remplissage en cours : dernière baisse nette (`/compact`). */
  since: number;
}

/** Une suggestion pour une conversation. */
export interface Suggestion {
  /** Identifiant de la règle (clé de SUGGESTION_RULES). */
  rule: string;
  sessionId: string;
  /** Clé sous laquelle « Ignorer » est enregistré. */
  key: string;
  /** Palier courant : « Ignorer » masque la suggestion jusqu'à un palier plus élevé. */
  level: number;
  /** Début de la situation (ms), ou null. */
  since: number | null;
  /** Précisions propres à la règle (pourcentage…). */
  data: Record<string, unknown>;
}

interface Payload {
  contexts: ContextInfo[];
  suggestions: Suggestion[];
}

/** Contexte et suggestions, indexés par conversation. */
export interface SuggestionsSnapshot {
  contexts: ReadonlyMap<string, ContextInfo>;
  bySession: ReadonlyMap<string, readonly Suggestion[]>;
}

// ---- Règles : présentation ----------------------------------------------------------------

/** Contexte rempli à N % (donnée `percent` de la règle « context »). */
const percentOf = (s: Suggestion) => Math.round(Number(s.data.percent ?? s.level));

/** Ce dont un texte de bandeau peut avoir besoin en plus de la suggestion. */
export interface SuggestionTextContext {
  /** Titre d'une conversation (projet ou archives), null si inconnue. */
  titleOf: (id: string) => string | null;
}

export interface SuggestionRuleUi {
  /** Libellé dans les réglages (lu dans la langue courante). */
  readonly label: string;
  /** Explication dans les réglages (lue dans la langue courante). */
  readonly description: string;
  /** Texte du bandeau (absent : règle sans bandeau). */
  text?: (s: Suggestion, ctx: SuggestionTextContext) => string;
  /** Info-bulle de l'icône 💡. */
  hint?: (s: Suggestion) => string;
  /** Bouton d'action du bandeau (libellé fixe ou selon la suggestion) ; le gestionnaire est
   *  fourni par la vue (voir SuggestionBanners). */
  action?: { id: string; label: (s: Suggestion) => string };
  /** Explication de « Ignorer » (info-bulle, lue dans la langue courante). */
  readonly dismissHint?: string;
}

/** Règle « Troisième conversation dans le même dossier » (fenêtre à la création, sans bandeau). */
export const RULE_WORKTREE = "worktree";

/** Identifiant de l'action « Hand off » (règle « Contexte rempli »). */
export const ACTION_HAND_OFF = "handoff";

/** Règle « Conversation ancienne » : détectée ici, à la première frappe (voir noteTyping). */
export const RULE_STALE = "stale";

/** Règle « Conversations qui ont échangé » : les regrouper dans un hub. */
export const RULE_HUB = "hub";
/** Identifiant de l'action « Créer un hub » / « Ajouter au hub » (règle « hub »). */
export const ACTION_HUB = "hub";

/** Données de la règle « hub » (voir `detect_hub` dans suggestions.rs). */
export interface HubSuggestionData {
  /** L'autre conversation. */
  other: string;
  /** Expéditeur du premier message (futur coordinateur d'un nouveau hub). */
  from: string;
  /** Destinataire du premier message (futur exécutant). */
  to: string;
  /** Hub où l'une des deux est déjà (null : en créer un). */
  hubId: string | null;
  hubName: string | null;
  /** Conversation qui rejoindrait ce hub. */
  joiner: string | null;
  /** Hub que `joiner` quitterait (une conversation est dans un hub au plus). */
  leaves: string | null;
}

export function hubSuggestionData(s: Suggestion): HubSuggestionData {
  const str = (k: string) => (typeof s.data[k] === "string" ? (s.data[k] as string) : null);
  return { other: str("other") ?? "", from: str("from") ?? "", to: str("to") ?? "", hubId: str("hubId"), hubName: str("hubName"), joiner: str("joiner"), leaves: str("leaves") };
}

/** Texte du bandeau de la règle « hub ». */
function hubText(s: Suggestion, ctx: SuggestionTextContext): string {
  const d = hubSuggestionData(s);
  const other = ctx.titleOf(d.other) ?? t("suggestions.hub.otherConversation");
  if (!d.hubId) return t("suggestions.hub.textNewHub", { other });
  const vars = { other, hub: d.hubName, leaves: d.leaves };
  if (d.joiner === s.sessionId) return t(d.leaves ? "suggestions.hub.textJoinLeaving" : "suggestions.hub.textJoin", vars);
  return t(d.leaves ? "suggestions.hub.textAddLeaving" : "suggestions.hub.textAdd", vars);
}

/** « 3 h », « 45 min », « 2 j » : ancienneté d'une conversation. */
export function formatAge(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return t("suggestions.age.minutes", { n: min });
  const h = Math.round(min / 60);
  if (h < 48) return t("suggestions.age.hours", { n: h });
  return t("suggestions.age.days", { n: Math.round(h / 24) });
}

/** Texte du bandeau de la règle « conversation ancienne ». */
function staleText(s: Suggestion): string {
  const age = formatAge(Number(s.data.ageMs ?? 0));
  return t("suggestions.stale.text", { age, percent: percentOf(s) });
}

/** Présentation de chaque règle, par identifiant (le même que dans suggestions.rs). Les
 *  textes sont des accesseurs : lus dans la langue courante à chaque accès. */
export const SUGGESTION_RULES: Record<string, SuggestionRuleUi> = {
  context: {
    get label() {
      return t("suggestions.context.label");
    },
    get description() {
      return t("suggestions.context.description");
    },
    text: (s) => t("suggestions.context.text", { percent: percentOf(s) }),
    hint: (s) => t("suggestions.context.hint", { percent: percentOf(s) }),
    action: { id: ACTION_HAND_OFF, label: () => t("suggestions.action.handOff") },
  },
  [RULE_STALE]: {
    get label() {
      return t("suggestions.stale.label");
    },
    get description() {
      return t("suggestions.stale.description");
    },
    text: staleText,
    hint: (s) => t("suggestions.stale.hint", { age: formatAge(Number(s.data.ageMs ?? 0)) }),
    action: { id: ACTION_HAND_OFF, label: () => t("suggestions.action.handOff") },
    get dismissHint() {
      return t("suggestions.stale.dismissHint");
    },
  },
  [RULE_HUB]: {
    get label() {
      return t("suggestions.hub.label");
    },
    get description() {
      return t("suggestions.hub.description");
    },
    text: hubText,
    hint: () => t("suggestions.hub.hint"),
    action: {
      id: ACTION_HUB,
      label: (s) =>
        !hubSuggestionData(s).hubId
          ? t("suggestions.hub.createHub")
          : hubSuggestionData(s).joiner === s.sessionId
            ? t("suggestions.hub.joinHub")
            : t("suggestions.hub.addToHub"),
    },
    get dismissHint() {
      return t("suggestions.hub.dismissHint");
    },
  },
  // Sans bandeau : fenêtre à la création d'une conversation (App.tsx, `newConversation`).
  [RULE_WORKTREE]: {
    get label() {
      return t("suggestions.worktree.label");
    },
    get description() {
      return t("suggestions.worktree.description");
    },
  },
};

// ---- Réglages et « Ignorer » (fonctions pures sur la configuration) ------------------------

/** Seuil par défaut de la règle « Contexte rempli » (même valeur que config.rs). */
export const DEFAULT_CONTEXT_THRESHOLD = 60;
/** Bornes du seuil (mêmes que suggestions.rs). */
export const CONTEXT_THRESHOLD_MIN = 10;
export const CONTEXT_THRESHOLD_MAX = 95;

/** Règle « conversation ancienne » : inactivité (minutes) et contexte (%) par défaut, et bornes
 *  (mêmes valeurs que config.rs). */
export const DEFAULT_STALE_MINUTES = 60;
export const STALE_MINUTES_MIN = 5;
export const STALE_MINUTES_MAX = 7 * 24 * 60;
export const DEFAULT_STALE_PERCENT = 30;
export const STALE_PERCENT_MIN = 5;
export const STALE_PERCENT_MAX = 95;

export function suggestionSettings(cfg: Config): Required<SuggestionSettings> {
  return {
    disabled: cfg.suggestions?.disabled ?? [],
    contextThreshold: cfg.suggestions?.contextThreshold ?? DEFAULT_CONTEXT_THRESHOLD,
    staleMinutes: cfg.suggestions?.staleMinutes ?? DEFAULT_STALE_MINUTES,
    stalePercent: cfg.suggestions?.stalePercent ?? DEFAULT_STALE_PERCENT,
  };
}

const clamp = (n: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, n)));

export function setStaleMinutes(cfg: Config, minutes: number): Config {
  return { ...cfg, suggestions: { ...suggestionSettings(cfg), staleMinutes: clamp(minutes, STALE_MINUTES_MIN, STALE_MINUTES_MAX) } };
}

export function setStalePercent(cfg: Config, pct: number): Config {
  return { ...cfg, suggestions: { ...suggestionSettings(cfg), stalePercent: clamp(pct, STALE_PERCENT_MIN, STALE_PERCENT_MAX) } };
}

export function isRuleEnabled(cfg: Config, rule: string): boolean {
  return !suggestionSettings(cfg).disabled.includes(rule);
}

export function setRuleEnabled(cfg: Config, rule: string, enabled: boolean): Config {
  const s = suggestionSettings(cfg);
  const disabled = s.disabled.filter((r) => r !== rule);
  return { ...cfg, suggestions: { ...s, disabled: enabled ? disabled : [...disabled, rule] } };
}

export function setContextThreshold(cfg: Config, pct: number): Config {
  const clamped = Math.round(Math.min(CONTEXT_THRESHOLD_MAX, Math.max(CONTEXT_THRESHOLD_MIN, pct)));
  return { ...cfg, suggestions: { ...suggestionSettings(cfg), contextThreshold: clamped } };
}

/**
 * « Ignorer » : la suggestion est masquée pour cette conversation jusqu'au palier suivant.
 * Règle « hub » : pour la paire, définitivement, donc aussi dans l'autre conversation.
 */
export function dismissSuggestion(cfg: Config, s: Suggestion, at = Date.now()): Config {
  const one = (c: Config, sessionId: string, key: string): Config => {
    const prefs = c.conversations[sessionId] ?? {};
    return {
      ...c,
      conversations: {
        ...c.conversations,
        [sessionId]: { ...prefs, dismissedSuggestions: { ...prefs.dismissedSuggestions, [key]: { level: s.level, at } } },
      },
    };
  };
  const next = one(cfg, s.sessionId, s.key);
  const other = s.rule === RULE_HUB ? hubSuggestionData(s).other : "";
  return other ? one(next, other, `${RULE_HUB}:${s.sessionId}`) : next;
}

// ---- Magasin -------------------------------------------------------------------------------

const EMPTY: readonly Suggestion[] = [];
let store: SuggestionsSnapshot = { contexts: new Map(), bySession: new Map() };
const listeners = new Set<() => void>();
let started = false;
/** Dernière émission du backend. */
let backend: Payload = { contexts: [], suggestions: [] };

function set(p: Payload) {
  backend = p;
  rebuild();
}

/** Reconstruit l'instantané : suggestions du backend, plus celles de la règle « conversation ancienne ». */
function rebuild() {
  const p = backend;
  const bySession = new Map<string, Suggestion[]>();
  for (const s of [...p.suggestions, ...stale.values()]) {
    const list = bySession.get(s.sessionId);
    if (list) list.push(s);
    else bySession.set(s.sessionId, [s]);
  }
  store = { contexts: new Map(p.contexts.map((c) => [c.sessionId, c])), bySession };
  listeners.forEach((f) => f());
}

function ensureStarted() {
  if (started) return;
  started = true;
  let received = false;
  listen<Payload>(EVT_SUGGESTIONS, (e) => {
    received = true;
    set(e.payload);
  });
  // État initial (une émission arrivée entre-temps est plus récente).
  invoke<Payload>("suggestions_list")
    .then((p) => !received && p && set(p))
    .catch(() => {});
}

function subscribe(f: () => void) {
  ensureStarted();
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/** Contexte et suggestions ; le composant se redessine à chaque changement. */
export function useSuggestions(): SuggestionsSnapshot {
  return useSyncExternalStore(subscribe, () => store);
}

/** Contexte et suggestions (hors React). */
export function getSuggestions(): SuggestionsSnapshot {
  ensureStarted();
  return store;
}

/** Suggestions d'une conversation (vide si aucune). */
export function suggestionsOf(snap: SuggestionsSnapshot, sessionId: string): readonly Suggestion[] {
  return snap.bySession.get(sessionId) ?? EMPTY;
}

/** Au moins une suggestion parmi ces conversations (projet, catégorie). */
export function hasSuggestion(snap: SuggestionsSnapshot, ids: Iterable<string>): boolean {
  for (const id of ids) if (snap.bySession.has(id)) return true;
  return false;
}

// ---- Règle « conversation ancienne » (côté interface) ---------------------------------------
// Le cache de contexte de Claude expire : le premier message après une longue pause fait relire
// tout le contexte au prix fort. À la première frappe dans une conversation inactive depuis plus
// de `staleMinutes` et dont le contexte dépasse `stalePercent`, un bandeau propose un hand off.
// Rien à la simple ouverture (on peut vouloir juste relire). « Ignorer » vaut tant que la
// conversation reste ouverte : rien n'est enregistré.

const stale = new Map<string, Suggestion>();
/** Conversations où le bandeau a déjà été montré depuis leur ouverture. */
const staleSeen = new Set<string>();

/** Frappe de l'utilisateur dans une conversation (terminal intégré ou zone de saisie). */
export function noteTyping(sessionId: string, cfg: Config, now = Date.now()) {
  if (staleSeen.has(sessionId) || !isRuleEnabled(cfg, RULE_STALE)) return;
  const ctx = getSuggestions().contexts.get(sessionId);
  if (!ctx) return;
  const settings = suggestionSettings(cfg);
  const ageMs = now - ctx.at;
  // Vérifié à chaque frappe (simples lectures en mémoire) : un onglet resté ouvert sans
  // activité peut devenir ancien. Le bandeau n'est montré qu'une fois par ouverture.
  if (ageMs < settings.staleMinutes * 60_000 || ctx.usedPercentage < settings.stalePercent) return;
  staleSeen.add(sessionId);
  stale.set(sessionId, { rule: RULE_STALE, sessionId, key: RULE_STALE, level: 0, since: ctx.at, data: { percent: ctx.usedPercentage, ageMs } });
  rebuild();
}

/** « Ignorer » ou hand off lancé : le bandeau disparaît jusqu'à la fermeture de la conversation. */
export function dismissStale(sessionId: string) {
  if (stale.delete(sessionId)) rebuild();
}

/** Conversation fermée : sa prochaine ouverture repart de zéro. */
export function forgetStale(sessionId: string) {
  staleSeen.delete(sessionId);
  dismissStale(sessionId);
}

/** Suggestion propre à l'interface, dont « Ignorer » n'est pas enregistré dans la configuration. */
export const isLocalSuggestion = (s: Suggestion) => s.rule === RULE_STALE;

/** Info-bulle de l'icône 💡 d'une conversation. */
export function suggestionHint(list: readonly Suggestion[]): string {
  return list.map((s) => SUGGESTION_RULES[s.rule]?.hint?.(s) ?? SUGGESTION_RULES[s.rule]?.label ?? t("suggestions.fallbackHint")).join("\n");
}
