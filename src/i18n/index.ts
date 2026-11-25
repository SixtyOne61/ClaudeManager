// Textes de l'interface et langue courante (voir .scratch/refonte-ui-langue/spec.md).
//
// - t(key, vars?)            texte de la langue courante, ou le français s'il manque
// - useLanguage()            langue courante ; le composant se redessine quand elle change
// - locale()                 langue pour `Intl` (dates, nombres)
// - setLanguage(code, dict)  change de langue (dict : textes traduits, clé → texte)
// - FR                       catalogue de référence (français), clé → texte
//
// Format des textes (sous-ensemble d'ICU MessageFormat, que les traducteurs connaissent) :
// - `{name}` : variable ;
// - `{count, plural, one {# conversation} other {# conversations}}` : pluriel selon
//   `Intl.PluralRules` (`=0`, `=1`… possibles), `#` = le nombre formaté ;
// - `{kind, select, hub {…} other {…}}` : choix selon la valeur ;
// - `'{'` pour une accolade littérale.
//
// Les textes envoyés aux conversations (consignes de hand off, premier message d'un
// exécutant…) ne passent pas par ici : ils restent tels quels.

import { useSyncExternalStore } from "react";
import { FR, type MessageKey } from "./fr";

export { FR, type MessageKey };

export type Vars = Record<string, string | number | null | undefined>;

/** Langue intégrée à l'app. */
export const SOURCE_LANGUAGE = "fr";

let language = SOURCE_LANGUAGE;
let dict: Partial<Record<string, string>> = {};
const listeners = new Set<() => void>();

/** Change la langue de l'interface. `translations` : textes traduits (absents : français). */
export function setLanguage(code: string, translations: Partial<Record<string, string>> = {}) {
  language = code;
  dict = code === SOURCE_LANGUAGE ? {} : translations;
  plurals.clear();
  listeners.forEach((f) => f());
}

/** Langue courante (code BCP 47). */
export const currentLanguage = () => language;

/** Langue pour `Intl` (dates, nombres, pluriels). */
export function locale(): string {
  return language === SOURCE_LANGUAGE ? "fr-FR" : language;
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/** Langue courante ; le composant qui l'appelle se redessine quand elle change. */
export function useLanguage(): string {
  return useSyncExternalStore(subscribe, () => language);
}

/** Texte de la langue courante pour `key`, variables remplacées. */
export function t(key: MessageKey, vars?: Vars): string {
  const pattern = dict[key] ?? FR[key] ?? key;
  try {
    return format(pattern, vars ?? {});
  } catch {
    // Traduction mal formée : le français, sinon le texte brut.
    try {
      return format(FR[key] ?? key, vars ?? {});
    } catch {
      return pattern;
    }
  }
}

/** Le texte existe dans le catalogue (clé construite à l'exécution, par exemple une erreur). */
export const hasKey = (key: string): key is MessageKey => key in FR;

// ---- Mise en forme ---------------------------------------------------------------------

const plurals = new Map<string, Intl.PluralRules>();
function pluralRules(): Intl.PluralRules {
  const l = locale();
  let r = plurals.get(l);
  if (!r) {
    try {
      r = new Intl.PluralRules(l);
    } catch {
      r = new Intl.PluralRules("fr-FR");
    }
    plurals.set(l, r);
  }
  return r;
}

function formatNumber(n: number): string {
  try {
    return new Intl.NumberFormat(locale()).format(n);
  } catch {
    return String(n);
  }
}

/** Analyse et remplit un texte (voir le format en tête de fichier). */
export function format(pattern: string, vars: Vars, hash?: number): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "'" && pattern[i + 1] === "{" && pattern[i + 2] === "'") {
      out += "{";
      i += 3;
    } else if (c === "'" && pattern[i + 1] === "}" && pattern[i + 2] === "'") {
      out += "}";
      i += 3;
    } else if (c === "#" && hash !== undefined) {
      out += formatNumber(hash);
      i++;
    } else if (c === "{") {
      const end = matching(pattern, i);
      out += argument(pattern.slice(i + 1, end), vars);
      i = end + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Position de l'accolade fermante qui répond à celle en `start`. */
function matching(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  throw new Error("accolade non fermée");
}

function argument(body: string, vars: Vars): string {
  const comma = body.indexOf(",");
  if (comma < 0) {
    const v = vars[body.trim()];
    return v === null || v === undefined ? "" : typeof v === "number" ? formatNumber(v) : v;
  }
  const name = body.slice(0, comma).trim();
  const rest = body.slice(comma + 1);
  const comma2 = rest.indexOf(",");
  if (comma2 < 0) throw new Error("argument mal formé");
  const type = rest.slice(0, comma2).trim();
  const options = parseOptions(rest.slice(comma2 + 1));
  const value = vars[name];
  if (type === "plural") {
    const n = Number(value ?? 0);
    const branch = options.get("=" + n) ?? options.get(pluralRules().select(n)) ?? options.get("other");
    if (branch === undefined) throw new Error("pluriel sans « other »");
    return format(branch, vars, n);
  }
  if (type === "select") {
    const branch = options.get(String(value ?? "")) ?? options.get("other");
    if (branch === undefined) throw new Error("choix sans « other »");
    return format(branch, vars);
  }
  throw new Error("type inconnu : " + type);
}

/** `one {…} other {…}` → sélecteur → texte. */
function parseOptions(s: string): Map<string, string> {
  const map = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/[\s{]/.test(s[j])) j++;
    const selector = s.slice(i, j);
    while (j < s.length && /\s/.test(s[j])) j++;
    if (s[j] !== "{") throw new Error("option mal formée");
    const end = matching(s, j);
    map.set(selector, s.slice(j + 1, end));
    i = end + 1;
  }
  return map;
}

/** Noms des variables d'un texte (contrôle des traductions : elles doivent garder les mêmes). */
export function variablesOf(pattern: string, names = new Set<string>()): Set<string> {
  // Même parcours que `format` : le texte des branches de `plural` / `select` n'est pas une
  // variable (`one {erreur}`), mais peut en contenir.
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "'" && (pattern[i + 1] === "{" || pattern[i + 1] === "}") && pattern[i + 2] === "'") {
      i += 3;
    } else if (c === "{") {
      const end = matching(pattern, i);
      const body = pattern.slice(i + 1, end);
      const comma = body.indexOf(",");
      if (comma < 0) names.add(body.trim());
      else {
        names.add(body.slice(0, comma).trim());
        const rest = body.slice(comma + 1);
        const comma2 = rest.indexOf(",");
        if (comma2 >= 0) for (const branch of parseOptions(rest.slice(comma2 + 1)).values()) variablesOf(branch, names);
      }
      i = end + 1;
    } else i++;
  }
  return names;
}
