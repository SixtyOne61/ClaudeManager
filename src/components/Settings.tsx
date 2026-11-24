// Réglages de l'app (menu « … » de la barre latérale) : les suggestions (voir
// src/suggestions.ts) — une case par règle pour la couper, et le seuil de la règle
// « Contexte rempli ». Chaque changement est enregistré tout de suite dans config.json.

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

  const commit = (change: Change) => change && onChange(change);
  const commitThreshold = () => commit(thresholdChange());

  /** Fermeture : le seuil pas encore enregistré l'est. */
  const close = () => {
    commit(thresholdChange());
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
        <div className="modal-actions">
          <button type="submit" className="btn primary">
            Fermer
          </button>
        </div>
      </form>
    </Modal>
  );
}
