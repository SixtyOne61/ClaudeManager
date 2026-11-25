// Confirmation de Claude Code reprise dans la conversation (voir src/terminalPrompt.ts) : son
// texte tel que Claude Code l'affiche, un bouton par option et « Annuler » (Échap). La carte
// prend la place de la zone de saisie tant que la boîte est ouverte dans le terminal.

import { useEffect, useRef, useState } from "react";
import { CircleHelp } from "lucide-react";
import { answerKeys, CANCEL_KEYS, type ConfirmPrompt } from "../terminalPrompt";
import { t } from "../i18n";

interface Props {
  prompt: ConfirmPrompt;
  /** Touches à envoyer au terminal. */
  onAnswer: (keys: string) => void;
  autoFocus?: boolean;
}

export function ConfirmCard({ prompt, onAnswer, autoFocus }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Une réponse par boîte : un double clic n'envoie pas deux fois les touches.
  const [answered, setAnswered] = useState(false);
  useEffect(() => setAnswered(false), [prompt.title]);

  useEffect(() => {
    if (autoFocus) rootRef.current?.querySelector<HTMLButtonElement>(".confirm-option")?.focus();
  }, [autoFocus, prompt.title]);

  const answer = (keys: string) => {
    if (answered) return;
    setAnswered(true);
    onAnswer(keys);
  };

  return (
    <div
      className="confirm-card"
      ref={rootRef}
      role="alertdialog"
      aria-label={prompt.title}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          answer(CANCEL_KEYS);
        }
      }}
    >
      <div className="confirm-head">
        <CircleHelp size={14} />
        <span className="confirm-label">{t("conversation.confirm.label")}</span>
      </div>
      <div className="confirm-title">{prompt.title}</div>
      {prompt.details.map((d, i) => (
        <div key={i} className="confirm-detail">
          {d}
        </div>
      ))}
      <div className="confirm-actions">
        {prompt.options.map((o, i) => (
          <button
            key={i}
            className={"btn small confirm-option" + (i === 0 ? " primary" : "")}
            disabled={answered}
            onClick={() => answer(answerKeys(prompt, i))}
          >
            {o}
          </button>
        ))}
        <button className="btn small ghost" disabled={answered} onClick={() => answer(CANCEL_KEYS)} title={t("conversation.confirm.cancelTitle")}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
