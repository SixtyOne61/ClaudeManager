// Séries de questions (skill « grilling ») : reconnues dans une réponse de Claude pour être
// affichées en cartes et répondues dans un formulaire (`GrillForm`) au lieu de la zone de
// saisie.
//
// Seul le format du skill est reconnu, pour éviter les faux positifs :
//
//   ❓ **Q1** - **Titre** : énoncé…        (ou  ❓ **Q1 - Titre ?** énoncé…)
//   suite de l'énoncé, choix…
//
//   ➡️ réponse recommandée
//
//   ---
//
//   ❓ **Q2** - …
//
// - parseGrill(texte)          questions d'une réponse (null si ce n'est pas une série)
// - pendingRound(éléments)     série encore sans réponse à la fin de la conversation
// - formatAnswers(série, …)    message envoyé à Claude : une ligne « Q1 — Titre : réponse »
// - getDraft / setDraft        réponses commencées, gardées tant que l'app est ouverte

import type { ConversationEntry } from "./conversation";

export interface GrillQuestion {
  /** Numéro donné par Claude (Q3 → "3", Q1b → "1b"). */
  n: string;
  /** Titre, en Markdown (sans les `**` qui l'encadrent). */
  title: string;
  /** Énoncé en Markdown (peut être vide si tout tient dans le titre). */
  body: string;
  /** Réponse recommandée en Markdown, sans la flèche (null si Claude n'en a pas donné). */
  recommendation: string | null;
}

export interface GrillRound {
  /** Texte avant la première question. */
  intro: string;
  questions: GrillQuestion[];
  /** Texte après la recommandation de la dernière question. */
  outro: string;
}

/** `❓ **Q1** - **Titre** : énoncé` ou `❓ **Q1 - Titre** énoncé`. */
const QUESTION = /^\s*❓️?\s*\*\*Q(\d+[a-z]?)(?:\*\*\s*[-–—:.]\s*\*\*|\s*[-–—:.]\s*)(.+?)\*\*\s*(.*)$/u;
/** `➡️ recommandation`. */
const RECOMMENDATION = /^\s*➡️?\s?(.*)$/u;
/** Séparateur Markdown entre deux questions. */
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** Retire les lignes vides au début et à la fin. */
function trimLines(lines: string[]): string {
  return lines.join("\n").replace(/^\s*\n/, "").trim();
}

/** Questions d'une réponse de Claude, ou null si elle n'en contient pas au format du skill. */
export function parseGrill(text: string): GrillRound | null {
  if (!text.includes("❓")) return null;
  const lines = text.split(/\r?\n/);
  const intro: string[] = [];
  const outro: string[] = [];
  const questions: { n: string; title: string; body: string[]; reco: string[] | null; recoDone: boolean; after: string[] }[] = [];
  let inFence = false;

  for (const line of lines) {
    const q = questions[questions.length - 1];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const head = inFence ? null : QUESTION.exec(line);
    if (head) {
      const title = head[2].trim().replace(/\s*:$/, "");
      const rest = head[3].replace(/^\s*:\s*/, "");
      questions.push({ n: head[1], title, body: rest ? [rest] : [], reco: null, recoDone: false, after: [] });
      continue;
    }
    if (!q) {
      intro.push(line);
      continue;
    }
    if (!inFence && RULE.test(line)) {
      // Fin de la question : ce qui suit appartient à la suivante (ou à la conclusion).
      q.recoDone = true;
      if (q.reco === null) q.reco = []; // garde la trace : la question est close
      q.after.push("\u0000rule");
      continue;
    }
    if (q.reco === null) {
      const r = inFence ? null : RECOMMENDATION.exec(line);
      if (r) q.reco = [r[1]];
      else q.body.push(line);
    } else if (!q.recoDone) {
      // La recommandation est un paragraphe : elle s'arrête à la première ligne vide.
      if (line.trim() === "") q.recoDone = true;
      else q.reco.push(line);
    } else {
      q.after.push(line);
    }
  }
  if (questions.length === 0) return null;

  // Ce qui suit la recommandation de la dernière question est la conclusion. Pour les
  // autres, ce qui la suit avant le séparateur en fait encore partie (le reste est ignoré :
  // en pratique, des lignes vides).
  const result: GrillQuestion[] = questions.map((q, i) => {
    const last = i === questions.length - 1;
    const rule = q.after.indexOf("\u0000rule");
    const beforeRule = rule < 0 ? q.after : q.after.slice(0, rule);
    if (last) outro.push(...q.after.filter((l) => l !== "\u0000rule"));
    const more = !last && beforeRule.some((l) => l.trim()) ? ["", ...beforeRule] : [];
    const reco = q.reco ? trimLines([...q.reco, ...more]) : "";
    return { n: q.n, title: q.title, body: trimLines(q.body), recommendation: reco || null };
  });
  return { intro: trimLines(intro).replace(/\n?\s*(?:-{3,}|\*{3,}|_{3,})\s*$/, "").trim(), questions: result, outro: trimLines(outro) };
}

