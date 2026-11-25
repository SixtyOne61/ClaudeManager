// Boîtes de dialogue internes : saisie d'un texte, création d'un projet.

import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import type { Category } from "../api";
import { t } from "../i18n";

export function Modal({ title, children, onClose, className }: { title: string; children: React.ReactNode; onClose: () => void; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={"modal" + (className ? " " + className : "")} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Demande un texte (nom de catégorie, nom d'affichage…). */
export function TextPrompt(props: {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  allowEmpty?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(props.initial ?? "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const valid = props.allowEmpty || value.trim().length > 0;
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) props.onSubmit(value.trim());
        }}
      >
        <label className="field">
          <span>{props.label}</span>
          <input ref={input} value={value} placeholder={props.placeholder} onChange={(e) => setValue(e.target.value)} autoFocus />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!valid}>
            {t("app.dialog.submit")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Nouvelle conversation dans un nouveau worktree : nom facultatif (vide = nom choisi par
 * Claude Code), vérifié avec `validate` avant de valider.
 */
export function WorktreePrompt(props: {
  validate: (name: string) => string | null;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const error = props.validate(value);
  return (
    <Modal title={t("app.worktree.newTitle")} onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!error) props.onSubmit(value.trim());
        }}
      >
        <label className="field">
          <span>{t("app.worktree.nameLabel")}</span>
          <input value={value} placeholder={t("app.worktree.namePlaceholder")} onChange={(e) => setValue(e.target.value)} autoFocus spellCheck={false} />
          <small>{error ?? t("app.worktree.nameHint")}</small>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!!error}>
            {t("app.dialog.start")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Règle « worktree » des suggestions : une nouvelle conversation est créée alors que `count`
 * conversations tournent déjà dans le dossier du projet. `onSubmit(worktree, dontAskAgain)` :
 * `worktree` = nom du worktree (vide = nom choisi par Claude Code), ou null pour « Ici quand
 * même ». Échap ou clic à côté : rien n'est créé.
 */
export function WorktreeOfferDialog(props: {
  count: number;
  validate: (name: string) => string | null;
  onSubmit: (worktree: string | null, dontAskAgain: boolean) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [dontAsk, setDontAsk] = useState(false);
  const error = props.validate(value);
  return (
    <Modal title={t("app.worktree.offerTitle")} onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!error) props.onSubmit(value.trim(), dontAsk);
        }}
      >
        <p className="modal-text">{t("app.worktree.offerText", { count: props.count })}</p>
        <label className="field">
          <span>{t("app.worktree.nameLabel")}</span>
          <input value={value} placeholder={t("app.worktree.namePlaceholder")} onChange={(e) => setValue(e.target.value)} autoFocus spellCheck={false} />
          <small>{error ?? t("app.worktree.nameHint")}</small>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
          {t("app.worktree.dontAskAgain")}
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => props.onSubmit(null, dontAsk)}>
            {t("app.worktree.hereAnyway")}
          </button>
          <button type="submit" className="btn primary" disabled={!!error}>
            {t("app.worktree.inWorktree")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export interface NewProjectResult {
  path: string;
  categoryId: string | null;
  displayName: string;
  /** Langue des réponses de Claude dans ce projet (null = réglage habituel). */
  language: string | null;
  startConversation: boolean;
}

/** Langues proposées : valeur du réglage `language` de Claude Code → libellé. */
const LANGUAGES: [string, string][] = [
  ["french", "Français"],
  ["english", "English"],
  ["spanish", "Español"],
  ["german", "Deutsch"],
  ["italian", "Italiano"],
  ["portuguese", "Português"],
  ["dutch", "Nederlands"],
  ["japanese", "日本語"],
  ["chinese", "中文"],
  ["korean", "한국어"],
];

/**
 * Nouveau projet : choix (ou création, via le bouton « Nouveau dossier » de la
 * boîte de dialogue Windows) d'un dossier, puis d'une catégorie.
 */
export function NewProjectDialog(props: {
  categories: Category[];
  defaultCategoryId: string | null;
  onSubmit: (r: NewProjectResult) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [categoryId, setCategoryId] = useState<string>(props.defaultCategoryId ?? "");
  const [displayName, setDisplayName] = useState("");
  const [language, setLanguage] = useState("");
  const [startConversation, setStartConversation] = useState(true);

  const pick = async () => {
    const chosen = await open({ directory: true, multiple: false, title: t("app.newProject.pickTitle") });
    if (typeof chosen === "string") setPath(chosen);
  };

  return (
    <Modal title={t("app.newProject.title")} onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (path) props.onSubmit({ path, categoryId: categoryId || null, displayName: displayName.trim(), language: language || null, startConversation });
        }}
      >
        <label className="field">
          <span>{t("app.newProject.folder")}</span>
          <div className="path-row">
            <input value={path} readOnly placeholder={t("app.newProject.noFolder")} onClick={pick} />
            <button type="button" className="btn" onClick={pick}>
              <FolderOpen size={14} /> {t("app.newProject.browse")}
            </button>
          </div>
          <small>{t("app.newProject.folderHint")}</small>
        </label>
        <label className="field">
          <span>{t("app.newProject.category")}</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">{t("app.newProject.uncategorized")}</option>
            {props.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("app.newProject.displayName")}</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t("app.newProject.displayNamePlaceholder")} />
        </label>
        <label className="field">
          <span>{t("app.newProject.language")}</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="">{t("app.newProject.languageDefault")}</option>
            {LANGUAGES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <small>{t("app.newProject.languageHint")}</small>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={startConversation} onChange={(e) => setStartConversation(e.target.checked)} />
          {t("app.newProject.startConversation")}
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!path}>
            {t("common.create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
