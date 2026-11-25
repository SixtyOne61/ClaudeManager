// Commandes `/…` proposées dans la zone de saisie (voir src-tauri/src/commands_list.rs) :
// lecture auprès du backend avec un cache par conversation, et filtrage de ce qui est tapé.

import { invoke } from "@tauri-apps/api/core";
import { hasKey, t } from "./i18n";

export type SlashSource = "builtin" | "user" | "project" | "plugin";

export interface SlashEntry {
  /** Sans la barre oblique : `compact`, `mon-plugin:revue`. */
  name: string;
  description: string;
  source: SlashSource;
  argumentHint: string | null;
}

/** Libellé du badge de provenance. */
export function sourceLabel(source: SlashSource): string {
  switch (source) {
    case "builtin":
      return t("slash.source.builtin");
    case "user":
      return t("slash.source.user");
    case "project":
      return t("slash.source.project");
    case "plugin":
      return t("slash.source.plugin");
  }
}

/** Description affichée : celle du catalogue pour une commande intégrée connue, sinon celle reçue. */
export function slashDescription(e: SlashEntry): string {
  const key = "slash.builtin." + e.name;
  return e.source === "builtin" && hasKey(key) ? t(key) : e.description;
}

/** Indication d'arguments affichée : celle du catalogue pour une commande intégrée connue, sinon celle reçue. */
export function slashArgumentHint(e: SlashEntry): string | null {
  if (e.argumentHint == null) return null;
  const key = "slash.builtin." + e.name + ".hint";
  return e.source === "builtin" && hasKey(key) ? t(key) : e.argumentHint;
}

/** Dernière liste connue, par dossier (et conversation) : affichée tout de suite à l'ouverture. */
const cache = new Map<string, SlashEntry[]>();
const key = (cwd: string | null, sessionId: string | null) => `${cwd ?? ""}|${sessionId ?? ""}`;

export function cachedSlashCommands(cwd: string | null, sessionId: string | null): SlashEntry[] | undefined {
  return cache.get(key(cwd, sessionId));
}

/** Relit la liste auprès du backend (à chaque ouverture du menu) et met le cache à jour. */
export async function loadSlashCommands(cwd: string | null, sessionId: string | null): Promise<SlashEntry[]> {
  const list = await invoke<SlashEntry[]>("list_slash_commands", { cwd, sessionId });
  cache.set(key(cwd, sessionId), list);
  return list;
}

/**
 * Le texte saisi ouvre-t-il le menu ? Oui s'il commence par `/` suivi d'un nom en cours de
 * frappe (pas encore d'espace). Renvoie ce qui suit la barre oblique, sinon null.
 */
export function slashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? m[1] : null;
}

/** Les lettres de `q` apparaissent-elles dans l'ordre dans `s` ? Score : plus c'est serré, mieux c'est. */
function fuzzyScore(s: string, q: string): number | null {
  let pos = -1;
  let first = -1;
  for (const ch of q) {
    pos = s.indexOf(ch, pos + 1);
    if (pos < 0) return null;
    if (first < 0) first = pos;
  }
  return pos - first - q.length + first / 10;
}

/**
 * Entrées correspondant à `query` : d'abord celles dont le nom commence par la saisie (nom
 * exact en tête, puis ordre alphabétique), puis celles dont un segment (`plugin:nom`,
 * `mot-composé`) commence par elle, puis les correspondances approchées (lettres dans l'ordre). Saisie vide : tout, par ordre alphabétique.
 */
export function filterSlashCommands(entries: SlashEntry[], query: string): SlashEntry[] {
  const q = query.toLowerCase();
  if (!q) return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const scored: { e: SlashEntry; tier: number; score: number }[] = [];
  for (const e of entries) {
    const n = e.name.toLowerCase();
    if (n.startsWith(q)) {
      scored.push({ e, tier: 0, score: n === q ? -1 : 0 });
    } else if (n.split(/[:\-_/]/).some((seg, i) => i > 0 && seg.startsWith(q))) {
      scored.push({ e, tier: 1, score: 0 });
    } else {
      const f = fuzzyScore(n, q);
      if (f != null) scored.push({ e, tier: 2, score: f });
    }
  }
  scored.sort((a, b) => a.tier - b.tier || a.score - b.score || a.e.name.localeCompare(b.e.name));
  return scored.map((s) => s.e);
}