/** Série de questions en attente : dernier message de la conversation, sans réponse après. */
export interface PendingRound {
  /** Identifiant stable du message (brouillon, défilement). */
  key: string;
  round: GrillRound;
}

/**
 * Série de questions à laquelle l'utilisateur n'a pas encore répondu : la dernière réponse
 * de Claude, si c'est une série et qu'aucun message de l'utilisateur ne la suit (les
 * actions de Claude après elle ne comptent pas).
 */
export function pendingRound(entries: ConversationEntry[]): PendingRound | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "user") return null;
    if (e.kind !== "assistant") continue;
    const round = parseGrill(e.text);
    return round ? { key: e.uuid ?? `l${e.line}`, round } : null;
  }
  return null;
}

// ---- Réponses ---------------------------------------------------------------------------

/** Réponse à une question : d'accord avec la recommandation, non, ou une réponse libre. */
export type Choice = "yes" | "no" | "other";

export interface Answer {
  choice: Choice | null;
  /** Précision (« non, parce que… ») ou réponse libre. */
  text: string;
}

export interface Draft {
  answers: Record<string, Answer>;
  /** Commentaire général, ajouté à la fin du message. */
  comment: string;
  /** L'utilisateur a choisi de répondre en texte libre (zone de saisie normale). */
  freeText: boolean;
}

/** Une question a sa réponse : d'accord, non, ou une réponse libre non vide. */
export function isAnswered(a: Answer | undefined): boolean {
  if (!a?.choice) return false;
  return a.choice !== "other" || a.text.trim() !== "";
}

/** Titre en texte simple (sans Markdown d'emphase), pour le message envoyé. */
function plainTitle(title: string): string {
  return title.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
}

/** Texte d'une réponse, sur une seule ligne. */
function answerText(a: Answer): string {
  const t = a.text.trim().replace(/\s*\n\s*/g, " ");
  switch (a.choice) {
    case "yes":
      return t ? `Oui, ${t}` : "Oui";
    case "no":
      return t ? `Non, ${t}` : "Non";
    default:
      return t;
  }
}

/** Ligne d'une réponse dans le message : « Q1 — Titre : réponse ». */
export const ANSWER_LINE = /^Q(\d+[a-z]?) — /;

/** Message envoyé à Claude : une ligne par question, puis le commentaire général. */
export function formatAnswers(round: GrillRound, draft: Draft): string {
  const lines = round.questions.map((q) => `Q${q.n} — ${plainTitle(q.title)} : ${answerText(draft.answers[q.n] ?? { choice: null, text: "" })}`);
  const comment = draft.comment.trim();
  return comment ? `${lines.join("\n")}\n\n${comment}` : lines.join("\n");
}

// ---- Brouillons -------------------------------------------------------------------------

/** Brouillons par conversation et par série : gardés tant que l'app est ouverte. */
const drafts = new Map<string, Draft>();

const draftKey = (sessionId: string, roundKey: string) => `${sessionId}\u0000${roundKey}`;

export function emptyDraft(): Draft {
  return { answers: {}, comment: "", freeText: false };
}

export function getDraft(sessionId: string, roundKey: string): Draft {
  return drafts.get(draftKey(sessionId, roundKey)) ?? emptyDraft();
}

export function setDraft(sessionId: string, roundKey: string, draft: Draft | null) {
  if (draft) drafts.set(draftKey(sessionId, roundKey), draft);
  else drafts.delete(draftKey(sessionId, roundKey));
}
