// Boîtes de dialogue internes : saisie d'un texte, création d'un projet.

import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import type { Category } from "../api";

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
            Annuler
          </button>
          <button type="submit" className="btn primary" disabled={!valid}>
            Valider
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
    <Modal title="Nouvelle conversation dans un nouveau worktree" onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!error) props.onSubmit(value.trim());
        }}
      >
        <label className="field">
          <span>Nom du worktree (facultatif)</span>
          <input value={value} placeholder="ex. correction-connexion" onChange={(e) => setValue(e.target.value)} autoFocus spellCheck={false} />
          <small>
            {error ?? "Copie de travail séparée dans .claude\\worktrees\\<nom>, sur la branche worktree-<nom>. Sans nom, Claude Code en choisit un."}
          </small>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={props.onClose}>
            Annuler
          </button>
          <button type="submit" className="btn primary" disabled={!!error}>
            Démarrer
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
  const count = props.count === 2 ? "Deux" : String(props.count);
  return (
    <Modal title="Démarrer dans un worktree ?" onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!error) props.onSubmit(value.trim(), dontAsk);
        }}
      >
        <p className="modal-text">
          {count} conversations tournent déjà dans ce dossier. Démarrer celle-ci dans un worktree pour éviter qu'elles se marchent dessus ?
        </p>
        <label className="field">
          <span>Nom du worktree (facultatif)</span>
          <input value={value} placeholder="ex. correction-connexion" onChange={(e) => setValue(e.target.value)} autoFocus spellCheck={false} />
          <small>
            {error ?? "Copie de travail séparée dans .claude\\worktrees\\<nom>, sur la branche worktree-<nom>. Sans nom, Claude Code en choisit un."}
          </small>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
          Ne plus demander pour ce projet
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => props.onSubmit(null, dontAsk)}>
            Ici quand même
          </button>
          <button type="submit" className="btn primary" disabled={!!error}>
            Dans un worktree
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
    const chosen = await open({ directory: true, multiple: false, title: "Choisir ou créer le dossier du projet" });
    if (typeof chosen === "string") setPath(chosen);
  };

  return (
    <Modal title="Nouveau projet" onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (path) props.onSubmit({ path, categoryId: categoryId || null, displayName: displayName.trim(), language: language || null, startConversation });
        }}
      >
        <label className="field">
          <span>Dossier</span>
          <div className="path-row">
            <input value={path} readOnly placeholder="Aucun dossier choisi" onClick={pick} />
            <button type="button" className="btn" onClick={pick}>
              <FolderOpen size={14} /> Parcourir…
            </button>
          </div>
          <small>Pour créer un dossier, utilisez « Nouveau dossier » dans la fenêtre de sélection.</small>
        </label>
        <label className="field">
          <span>Catégorie</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Non classés</option>
            {props.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Nom d'affichage (facultatif)</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Nom du dossier par défaut" />
        </label>
        <label className="field">
          <span>Langue des réponses de Claude</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="">Par défaut (réglage habituel)</option>
            {LANGUAGES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <small>Enregistrée dans .claude\settings.local.json du projet.</small>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={startConversation} onChange={(e) => setStartConversation(e.target.checked)} />
          Lancer une nouvelle conversation dans ce dossier
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={props.onClose}>
            Annuler
          </button>
          <button type="submit" className="btn primary" disabled={!path}>
            Créer
          </button>
        </div>
      </form>
    </Modal>
  );
}
