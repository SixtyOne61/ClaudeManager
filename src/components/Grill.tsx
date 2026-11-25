// Séries de questions (skill « grilling », voir `grill.ts`) :
// - grillHtml(texte)     la réponse de Claude en cartes, une par question, avec la recommandation
// - <GrillAnswers>       la réponse de l'utilisateur, une pastille « Q1 » par ligne qui mène à la question
// - <GrillForm>          formulaire qui remplace la zone de saisie tant que la série attend sa réponse

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, MessageSquareText, PenLine, SendHorizontal, Square, X } from "lucide-react";
import { modKey } from "../util";
import { t, type MessageKey } from "../i18n";
import { renderMarkdown, renderMarkdownInline } from "../markdown";
import { ANSWER_LINE, formatAnswers, getDraft, isAnswered, parseGrill, setDraft, type Answer, type Choice, type Draft, type PendingRound } from "../grill";

// ---- Affichage dans la conversation -----------------------------------------------------

/** HTML d'une réponse en cartes si c'est une série de questions, sinon null. */
export function grillHtml(text: string): string | null {
  const round = parseGrill(text);
  if (!round) return null;
  const cards = round.questions.map(
    (q) =>
      `<section class="grill-card" data-grill-n="${q.n}">` +
      `<div class="grill-card-head"><span class="grill-num">Q${q.n}</span><span class="grill-title">${renderMarkdownInline(q.title)}</span></div>` +
      (q.body ? `<div class="grill-card-body">${renderMarkdown(q.body)}</div>` : "") +
      (q.recommendation ? `<div class="grill-reco"><span class="grill-reco-label">${t("tools.grill.recommended")}</span>${renderMarkdown(q.recommendation)}</div>` : "") +
      `</section>`,
  );
  return (round.intro ? renderMarkdown(round.intro) : "") + cards.join("") + (round.outro ? renderMarkdown(round.outro) : "");
}

/**
 * Fait défiler la conversation jusqu'à la carte de la question Qn : la plus proche au-dessus
 * de `from` (pastille d'une réponse), ou la dernière (formulaire, sous la conversation).
 */
export function scrollToQuestion(from: HTMLElement, n: string) {
  const root = from.closest(".terminal-view")?.querySelector(".conversation") ?? document;
  const cards = [...root.querySelectorAll<HTMLElement>(`.grill-card[data-grill-n="${n}"]`)];
  const before = cards.filter((c) => c.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING);
  const card = before[before.length - 1] ?? cards[cards.length - 1];
  if (!card) return;
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.classList.remove("search-focused");
  void card.offsetWidth; // relance l'animation si elle était en cours
  card.classList.add("search-focused");
  setTimeout(() => card.classList.remove("search-focused"), 2000);
}

/** Lignes « Q1 — Titre : réponse » d'un message, ou null s'il ne commence pas par l'une d'elles. */
function answerLines(text: string): { n: string | null; text: string }[] | null {
  const lines = text.split(/\r?\n/);
  if (!ANSWER_LINE.test(lines[0] ?? "")) return null;
  const out: { n: string | null; text: string }[] = [];
  let rest: string[] = [];
  const flush = () => {
    if (rest.join("").trim()) out.push({ n: null, text: rest.join("\n").trim() });
    rest = [];
  };
  for (const l of lines) {
    const m = ANSWER_LINE.exec(l);
    if (m) {
      flush();
      out.push({ n: m[1], text: l.slice(m[0].length) });
    } else rest.push(l);
  }
  flush();
  return out;
}

/** Réponses à une série : une pastille « Q1 » par ligne (clic : la question), puis le commentaire. */
export function GrillAnswers({ text }: { text: string }) {
  const lines = useMemo(() => answerLines(text), [text]);
  if (!lines) return <>{text}</>;
  return (
    <>
      {lines.map((l, i) =>
        l.n != null ? (
          <div key={i} className="grill-answer-line">
            <button className="grill-chip" title={t("tools.grill.seeQuestion", { n: l.n })} onClick={(e) => scrollToQuestion(e.currentTarget, l.n!)}>
              Q{l.n}
            </button>
            <span>{l.text}</span>
          </div>
        ) : (
          <div key={i} className="grill-answer-rest">
            {l.text}
          </div>
        ),
      )}
    </>
  );
}

