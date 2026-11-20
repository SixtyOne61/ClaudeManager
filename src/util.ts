// Petites fonctions utilitaires : couleurs, dates, noms.

import type { Config, ProjectInfo } from "./api";

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

const dateFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "date inconnue";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : dateFmt.format(d);
}

/** « à l'instant », « il y a 3 h », « hier », « il y a 5 j », puis la date. */
export function relativeDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 2 * 86400) return "hier";
  if (diff < 30 * 86400) return `il y a ${Math.floor(diff / 86400)} j`;
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(d);
}

export function newId(): string {
  return crypto.randomUUID();
}
