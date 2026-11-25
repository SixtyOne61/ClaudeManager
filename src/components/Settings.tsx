// Réglages de l'app (menu « … » de la barre latérale), en onglets latéraux comme les
// réglages de Rider : affichage, les suggestions (voir
// src/suggestions.ts) — une case par règle pour la couper, le seuil de la règle
// « Contexte rempli », l'inactivité et le contexte de la règle « Conversation ancienne » — et
// la consigne du résumé de passation du hand off (voir
// src/handoff.ts). Chaque changement est enregistré tout de suite dans config.json.

import { useEffect, useRef, useState } from "react";
import type { Config } from "../api";
import {
  CONTEXT_THRESHOLD_MAX,
  CONTEXT_THRESHOLD_MIN,
  RULE_STALE,
  STALE_MINUTES_MAX,
  STALE_MINUTES_MIN,
  STALE_PERCENT_MAX,
  STALE_PERCENT_MIN,
  SUGGESTION_RULES,
  isRuleEnabled,
  setContextThreshold,
  setRuleEnabled,
  setStaleMinutes,
  setStalePercent,
  suggestionSettings,
} from "../suggestions";
import { DEFAULT_HANDOFF_PROMPT, handoffPrompt, setHandoffPrompt } from "../handoff";
import { Modal } from "./Dialogs";
import { LanguageSettings } from "./LanguageSettings";
import { t } from "../i18n";

/** Onglets des réglages, dans l'ordre de la liste latérale. */
const SETTINGS_TABS = [
  { id: "display", labelKey: "settings.tab.display" },
  { id: "suggestions", labelKey: "settings.tab.suggestions" },
  { id: "handoff", labelKey: "settings.tab.handoff" },
  { id: "language", labelKey: "settings.tab.language" },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

/** Dernier onglet consulté (préférence locale, comme celles de la barre latérale). */
const TAB_PREF = "claudeManager.settingsTab";
function loadTab(): SettingsTab {
  try {
    const v = localStorage.getItem(TAB_PREF);
    if (SETTINGS_TABS.some((tb) => tb.id === v)) return v as SettingsTab;
  } catch {
    /* stockage indisponible */
  }
  return "display";
}

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

  const [tab, setTab] = useState<SettingsTab>(loadTab);
  const chooseTab = (id: SettingsTab) => {
    setTab(id);
    try {
      localStorage.setItem(TAB_PREF, id);
    } catch {
      /* préférence non mémorisée */
    }
  };

  const panels: Record<SettingsTab, React.ReactNode> = {
    language: <LanguageSettings config={config} onChange={onChange} />,
    display: (
      <>
        <h3 className="settings-heading">{t("settings.tab.display")}</h3>
        <div className="settings-rule">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={config.showTempProjects}
              onChange={(e) => onChange((c) => ({ ...c, showTempProjects: e.target.checked }))}
            />
            {t("settings.display.showTempProjects")}
          </label>
          <small className="settings-rule-help">{t("settings.display.showTempProjectsHelp")}</small>
        </div>
      </>
    ),
    suggestions: (
      <>
        <h3 className="settings-heading">{t("settings.tab.suggestions")}</h3>
        <p className="settings-help">{t("settings.suggestions.help")}</p>
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
                  {t("settings.suggestions.thresholdBefore")}
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
                  {t("settings.suggestions.thresholdAfter")}
                </label>
              )}
              {id === RULE_STALE && (
                <>
                  <NumberSetting
                    before={t("settings.suggestions.staleMinutesBefore")}
                    after={t("settings.suggestions.staleMinutesAfter")}
                    min={STALE_MINUTES_MIN}
                    max={STALE_MINUTES_MAX}
                    step={5}
                    value={suggestionSettings(config).staleMinutes}
                    disabled={!enabled}
                    onCommit={(n) => onChange((c) => setStaleMinutes(c, n))}
                  />
                  <NumberSetting
                    before={t("settings.suggestions.stalePercentBefore")}
                    after={t("settings.suggestions.stalePercentAfter")}
                    min={STALE_PERCENT_MIN}
                    max={STALE_PERCENT_MAX}
                    step={5}
                    value={suggestionSettings(config).stalePercent}
                    disabled={!enabled}
                    onCommit={(n) => onChange((c) => setStalePercent(c, n))}
                  />
                </>
              )}
            </div>
          );
        })}
      </>
    ),
    handoff: (
      <>
        <h3 className="settings-heading">{t("settings.tab.handoff")}</h3>
        <p className="settings-help">
          {t("settings.handoff.help")}
        </p>
        <textarea
          className="settings-textarea"
          rows={5}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={commitPrompt}
          aria-label={t("settings.handoff.promptLabel")}
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
            {t("settings.handoff.resetDefault")}
          </button>
        </div>
      </>
    ),
  };

  return (
    <Modal title={t("settings.title")} onClose={close} className="settings-modal">
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <div className="settings-body">
          <nav className="settings-tabs" role="tablist" aria-label={t("settings.tabsLabel")}>
            {SETTINGS_TABS.map((tb) => (
              <button
                key={tb.id}
                type="button"
                role="tab"
                aria-selected={tab === tb.id}
                className={"settings-tab" + (tab === tb.id ? " active" : "")}
                onClick={() => chooseTab(tb.id)}
              >
                {t(tb.labelKey)}
              </button>
            ))}
          </nav>
          <div className="settings-panel" role="tabpanel">
            {panels[tab]}
          </div>
        </div>
        <div className="modal-actions">
          <button type="submit" className="btn primary">
            {t("common.close")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Champ numérique d'un réglage, enregistré quand il perd le focus, sur Entrée, ou quand il
 * disparaît (changement d'onglet, fermeture). Une saisie vide ou invalide est abandonnée ; la
 * valeur est bornée.
 */
function NumberSetting(props: {
  before: string;
  after: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled: boolean;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  const latest = useRef({ text, props });
  latest.current = { text, props };
  const commit = () => {
    const { text, props: p } = latest.current;
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) {
      setText(String(p.value));
      return;
    }
    const clamped = Math.round(Math.min(p.max, Math.max(p.min, n)));
    setText(String(clamped));
    if (clamped !== p.value) p.onCommit(clamped);
  };
  useEffect(() => () => commit(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="settings-inline">
      {props.before}
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={text}
        disabled={props.disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      {props.after}
    </label>
  );
}
