// Réglages de l'app (menu « … » de la barre latérale) : les suggestions (voir
// src/suggestions.ts) — une case par règle pour la couper, et le seuil de la règle
// « Contexte rempli » — et la consigne du résumé de passation du hand off (voir
// src/handoff.ts). Chaque changement est enregistré tout de suite dans config.json.

import { useState } from "react";
import type { Config } from "../api";
import {
  CONTEXT_THRESHOLD_MAX,
  CONTEXT_THRESHOLD_MIN,
  SUGGESTION_RULES,
  isRuleEnabled,
  setContextThreshold,
  setRuleEnabled,
  suggestionSettings,
} from "../suggestions";
import { DEFAULT_HANDOFF_PROMPT, handoffPrompt, setHandoffPrompt } from "../handoff";
import { Modal } from "./Dialogs";

export function SettingsDialog(props: { config: Config; onChange: (change: (c: Config) => Config) => void; onClose: () => void }) {
  const { config, onChange } = props;
  const saved = suggestionSettings(config).contextThreshold;
  const [threshold, setThreshold] = useState(String(saved));

  type Change = ((c: Config) => Config) | null;

  /** Seuil saisi, enregistré quand le champ perd le focus (ou à la fermeture). */
  const thresholdChange = (): Change => {
    const n = Number(threshold);
    if (!Number.isFinite(n) || threshold.trim() === "") {
      setThreshold(String(saved));
      return null;
    }
    const clamped = Math.round(Math.min(CONTEXT_THRESHOLD_MAX, Math.max(CONTEXT_THRESHOLD_MIN, n)));
    setThreshold(String(clamped));
    return clamped !== saved ? (c) => setContextThreshold(c, clamped) : null;
  };

  // Consigne du résumé de passation (hand off), enregistrée quand le champ perd le focus.
  const savedPrompt = handoffPrompt(config);
  const [prompt, setPrompt] = useState(savedPrompt);
  const promptChange = (): Change => {
    if (!prompt.trim()) {
      setPrompt(savedPrompt);
      return null;
    }
    return prompt.trim() !== savedPrompt ? (c) => setHandoffPrompt(c, prompt) : null;
  };

  const commit = (change: Change) => change && onChange(change);
  const commitThreshold = () => commit(thresholdChange());
  const commitPrompt = () => commit(promptChange());

  /** Fermeture : les champs pas encore enregistrés le sont en une seule fois. */
  const close = () => {
    const changes = [thresholdChange(), promptChange()].filter((c): c is (c: Config) => Config => c !== null);
    if (changes.length) onChange((c) => changes.reduce((acc, f) => f(acc), c));
    props.onClose();
  };

  return (
    <Modal title="Réglages" onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <h3 className="settings-heading">Affichage</h3>
        <div className="settings-rule">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={config.showTempProjects}
              onChange={(e) => onChange((c) => ({ ...c, showTempProjects: e.target.checked }))}
            />
            Afficher les projets temporaires
          </label>
          <small className="settings-rule-help">Projets situés dans un dossier temporaire, masqués par défaut dans la barre latérale.</small>
        </div>
        <h3 className="settings-heading">Suggestions</h3>
        <p className="settings-help">L'app propose une bonne pratique quand elle repère une situation (icône 💡). Elle n'agit jamais d'elle-même.</p>
        {Object.entries(SUGGESTION_RULES).map(([id, rule]) => {
          const enabled = isRuleEnabled(config, id);
          return (
            <div key={id} className="settings-rule">
              <label className="checkbox">
                <input type="checkbox" checked={enabled} onChange={(e) => onChange((c) => setRuleEnabled(c, id, e.target.checked))} />
                {rule.label}
              </label>
              <small className="settings-rule-help">{rule.description}</small>
              {id === "context" && (
                <label className="settings-inline">
                  Seuil :
                  <input
                    type="number"
                    min={CONTEXT_THRESHOLD_MIN}
                    max={CONTEXT_THRESHOLD_MAX}
                    step={5}
                    value={threshold}
                    disabled={!enabled}
                    onChange={(e) => setThreshold(e.target.value)}
                    onBlur={commitThreshold}
                  />
                  % du contexte
                </label>
              )}
            </div>
          );
        })}
        <h3 className="settings-heading">Hand off</h3>
        <p className="settings-help">
          Consigne tapée dans la conversation pour lui faire rédiger son résumé de passation. La réponse devient le premier message de la nouvelle conversation.
        </p>
        <textarea
          className="settings-textarea"
          rows={5}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={commitPrompt}
          aria-label="Consigne du résumé de passation"
        />
        <div className="settings-inline-actions">
          <button
            type="button"
            className="btn small ghost"
            disabled={prompt.trim() === DEFAULT_HANDOFF_PROMPT}
            onClick={() => {
              setPrompt(DEFAULT_HANDOFF_PROMPT);
              onChange((c) => setHandoffPrompt(c, null));
            }}
          >
            Rétablir le texte par défaut
          </button>
        </div>
        <div className="modal-actions">
          <button type="submit" className="btn primary">
            Fermer
          </button>
        </div>
      </form>
    </Modal>
  );
}
