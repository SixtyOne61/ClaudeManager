// Petites fonctions utilitaires : couleurs, dates, noms.

import { locale, t } from "./i18n";
import type { Config, ProjectInfo } from "./api";

/** Vrai sous macOS. */
export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/** Touche de raccourci affichée : « ⌘ » sur Mac, « Ctrl » ailleurs. */
export const modKey = isMac ? "⌘" : "Ctrl";

/**
 * Dossier d'un worktree créé par Claude Code (`<dépôt>/.claude/worktrees/<nom>`), avec le
 * séparateur du chemin du dépôt (`\` sous Windows, `/` ailleurs). Sans nom : le dossier parent.
 */
export function worktreePath(repo: string, name?: string): string {
  const sep = repo.includes("\\") ? "\\" : "/";
  const parts = [repo.replace(/[\\/]+$/, ""), ".claude", "worktrees"];
  if (name) parts.push(name);
  return parts.join(sep);
}

/** Couleurs proposées dans le sélecteur (lisibles sur fond sombre). */
export const PRESET_COLORS = [
  "#7c3aed", "#2563eb", "#0891b2", "#059669", "#65a30d", "#ca8a04",
  "#ea580c", "#dc2626", "#db2777", "#475569", "#e2e8f0", "#fde68a",
];

/** Luminance relative WCAG d'une couleur #rrggbb (0 = noir, 1 = blanc). */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/**
 * Couleur de texte lisible sur un fond donné : on garde celle (sombre ou claire)
 * qui offre le meilleur rapport de contraste.
 */
export function textColorFor(bg: string): string {
  const l = luminance(bg);
  const contrastWithWhite = 1.05 / (l + 0.05);
  const contrastWithDark = (l + 0.05) / 0.06; // texte #111827 (luminance ≈ 0,01)
  return contrastWithDark >= contrastWithWhite ? "#111827" : "#ffffff";
}

/** Style d'un élément coloré : fond + texte contrasté. Rien si pas de couleur. */
export function colorStyle(color: string | null | undefined): React.CSSProperties | undefined {
  if (!color) return undefined;
  const fg = textColorFor(color);
  return { background: color, color: fg, ["--fg-muted" as string]: fg === "#ffffff" ? "rgba(255,255,255,.75)" : "rgba(17,24,39,.7)" };
}

/** Nom affiché d'un projet : nom personnalisé, sinon dernier dossier du chemin. */
export function projectName(p: ProjectInfo, cfg: Config | null): string {
  const custom = cfg?.projects[p.key]?.displayName?.trim();
  if (custom) return custom;
  if (p.path) {
    const parts = p.path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? p.path;
  }
  return p.key;
}

/** Date et heure dans la langue de l'interface. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return t("common.dateUnknown");
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(d);
}

/** « à l'instant », « il y a 3 h », « hier », « il y a 5 j », puis la date (langue de l'interface). */
export function relativeDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return t("common.justNow");
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto", style: "short" });
  if (diff < 3600) return rtf.format(-Math.floor(diff / 60), "minute");
  if (diff < 86400) return rtf.format(-Math.floor(diff / 3600), "hour");
  if (diff < 30 * 86400) return rtf.format(-Math.floor(diff / 86400), "day");
  return new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(d);
}

export function newId(): string {
  return crypto.randomUUID();
}
