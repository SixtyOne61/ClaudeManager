// Boîte de confirmation de Claude Code, lue sur l'écran du terminal pour être affichée dans la
// conversation (carte à la place de la zone de saisie, voir ConfirmCard).
//
// Exemple (`/model opus` en cours de conversation, Claude Code 2.1.332) :
//
//   ────────────────────────────────────────
//     Switch model?
//     Your next response will be slower and use more tokens
//     This conversation is cached for the current model. …
//     ❯ 1. Yes, switch to Opus 5.5
//       2. No, go back
//     Enter to confirm · Esc to cancel
//
// La réponse est envoyée comme au clavier : flèches jusqu'à l'option, puis Entrée ; Échap annule.

/** Boîte de confirmation affichée par Claude Code. */
export interface ConfirmPrompt {
  /** Première ligne de la boîte (« Switch model? »). */
  title: string;
  /** Lignes d'explication entre le titre et les options. */
  details: string[];
  /** Libellés des options, sans leur numéro. */
  options: string[];
  /** Option sous le curseur (❯), à partir de 0. */
  selected: number;
}

/** Pied de la boîte : sa présence signale une confirmation ouverte. */
const FOOTER = /Enter to confirm/i;
/** Ligne d'option : « ❯ 1. Yes, switch… » ou « 2. No, go back ». */
const OPTION = /^\s*(❯\s*)?(\d+)\.\s+(.+?)\s*$/;
/** Trait horizontal qui ouvre la boîte. */
const RULE = /^\s*[─━]{8,}\s*$/;

/** Lit la boîte de confirmation dans les lignes visibles du terminal (null : aucune). */
export function parseConfirmPrompt(lines: string[]): ConfirmPrompt | null {
  let foot = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER.test(lines[i])) {
      foot = i;
      break;
    }
  }
  if (foot < 0) return null;
  // Options : lignes numérotées juste au-dessus du pied (lignes vides admises entre elles).
  const found: { label: string; cursor: boolean }[] = [];
  let i = foot - 1;
  for (; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    const m = OPTION.exec(lines[i]);
    if (!m) break;
    found.unshift({ label: m[3], cursor: !!m[1] });
  }
  if (found.length === 0) return null;
  const options = found.map((o) => o.label);
  const selected = Math.max(0, found.findIndex((o) => o.cursor));
  // Titre et explications : du trait d'ouverture jusqu'aux options.
  const text: string[] = [];
  for (; i >= 0 && !RULE.test(lines[i]); i--) if (lines[i].trim()) text.unshift(lines[i].trim());
  if (text.length === 0) return null;
  return { title: text[0], details: text.slice(1), options, selected };
}

/** Deux lectures de l'écran montrent la même boîte (le curseur compris). */
export function samePrompt(a: ConfirmPrompt | null, b: ConfirmPrompt | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Touches qui choisissent l'option `index` : flèches depuis le curseur, puis Entrée. */
export function answerKeys(p: ConfirmPrompt, index: number): string {
  const delta = index - p.selected;
  return (delta > 0 ? "\x1b[B".repeat(delta) : "\x1b[A".repeat(-delta)) + "\r";
}

/** Échap : ferme la boîte sans rien choisir. */
export const CANCEL_KEYS = "\x1b";
