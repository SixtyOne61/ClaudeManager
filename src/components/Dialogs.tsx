// Boîtes de dialogue internes : saisie d'un texte, création d'un projet.

import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import type { Category } from "../api";

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
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

export interface NewProjectResult {
  path: string;
  categoryId: string | null;
  displayName: string;
  startConversation: boolean;
}

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
          if (path) props.onSubmit({ path, categoryId: categoryId || null, displayName: displayName.trim(), startConversation });
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
