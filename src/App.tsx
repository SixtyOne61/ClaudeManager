// Composant racine : charge les données, garde la configuration et relie les vues au backend.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import {
  api,
  ERR_ACTIVE,
  errorMessage,
  type ArchiveEntry,
  type Category,
  type Config,
  type ProjectInfo,
  type ScanResult,
  type SessionInfo,
} from "./api";
import { Sidebar, type Selection } from "./components/Sidebar";
import { ProjectView } from "./components/ProjectView";
import { ArchivesView } from "./components/ArchivesView";
import { NewProjectDialog, TextPrompt } from "./components/Dialogs";
import { newId, projectName } from "./util";

/** Boîte de dialogue ouverte (une seule à la fois). */
type DialogState =
  | { kind: "newCategory" }
  | { kind: "renameCategory"; category: Category }
  | { kind: "renameProject"; project: ProjectInfo }
  | { kind: "newProject" }
  | null;

export default function App() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [loading, setLoading] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; text: string; error?: boolean }[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((text: string, error = false) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 8000 : 3500);
  }, []);
  const showError = useCallback((e: unknown) => toast(errorMessage(e), true), [toast]);

  /** Relit les projets et conversations (rapide grâce au cache du backend). */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setScan(await api.scan());
    } catch (e) {
      showError(e);
    } finally {
      setLoading(false);
    }
  }, [showError]);

  // Chargement initial + rafraîchissement automatique quand Claude Code écrit une session.
  useEffect(() => {
    api.getConfig().then(setConfig).catch(showError);
    refresh();
    const unlisten = listen("sessions-changed", () => {
      api.scan().then(setScan).catch(() => {});
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [refresh, showError]);

  /** Modifie la configuration : mise à jour immédiate de l'écran, puis enregistrement. */
  const updateConfig = useCallback(
    async (change: (c: Config) => Config) => {
      if (!config) return;
      const next = change(config);
      setConfig(next);
      try {
        setConfig(await api.saveConfig(next));
      } catch (e) {
        showError(e);
        api.getConfig().then(setConfig).catch(() => {});
      }
    },
    [config, showError],
  );

  const projects = useMemo(() => new Map((scan?.projects ?? []).map((p) => [p.key, p])), [scan]);

  // Sélectionne par défaut le projet le plus récemment actif.
  useEffect(() => {
    if (selection || !scan || !config) return;
    const first = [...scan.projects]
      .filter((p) => !p.isTemp)
      .sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""))[0];
    if (first) setSelection({ kind: "project", key: first.key });
  }, [scan, config, selection]);

  if (!config || !scan) {
    return <div className="loading-screen">Lecture des conversations…</div>;
  }

  const selectedProject = selection?.kind === "project" ? projects.get(selection.key) : undefined;

  // ---- Actions sur les projets / catégories -------------------------------------------

  const setProjectPref = (key: string, patch: Partial<Config["projects"][string]>) =>
    updateConfig((c) => ({ ...c, projects: { ...c.projects, [key]: { ...c.projects[key], ...patch } } }));

  /** Place un projet dans une catégorie (null = Non classés). */
  const moveProject = (key: string, categoryId: string | null) =>
    updateConfig((c) => ({
      ...c,
      categories: c.categories.map((cat) => {
        const keys = cat.projectKeys.filter((k) => k !== key);
        return { ...cat, projectKeys: cat.id === categoryId ? [...keys, key] : keys };
      }),
    }));

  const deleteCategory = async (cat: Category) => {
    const ok = await ask(`Supprimer la catégorie « ${cat.name} » ?\nSes ${cat.projectKeys.length} projet(s) reviendront dans « Non classés ».`, {
      title: "Supprimer la catégorie",
      kind: "warning",
      okLabel: "Supprimer",
      cancelLabel: "Annuler",
    });
    if (ok) updateConfig((c) => ({ ...c, categories: c.categories.filter((x) => x.id !== cat.id) }));
  };

  /** Retire un projet sans conversation de la liste (le dossier n'est pas touché). */
  const forgetProject = (p: ProjectInfo) => {
    updateConfig((c) => {
      const projectsPrefs = { ...c.projects };
      delete projectsPrefs[p.key];
      return {
        ...c,
        projects: projectsPrefs,
        categories: c.categories.map((cat) => ({ ...cat, projectKeys: cat.projectKeys.filter((k) => k !== p.key) })),
      };
    }).then(refresh);
    setSelection(null);
  };

  const launch = (path: string | null, sessionId?: string) => {
    if (!path) return;
    api
      .launchClaude(path, sessionId)
      .then(() => toast(sessionId ? "Reprise de la conversation dans un terminal…" : "Nouvelle conversation dans un terminal…"))
      .catch(showError);
  };

  // ---- Archives / Corbeille -------------------------------------------------------------

  /**
   * Exécute une action sur une session ; si le backend signale une session peut-être
   * encore ouverte, demande confirmation puis recommence en forçant.
   */
  const withActiveCheck = async (run: (force: boolean) => Promise<unknown>) => {
    try {
      await run(false);
      return true;
    } catch (e) {
      const msg = errorMessage(e);
      if (!msg.startsWith(ERR_ACTIVE)) throw e;
      const ok = await ask(msg.replace(`${ERR_ACTIVE}: `, "") + "\n\nContinuer quand même ?", {
        title: "Conversation peut-être en cours",
        kind: "warning",
        okLabel: "Continuer",
        cancelLabel: "Annuler",
      });
      if (!ok) return false;
      await run(true);
      return true;
    }
  };

  const archiveSession = async (s: SessionInfo) => {
    try {
      const done = await withActiveCheck(async (force) => setConfig(await api.archiveSession(s.projectKey, s.id, force)));
      if (done) toast(`« ${s.title} » archivée`);
    } catch (e) {
      showError(e);
    }
    refresh();
  };

  const trashSession = async (s: SessionInfo) => {
    const ok = await ask(`Mettre la conversation « ${s.title} » à la Corbeille ?\nElle pourra être récupérée depuis la Corbeille Windows.`, {
      title: "Supprimer la conversation",
      kind: "warning",
      okLabel: "Mettre à la Corbeille",
      cancelLabel: "Annuler",
    });
    if (!ok) return;
    try {
      const done = await withActiveCheck((force) => api.trashSession(s.projectKey, s.id, force));
      if (done) toast("Conversation envoyée à la Corbeille");
    } catch (e) {
      showError(e);
    }
    refresh();
  };

  const restoreArchive = async (a: ArchiveEntry) => {
    try {
      setConfig(await api.restoreArchive(a.sessionId));
      toast(`« ${a.title} » restaurée`);
    } catch (e) {
      showError(e);
    }
    refresh();
  };

  const trashArchive = async (a: ArchiveEntry) => {
    const ok = await ask(`Mettre la conversation archivée « ${a.title} » à la Corbeille ?`, {
      title: "Supprimer l'archive",
      kind: "warning",
      okLabel: "Mettre à la Corbeille",
      cancelLabel: "Annuler",
    });
    if (!ok) return;
    try {
      setConfig(await api.trashArchive(a.sessionId));
      toast("Archive envoyée à la Corbeille");
    } catch (e) {
      showError(e);
    }
  };

  // ---- Rendu ----------------------------------------------------------------------------

  const defaultCategory = selectedProject ? config.categories.find((c) => c.projectKeys.includes(selectedProject.key))?.id ?? null : null;

  return (
    <div className="app">
      <Sidebar
        config={config}
        projects={projects}
        selection={selection}
        loading={loading}
        onSelect={setSelection}
        onRefresh={refresh}
        onCategoriesChange={(categories) => updateConfig((c) => ({ ...c, categories }))}
        onAddCategory={() => setDialog({ kind: "newCategory" })}
        onRenameCategory={(category) => setDialog({ kind: "renameCategory", category })}
        onDeleteCategory={deleteCategory}
        onAddProject={() => setDialog({ kind: "newProject" })}
        onToggleTemp={(show) => updateConfig((c) => ({ ...c, showTempProjects: show }))}
      />

      {selection?.kind === "archives" ? (
        <ArchivesView config={config} onRestore={restoreArchive} onTrash={trashArchive} />
      ) : selectedProject ? (
        <ProjectView
          project={selectedProject}
          config={config}
          terminal={scan.terminal}
          onLaunch={(id) => launch(selectedProject.path, id)}
          onArchive={archiveSession}
          onTrash={trashSession}
          onRename={() => setDialog({ kind: "renameProject", project: selectedProject })}
          onColor={(color) => setProjectPref(selectedProject.key, { color })}
          onMove={(cat) => moveProject(selectedProject.key, cat)}
          onForget={() => forgetProject(selectedProject)}
          onError={showError}
          onConfigChange={updateConfig}
        />
      ) : (
        <main className="main empty-main">Sélectionnez un projet.</main>
      )}

      {dialog?.kind === "newCategory" && (
        <TextPrompt
          title="Nouvelle catégorie"
          label="Nom"
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            updateConfig((c) => ({ ...c, categories: [...c.categories, { id: newId(), name, color: null, projectKeys: [] }] }));
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "renameCategory" && (
        <TextPrompt
          title="Renommer la catégorie"
          label="Nom"
          initial={dialog.category.name}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            updateConfig((c) => ({ ...c, categories: c.categories.map((x) => (x.id === dialog.category.id ? { ...x, name } : x)) }));
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "renameProject" && (
        <TextPrompt
          title="Nom d'affichage du projet"
          label="Nom (laisser vide pour revenir au nom du dossier)"
          initial={projectName(dialog.project, config)}
          allowEmpty
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            setProjectPref(dialog.project.key, { displayName: name || null });
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "newProject" && (
        <NewProjectDialog
          categories={config.categories}
          defaultCategoryId={defaultCategory}
          onClose={() => setDialog(null)}
          onSubmit={async (r) => {
            setDialog(null);
            try {
              const key = await api.addProject(r.path);
              // add_project a enregistré le chemin côté backend : on repart de la config à jour.
              const fresh = await api.getConfig();
              const prefs = { ...fresh.projects[key], ...(r.displayName ? { displayName: r.displayName } : {}) };
              const next: Config = {
                ...fresh,
                projects: { ...fresh.projects, [key]: prefs },
                categories: fresh.categories.map((cat) => {
                  const keys = cat.projectKeys.filter((k) => k !== key);
                  return { ...cat, projectKeys: cat.id === r.categoryId ? [...keys, key] : keys };
                }),
              };
              setConfig(await api.saveConfig(next));
              await refresh();
              setSelection({ kind: "project", key });
              if (r.startConversation) launch(r.path);
            } catch (e) {
              showError(e);
            }
          }}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={"toast" + (t.error ? " error" : "")}>
            <span>{t.text}</span>
            <button className="icon-btn bare" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