/** Le message est une réponse à une série (pour la mise en forme de la bulle). */
export function isGrillAnswer(text: string): boolean {
  return ANSWER_LINE.test(text);
}

// ---- Formulaire de réponse ---------------------------------------------------------------

/**
 * Série en attente de réponse et mode choisi : le formulaire, ou la zone de saisie normale
 * (« Répondre en texte libre », ou réponses déjà envoyées). Le choix est gardé avec le brouillon.
 */
export function useGrillMode(sessionId: string, pending: PendingRound | null) {
  const key = pending?.key ?? null;
  const [freeText, setFree] = useState(() => (key ? getDraft(sessionId, key).freeText : false));
  useEffect(() => setFree(key ? getDraft(sessionId, key).freeText : false), [sessionId, key]);
  const setFreeText = (v: boolean) => {
    if (!key) return;
    setDraft(sessionId, key, { ...getDraft(sessionId, key), freeText: v });
    setFree(v);
  };
  return { showForm: pending != null && !freeText, freeTextOnRound: pending != null && freeText, setFreeText };
}

/** Bandeau au-dessus de la zone de saisie quand une série attend : retour au formulaire. */
export function GrillBackBar({ count, onBack }: { count: number; onBack: () => void }) {
  return (
    <div className="grill-back">
      <MessageSquareText size={13} />
      <span>{t("tools.grill.pendingCount", { count })}</span>
      <button className="link-btn" onClick={onBack}>
        {t("tools.grill.backToForm")}
      </button>
    </div>
  );
}

interface FormProps {
  sessionId: string;
  pending: PendingRound;
  /** `claude` tourne dans le terminal : on peut envoyer. */
  enabled: boolean;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  /** Passe à la zone de saisie normale (le brouillon est gardé). */
  onFreeText: () => void;
  autoFocus: boolean;
}

const CHOICES: { choice: Choice; label: MessageKey; icon: typeof Check; title: MessageKey }[] = [
  { choice: "yes", label: "tools.grill.choiceYes", icon: Check, title: "tools.grill.choiceYesTitle" },
  { choice: "no", label: "tools.grill.choiceNo", icon: X, title: "tools.grill.choiceNoTitle" },
  { choice: "other", label: "tools.grill.choiceOther", icon: PenLine, title: "tools.grill.choiceOtherTitle" },
];

