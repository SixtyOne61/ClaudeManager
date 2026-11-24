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
// - suggestionSettings(cfg)           réglages, avec leurs valeurs par défaut
// - setRuleEnabled / setContextThreshold   modification des réglages
//
// Ajouter une règle : la détection dans suggestions.rs (`RULES`), puis sa présentation ici
// dans SUGGESTION_RULES. Une règle sans bandeau (fenêtre au moment d'une action, comme le
// worktree à la troisième conversation) peut n'y déclarer que son libellé de réglage.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Config, SuggestionSettings } from "./api";

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
  /** Libellé dans les réglages. */
  label: string;
  /** Explication dans les réglages. */
  description: string;
  /** Texte du bandeau (absent : règle sans bandeau). */
  text?: (s: Suggestion, ctx: SuggestionTextContext) => string;
  /** Info-bulle de l'icône 💡. */
  hint?: (s: Suggestion) => string;
  /** Bouton d'action du bandeau (libellé fixe ou selon la suggestion) ; le gestionnaire est
   *  fourni par la vue (voir SuggestionBanners). */
  action?: { id: string; label: string | ((s: Suggestion) => string) };
  /** Explication de « Ignorer » (info-bulle). */
  dismissHint?: string;
}

/** Règle « Troisième conversation dans le même dossier » (fenêtre à la création, sans bandeau). */
export const RULE_WORKTREE = "worktree";

/** Identifiant de l'action « Hand off » (règle « Contexte rempli »). */
export const ACTION_HAND_OFF = "handoff";

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
  const other = `« ${ctx.titleOf(d.other) ?? "une autre conversation"} »`;
  const start = `Cette conversation a échangé avec ${other}`;
  if (!d.hubId) return `${start} : les regrouper dans un hub ?`;
  const leaves = d.leaves ? ` (elle quittera le hub « ${d.leaves} »)` : "";
  return d.joiner === s.sessionId
    ? `${start}, du hub « ${d.hubName} » : rejoindre ce hub ?${leaves}`
    : `${start} : l'ajouter au hub « ${d.hubName} » ?${leaves}`;
}

/** Présentation de chaque règle, par identifiant (le même que dans suggestions.rs). */
export const SUGGESTION_RULES: Record<string, SuggestionRuleUi> = {
  context: {
    label: "Contexte rempli",
    description: "Proposer un hand off quand le contexte d'une conversation dépasse le seuil (puis à 80 % et 90 %).",
    text: (s) => `Contexte rempli à ${percentOf(s)} % : un hand off repartirait d'un contexte propre`,
    hint: (s) => `Contexte rempli à ${percentOf(s)} % : un hand off est suggéré`,
    action: { id: ACTION_HAND_OFF, label: "Hand off" },
  },
  [RULE_HUB]: {
    label: "Conversations qui ont échangé",
    description:
      "Proposer de regrouper dans un hub deux conversations qui se sont envoyé un message (outil SendMessage) sans être dans un même hub.",
    text: hubText,
    hint: () => "A échangé avec une autre conversation : un hub est suggéré",
    action: { id: ACTION_HUB, label: (s) => (!hubSuggestionData(s).hubId ? "Créer un hub" : hubSuggestionData(s).joiner === s.sessionId ? "Rejoindre le hub" : "Ajouter au hub") },
    dismissHint: "Ne plus proposer de regrouper ces deux conversations",
  },
  // Sans bandeau : fenêtre à la création d'une conversation (App.tsx, `newConversation`).
  [RULE_WORKTREE]: {
    label: "Troisième conversation dans le même dossier",
    description:
      "Proposer de démarrer une nouvelle conversation dans un worktree quand deux conversations ou plus tournent déjà dans le dossier du projet (dépôt git).",
  },
};

// ---- Réglages et « Ignorer » (fonctions pures sur la configuration) ------------------------

/** Seuil par défaut de la règle « Contexte rempli » (même valeur que config.rs). */
export const DEFAULT_CONTEXT_THRESHOLD = 60;
/** Bornes du seuil (mêmes que suggestions.rs). */
export const CONTEXT_THRESHOLD_MIN = 10;
export const CONTEXT_THRESHOLD_MAX = 95;

export function suggestionSettings(cfg: Config): SuggestionSettings {
  return { disabled: cfg.suggestions?.disabled ?? [], contextThreshold: cfg.suggestions?.contextThreshold ?? DEFAULT_CONTEXT_THRESHOLD };
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
  const t = Math.round(Math.min(CONTEXT_THRESHOLD_MAX, Math.max(CONTEXT_THRESHOLD_MIN, pct)));
  return { ...cfg, suggestions: { ...suggestionSettings(cfg), contextThreshold: t } };
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

function set(p: Payload) {
  const bySession = new Map<string, Suggestion[]>();
  for (const s of p.suggestions) {
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

/** Info-bulle de l'icône 💡 d'une conversation. */
export function suggestionHint(list: readonly Suggestion[]): string {
  return list.map((s) => SUGGESTION_RULES[s.rule]?.hint?.(s) ?? SUGGESTION_RULES[s.rule]?.label ?? "Suggestion").join("\n");
}
