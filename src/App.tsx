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
  type SearchHit,
  type SessionHits,
} from "./api";
import { Sidebar, type Selection } from "./components/Sidebar";
import { ProjectView } from "./components/ProjectView";
import { ArchivesView } from "./components/ArchivesView";
import { GlobalSearch, type SearchFocus } from "./components/GlobalSearch";
import { NewProjectDialog, TextPrompt } from "./components/Dialogs";
import { newId, projectName } from "./util";
import { openInDesktop } from "./desktop";
import { TerminalStack, TerminalTabBar, type OpenTerminal } from "./components/TerminalTabs";
import { isTerminalRunning, killTerminal, ptyApi } from "./pty";
import { putConversationInSection } from "./sections";

/** Titre provisoire d'une nouvelle conversation, en attendant celui de son fichier. */
const NEW_CONVERSATION_TITLE = "Nouvelle conversation";

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
  // Recherche globale : vue ouverte, texte cherché (gardé au retour) et dernier résultat ouvert.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocus, setSearchFocus] = useState<SearchFocus | null>(null);

  // Ctrl+Maj+F ouvre la recherche globale.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setActiveTerminal(null);
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Terminal intégré : conversations ouvertes (onglets) et onglet affiché (null = vue projet).
  const [terminals, setTerminals] = useState<OpenTerminal[]>([]);
  const [activeTerminal, setActiveTerminal] = useState<string | null>(null);
  // Nouvelles conversations lancées dans le terminal intégré dont le fichier n'existe pas
  // encore : affichées tout de suite dans leur projet, avec un titre provisoire.
  const [pending, setPending] = useState<SessionInfo[]>([]);
  /** Section où ranger une nouvelle conversation, une fois `claude` démarré. */
  const placeIn = useRef(new Map<string, { projectKey: string; sectionId: string | null }>());
  /** Moment où l'app a fermé son propre terminal pour une conversation (voir ticket 09). */
  const releasedAt = useRef(new Map<string, number>());
  /** Conversations en cours d'ouverture (vérification « ouverte ailleurs » en attente). */
  const opening = useRef(new Set<string>());

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
  // Pour les rappels asynchrones (terminal démarré, fermé) : toujours la configuration à jour.
  const updateConfigRef = useRef(updateConfig);
  updateConfigRef.current = updateConfig;

  // Fermeture de l'app alors qu'un terminal tourne : le backend suspend la fermeture
  // et demande confirmation ici.
  useEffect(() => {
    const unlisten = listen("pty-close-requested", async () => {
      const ok = await ask("Une conversation tourne encore dans le terminal intégré.\nQuitter arrêtera Claude Code dans tous les onglets.", {
        title: "Quitter Claude Manager",
        kind: "warning",
        okLabel: "Quitter",
        cancelLabel: "Annuler",
      });
      if (ok) ptyApi.quit();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  /** Identifiants des conversations qui ont un fichier. */
  const knownIds = useMemo(() => new Set((scan?.projects ?? []).flatMap((p) => p.sessions.map((s) => s.id))), [scan]);

  // Projets, avec en tête les nouvelles conversations qui n'ont pas encore de fichier.
  const projects = useMemo(() => {
    const map = new Map((scan?.projects ?? []).map((p) => [p.key, p]));
    for (const s of pending) {
      const p = map.get(s.projectKey);
      if (p && !knownIds.has(s.id)) map.set(p.key, { ...p, sessions: [s, ...p.sessions] });
    }
    return map;
  }, [scan, pending, knownIds]);

  // Le fichier d'une nouvelle conversation est apparu : son vrai titre prend le relais.
  useEffect(() => {
    setPending((ps) => (ps.some((s) => knownIds.has(s.id)) ? ps.filter((s) => !knownIds.has(s.id)) : ps));
  }, [knownIds]);

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

  // ---- Terminal intégré ----------------------------------------------------------------

  /**
   * Ouvre (ou affiche) la conversation dans un onglet du terminal intégré. Déjà ouverte
   * dans l'app : on bascule sur son onglet. Sinon, si son fichier vient d'être modifié par
   * un autre programme, on prévient qu'elle est peut-être ouverte ailleurs.
   */
  const openInTerminal = async (s: SessionInfo, projectPath: string | null) => {
    const cwd = s.cwd ?? projectPath;
    if (!cwd) return;
    if (terminals.some((t) => t.sessionId === s.id)) {
      setActiveTerminal(s.id);
      return;
    }
    if (opening.current.has(s.id)) return; // double clic : une seule vérification
    opening.current.add(s.id);
    try {
      await api.checkOpenElsewhere(s.projectKey, s.id, releasedAt.current.get(s.id) ?? null);
    } catch (e) {
      const msg = errorMessage(e);
      // Autre erreur (fichier introuvable…) : le terminal l'affichera au lancement.
      if (msg.startsWith(ERR_ACTIVE)) {
        const ok = await ask(
          msg.replace(`${ERR_ACTIVE}: `, "") +
            "\nDeux programmes qui écrivent en même temps dans la même conversation peuvent l'abîmer.\n\nContinuer quand même ?",
          { title: "Conversation peut-être en cours", kind: "warning", okLabel: "Continuer", cancelLabel: "Annuler" },
        );
        if (!ok) {
          opening.current.delete(s.id);
          return;
        }
      }
    }
    opening.current.delete(s.id);
    setTerminals((ts) => (ts.some((t) => t.sessionId === s.id) ? ts : [...ts, { sessionId: s.id, cwd, title: s.title }]));
    setActiveTerminal(s.id);
  };

  /**
   * Nouvelle conversation dans le terminal intégré : `claude --session-id <id>` dans le
   * dossier du projet, avec un identifiant choisi ici. Elle apparaît tout de suite dans la
   * liste (titre provisoire) et sera rangée dans `sectionId` (null = « Sans section »).
   */
  const startNewConversation = (projectKey: string, path: string | null, sectionId: string | null) => {
    if (!path) return;
    const id = newId();
    const now = new Date();
    const session: SessionInfo = {
      id,
      projectKey,
      cwd: path,
      title: NEW_CONVERSATION_TITLE,
      titleSource: "none",
      firstPrompt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      messageCount: 0,
      fileSize: 0,
      modifiedMs: now.getTime(),
      skippedLines: 0,
      provisional: true,
    };
    placeIn.current.set(id, { projectKey, sectionId });
    setPending((ps) => [...ps, session]);
    setTerminals((ts) => [...ts, { sessionId: id, cwd: path, title: NEW_CONVERSATION_TITLE, isNew: true }]);
    setActiveTerminal(id);
  };

  /**
   * `claude` a démarré : une nouvelle conversation est rangée dans sa section. Fait après le
   * lancement, pour que le backend garde sa place (terminal ouvert) même sans fichier.
   */
  const terminalStarted = (t: OpenTerminal) => {
    const place = placeIn.current.get(t.sessionId);
    if (!place) return;
    placeIn.current.delete(t.sessionId);
    if (place.sectionId) updateConfigRef.current((c) => putConversationInSection(c, place.projectKey, place.sectionId, t.sessionId));
  };

  /** Nouvelle conversation fermée sans message (aucun fichier) : elle disparaît, de sa section aussi. */
  const dropIfEmpty = async (id: string) => {
    const fresh = await api.scan().catch(() => null);
    if (!fresh) return;
    setScan(fresh);
    if (fresh.projects.some((p) => p.sessions.some((s) => s.id === id))) return;
    placeIn.current.delete(id);
    setPending((ps) => ps.filter((s) => s.id !== id));
    updateConfigRef.current((c) => putConversationInSection(c, "", null, id));
  };

  const closeTerminal = async (t: OpenTerminal) => {
    if (isTerminalRunning(t.sessionId)) {
      const ok = await ask(`Arrêter Claude Code dans « ${t.title} » et fermer l'onglet ?`, {
        title: "Fermer le terminal",
        kind: "warning",
        okLabel: "Fermer",
        cancelLabel: "Annuler",
      });
      if (!ok) return;
    }
    await killTerminal(t.sessionId).catch(() => {});
    releasedAt.current.set(t.sessionId, Date.now());
    setTerminals((ts) => ts.filter((x) => x.sessionId !== t.sessionId));
    setActiveTerminal((a) => (a === t.sessionId ? null : a));
    if (t.isNew) await dropIfEmpty(t.sessionId);
  };

  /** Onglets avec le titre à jour (le vrai titre remplace « Nouvelle conversation »). */
  const tabs = terminals.map((t) => {
    const title = [...projects.values()].flatMap((p) => p.sessions).find((s) => s.id === t.sessionId)?.title;
    return title && title !== t.title ? { ...t, title } : t;
  });

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

  // ---- Recherche globale ------------------------------------------------------------------

  /** Ouvre une conversation trouvée : son projet (ou les archives) avec la conversation repérée. */
  const openSearchResult = (s: SessionHits, hit: SearchHit | undefined) => {
    const archived = s.archived || !projects.has(s.projectKey);
    setSearchFocus({ projectKey: s.projectKey, sessionId: s.sessionId, archived, line: hit?.line ?? null, uuid: hit?.uuid ?? null });
    setSelection(archived ? { kind: "archives" } : { kind: "project", key: s.projectKey });
    setSearchOpen(false);
    setActiveTerminal(null);
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
        onSelect={(s) => {
          setSearchOpen(false);
          setSearchFocus(null);
          setSelection(s);
          setActiveTerminal(null);
        }}
        searchActive={searchOpen}
        onSearch={() => {
          setActiveTerminal(null);
          setSearchOpen(true);
        }}
        onRefresh={refresh}
        onCategoriesChange={(categories) => updateConfig((c) => ({ ...c, categories }))}
        onAddCategory={() => setDialog({ kind: "newCategory" })}
        onRenameCategory={(category) => setDialog({ kind: "renameCategory", category })}
        onDeleteCategory={deleteCategory}
        onAddProject={() => setDialog({ kind: "newProject" })}
        onToggleTemp={(show) => updateConfig((c) => ({ ...c, showTempProjects: show }))}
      />

      <div className="main-column">
      <TerminalTabBar terminals={tabs} active={activeTerminal} onSelect={setActiveTerminal} onClose={closeTerminal} />
      <TerminalStack terminals={terminals} active={activeTerminal} onClose={closeTerminal} onStarted={terminalStarted} />
      {activeTerminal !== null ? null : searchOpen ? (
        <GlobalSearch
          config={config}
          projects={projects}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onOpen={openSearchResult}
          onClose={() => setSearchOpen(false)}
          onError={showError}
        />
      ) : selection?.kind === "archives" ? (
        <ArchivesView
          config={config}
          onRestore={restoreArchive}
          onTrash={trashArchive}
          focus={searchFocus?.archived ? searchFocus : null}
        />
      ) : selectedProject ? (
        <ProjectView
          project={selectedProject}
          config={config}
          terminal={scan.terminal}
          onLaunch={(id, path) => launch(path ?? selectedProject.path, id)}
          onNew={(sectionId) => startNewConversation(selectedProject.key, selectedProject.path, sectionId)}
          onOpenInDesktop={(s) =>
            openInDesktop(s, { projectPath: selectedProject.path, toast, openInExternalTerminal: () => launch(selectedProject.path, s.id),
              closeEmbeddedTerminal: async () => {
                await killTerminal(s.id).catch(() => {});
                setTerminals((ts) => ts.filter((x) => x.sessionId !== s.id));
                setActiveTerminal((a) => (a === s.id ? null : a));
              },
            })
          }
          onOpen={(s) => openInTerminal(s, selectedProject.path)}
          onArchive={archiveSession}
          onTrash={trashSession}
          onRename={() => setDialog({ kind: "renameProject", project: selectedProject })}
          onColor={(color) => setProjectPref(selectedProject.key, { color })}
          onMove={(cat) => moveProject(selectedProject.key, cat)}
          onForget={() => forgetProject(selectedProject)}
          onError={showError}
          focus={searchFocus && !searchFocus.archived && searchFocus.projectKey === selectedProject.key ? searchFocus : null}
          onConfigChange={updateConfig}
        />
      ) : (
        <main className="main empty-main">Sélectionnez un projet.</main>
      )}
      </div>

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
              if (r.startConversation) startNewConversation(key, r.path, null);
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