export function GrillForm({ sessionId, pending, enabled, onSend, onStop, onFreeText, autoFocus }: FormProps) {
  const { round, key } = pending;
  const [draft, setLocal] = useState<Draft>(() => getDraft(sessionId, key));
  const [sending, setSending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Autre série (ou autre conversation) : son propre brouillon.
  useEffect(() => setLocal(getDraft(sessionId, key)), [sessionId, key]);

  const update = (next: Draft) => {
    setLocal(next);
    setDraft(sessionId, key, next);
  };
  const setAnswer = (n: string, a: Answer) => update({ ...draft, answers: { ...draft.answers, [n]: a } });

  const answered = round.questions.filter((q) => isAnswered(draft.answers[q.n])).length;
  const complete = answered === round.questions.length;

  useEffect(() => {
    if (autoFocus) rootRef.current?.querySelector<HTMLElement>(".grill-choice")?.focus();
  }, [autoFocus, key]);

  const send = async () => {
    if (!complete || !enabled || sending) return;
    setSending(true);
    try {
      await onSend(formatAnswers(round, draft));
      // Envoyé : le formulaire laisse la place à la zone de saisie jusqu'à la suite de
      // Claude, et les réponses restent si on revient aux questions.
      update({ ...draft, freeText: true });
      onFreeText();
    } catch {
      /* terminal fermé entre-temps : les réponses restent */
    } finally {
      setSending(false);
    }
  };

  // Ctrl+Entrée (⌘+Entrée sur Mac) envoie, depuis n'importe quel champ du formulaire.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const choose = (n: string, choice: Choice, hasReco: boolean, el: HTMLElement) => {
    const prev = draft.answers[n];
    setAnswer(n, { choice, text: prev?.text ?? "" });
    // « Non » ou « Autre réponse » : le curseur va dans le champ ; « D'accord » : question suivante.
    requestAnimationFrame(() => {
      const card = el.closest(".grill-q");
      if (choice !== "yes" || !hasReco) card?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      else (card?.nextElementSibling?.querySelector<HTMLElement>(".grill-choice") ?? rootRef.current?.querySelector<HTMLElement>(".grill-send"))?.focus();
    });
  };

  return (
    <div className="grill-form" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="grill-form-head">
        <MessageSquareText size={14} />
        <span className="grill-form-title">
          {t("tools.grill.formTitle", { total: round.questions.length, answered })}
        </span>
        <button className="link-btn" onClick={onFreeText} title={t("tools.grill.freeTextTitle")}>
          {t("tools.grill.freeText")}
        </button>
      </div>
      <div className="grill-list">
        {round.intro && <div className="grill-text markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(round.intro) }} />}
        {round.questions.map((q) => {
          const a = draft.answers[q.n];
          const hasReco = q.recommendation != null;
          // Sans recommandation, seule une réponse libre a du sens.
          const choice = hasReco ? (a?.choice ?? null) : "other";
          const done = isAnswered(hasReco ? a : a && { ...a, choice: "other" });
          return (
            <div key={q.n} className={"grill-q" + (done ? " done" : "")}>
              <div className="grill-q-head">
                <span className="grill-num">Q{q.n}</span>
                <span className="grill-title" dangerouslySetInnerHTML={{ __html: renderMarkdownInline(q.title) }} />
                {done && <Check size={13} className="grill-q-check" />}
              </div>
              {q.body && <div className="grill-q-body markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(q.body) }} />}
              {hasReco && (
                <div className="grill-reco">
                  <span className="grill-reco-label">{t("tools.grill.recommended")}</span>
                  <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(q.recommendation!) }} />
                </div>
              )}
              {hasReco && (
                <div className="grill-choices">
                  {CHOICES.map((c) => (
                    <button
                      key={c.choice}
                      className={"btn small grill-choice" + (choice === c.choice ? " selected " + c.choice : "")}
                      title={t(c.title)}
                      onClick={(e) => choose(q.n, c.choice, hasReco, e.currentTarget)}
                    >
                      <c.icon size={12} /> {t(c.label)}
                    </button>
                  ))}
                </div>
              )}
              {(choice === "no" || choice === "other") && (
                <AutoTextarea
                  className="grill-q-text"
                  value={a?.text ?? ""}
                  placeholder={choice === "no" ? t("tools.grill.whyPlaceholder") : t("tools.grill.answerPlaceholder")}
                  onChange={(text) => setAnswer(q.n, { choice: choice as Choice, text })}
                />
              )}
            </div>
          );
        })}
        {round.outro && <div className="grill-text markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(round.outro) }} />}
      </div>
      <div className="grill-form-foot">
        <AutoTextarea className="grill-comment" value={draft.comment} placeholder={t("tools.grill.commentPlaceholder")} onChange={(comment) => update({ ...draft, comment })} />
        <button className="btn small" onClick={onStop} disabled={!enabled} title={t("tools.grill.stopTitle")}>
          <Square size={12} /> {t("tools.grill.stop")}
        </button>
        <button
          className="btn small primary grill-send"
          onClick={send}
          disabled={!enabled || !complete || sending}
          title={complete ? t("tools.grill.sendTitle", { shortcut: modKey }) : t("tools.grill.sendIncomplete")}
        >
          <SendHorizontal size={13} /> {t("tools.grill.send")}
        </button>
      </div>
    </div>
  );
}

/** Zone de texte qui grandit avec son contenu (jusqu'à une limite). */
function AutoTextarea({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder: string; className: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [value]);
  return <textarea ref={ref} rows={1} className={className} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}
