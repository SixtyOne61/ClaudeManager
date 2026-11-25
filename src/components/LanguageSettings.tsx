// Onglet « Langue » des réglages : langues disponibles (le français, intégré, et les langues
// déjà traduites), choix de la langue, suppression, et traduction dans une autre langue
// tapée librement (voir src/i18n/translate.ts). La traduction continue si la fenêtre est
// fermée ; la langue est choisie automatiquement quand elle se termine sans erreur.

import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Languages, Trash2, X } from "lucide-react";
import { api, errorMessage, type Config, type LanguageInfo } from "../api";
import { SOURCE_LANGUAGE, t } from "../i18n";
import {
  cancelTranslation,
  clearTranslationJob,
  getTranslationJob,
  identifyLanguage,
  pendingCount,
  startTranslation,
  translationRunning,
  useTranslationJob,
} from "../i18n/translate";

export function LanguageSettings(props: { config: Config; onChange: (change: (c: Config) => Config) => void }) {
  const current = props.config.language || SOURCE_LANGUAGE;
  const job = useTranslationJob();
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [pending, setPending] = useState(0);
  const [input, setInput] = useState("");
  const [identifying, setIdentifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Liste et textes à traduire, relus quand une traduction avance ou se termine.
  const progress = job ? `${job.code}:${job.done}:${job.finished ? 1 : 0}` : "";
  useEffect(() => {
    api.languagesList().then(setLanguages).catch(() => {});
    if (current === SOURCE_LANGUAGE) setPending(0);
    else pendingCount(current).then(setPending).catch(() => setPending(0));
  }, [current, progress]);

  const choose = (code: string) => props.onChange((c) => ({ ...c, language: code === SOURCE_LANGUAGE ? null : code }));

  /** Traduit (ou complète) une langue, puis la choisit si tout s'est bien passé. */
  const translate = async (code: string, name: string) => {
    setError(null);
    await startTranslation(code, name);
    const end = getTranslationJob();
    if (end?.code === code && end.finished && !end.finished.error && !end.finished.cancelled) choose(code);
  };

  const submit = async () => {
    const text = input.trim();
    if (!text || identifying || translationRunning()) return;
    setError(null);
    setIdentifying(true);
    try {
      const lang = await identifyLanguage(text);
      setInput("");
      if (lang.code === SOURCE_LANGUAGE) return choose(SOURCE_LANGUAGE);
      const known = languages.find((l) => l.code === lang.code);
      if (known && (await pendingCount(lang.code)) === 0) return choose(lang.code);
      await translate(lang.code, known?.name ?? lang.name);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setIdentifying(false);
    }
  };

  const remove = async (l: LanguageInfo) => {
    const ok = await ask(t("settings.language.deleteConfirm", { name: l.name }), {
      title: t("settings.language.deleteTitle"),
      kind: "warning",
      okLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    try {
      await api.languageDelete(l.code);
      if (current === l.code) choose(SOURCE_LANGUAGE);
      setLanguages((list) => list.filter((x) => x.code !== l.code));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const running = job !== null && job.finished === null;
  const currentName = languages.find((l) => l.code === current)?.name ?? current;

  return (
    <>
      <h3 className="settings-heading">{t("settings.tab.language")}</h3>
      <p className="settings-help">{t("settings.language.help")}</p>

      <div className="language-list" role="radiogroup" aria-label={t("settings.tab.language")}>
        <LanguageRow name="Français" hint={t("settings.language.builtIn")} active={current === SOURCE_LANGUAGE} onChoose={() => choose(SOURCE_LANGUAGE)} />
        {languages.map((l) => (
          <LanguageRow
            key={l.code}
            name={l.name}
            hint={l.code}
            active={current === l.code}
            onChoose={() => choose(l.code)}
            onDelete={running && job?.code === l.code ? undefined : () => remove(l)}
          />
        ))}
      </div>

      {current !== SOURCE_LANGUAGE && pending > 0 && !running && (
        <div className="settings-rule language-pending">
          <span>{t("settings.language.pending", { count: pending, name: currentName })}</span>
          <button type="button" className="btn small" onClick={() => translate(current, currentName)}>
            {t("settings.language.update")}
          </button>
        </div>
      )}

      <div className="language-add">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t("settings.language.otherPlaceholder")}
          disabled={identifying || running}
          aria-label={t("settings.language.otherPlaceholder")}
        />
        <button type="button" className="btn small primary" disabled={!input.trim() || identifying || running} onClick={submit}>
          <Languages size={13} /> {identifying ? t("settings.language.identifying") : t("settings.language.translate")}
        </button>
      </div>
      <small className="settings-rule-help language-note">{t("settings.language.note")}</small>
      {error && <div className="language-error">{error}</div>}

      {job && (
        <div className="language-job">
          {job.finished === null ? (
            <>
              <span>{t("settings.language.progress", { name: job.name, done: job.done, total: job.total })}</span>
              <progress max={job.total || 1} value={job.done} />
              <button type="button" className="btn small ghost" onClick={cancelTranslation}>
                {t("common.cancel")}
              </button>
            </>
          ) : (
            <>
              <span className={job.finished.error ? "language-error" : undefined}>
                {job.finished.error
                  ? t("settings.language.failed", { name: job.name, error: job.finished.error })
                  : job.finished.cancelled
                    ? t("settings.language.cancelled", { name: job.name, done: job.done, total: job.total })
                    : t("settings.language.done", { name: job.name })}
              </span>
              <button type="button" className="icon-btn" title={t("common.close")} onClick={clearTranslationJob}>
                <X size={13} />
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}

function LanguageRow(props: { name: string; hint: string; active: boolean; onChoose: () => void; onDelete?: () => void }) {
  return (
    <div className={"language-row" + (props.active ? " active" : "")}>
      <label className="checkbox">
        <input type="radio" name="language" checked={props.active} onChange={props.onChoose} />
        <span className="language-name">{props.name}</span>
        <span className="language-hint">{props.hint}</span>
      </label>
      {props.onDelete && (
        <button type="button" className="icon-btn" title={t("settings.language.delete")} onClick={props.onDelete}>
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}
