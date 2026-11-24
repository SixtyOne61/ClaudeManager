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
import { newId, projectName, worktreePath } from "./util";
import { TerminalStack, TerminalTabBar, type OpenTerminal } from "./components/TerminalTabs";
import { isTerminalRunning, killTerminal, ptyApi, startInNewWorktree } from "./pty";
import { putConversationInSection } from "./sections";
import { getActivities, getActivity, interruptionWarning } from "./activity";
import { dismissSuggestion } from "./suggestions";
import { SettingsDialog } from "./components/Settings";

/** Titre provisoire d'une nouvelle conversation, en attendant celui de son fichier. */
const NEW_CONVERSATION_TITLE = "Nouvelle conversation";

/** Boîte de dialogue ouverte (une seule à la fois). */
type DialogState =
  | { kind: "newCategory" }
  | { kind: "renameCategory"; category: Category }
  | { kind: "renameProject"; project: ProjectInfo }
  | { kind: "newProject" }
  | { kind: "settings" }
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

  // Ctrl+Maj+F (⌘+Maj+F sur Mac) ouvre la recherche globale.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
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
      // Comme pour un onglet : on ne demande que si quitter interromprait un agent au travail
      // ou une action en attente de permission.
      const busy = [...getActivities().values()].filter((a) => interruptionWarning(a)).length;
      if (busy === 0) {
        ptyApi.quit();
        return;
      }
      const what = busy > 1 ? `${busy} conversations ont un agent au travail ou une action en attente.` : "Une conversation a un agent au travail ou une action en attente.";
      const ok = await ask(`${what}\nQuitter les interrompra (les conversations restent enregistrées).`, {
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

  // Un projet archivé où une nouvelle conversation est apparue (Claude Desktop, terminal
  // externe) revient dans la barre latérale ; ses conversations archivées y restent.
  useEffect(() => {
    if (!scan || !config) return;
    const awake = scan.projects.filter((p) => config.projects[p.key]?.archived && p.sessions.length > 0).map((p) => p.key);
    if (awake.length === 0) return;
    updateConfig((c) => ({
      ...c,
      projects: Object.fromEntries(Object.entries(c.projects).map(([k, v]) => [k, awake.includes(k) ? { ...v, archived: null } : v])),
    }));
  }, [scan, config, updateConfig]);

  // Sélectionne par défaut le projet le plus récemment actif.
  useEffect(() => {
    if (selection || !scan || !config) return;
    const first = [...scan.projects]
      .filter((p) => !p.isTemp && !config.projects[p.key]?.archived)
      .sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""))[0];
    if (first) setSelection({ kind: "project", key: first.key });
  }, [scan, config, selection]);

  // Changer d'onglet de conversation : le projet sélectionné (surligné dans la barre latérale,
  // affiché au retour sur « Projets ») devient celui de la conversation.
  useEffect(() => {
    if (activeTerminal === null) return;
    const key = [...projects.values()].find((p) => p.sessions.some((s) => s.id === activeTerminal))?.key;
    if (key) setSelection((sel) => (sel?.kind === "project" && sel.key === key ? sel : { kind: "project", key }));
  }, [activeTerminal, projects]);

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
  const startNewConversation = (projectKey: string, path: string | null, sectionId: string | null, worktree?: string) => {
    if (!path) return;
    const id = newId();
    const now = new Date();
    // Dans un nouveau worktree (`worktree` défini, vide = nom choisi par Claude Code) :
    // badge « worktree » tout de suite ; le vrai chemin arrive avec le fichier (ticket 08).
    if (worktree !== undefined) startInNewWorktree(id, worktree);
    const wtName = worktree?.trim();
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
      worktree:
        worktree === undefined
          ? null
          : {
              name: wtName || "(nom automatique)",
              path: worktreePath(path, wtName),
              exists: true,
            },
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
    // On ne prévient que si fermer interromprait quelque chose : l'agent travaille, ou une
    // action attend ta permission. Une conversation qui attend simplement ton message se ferme
    // sans question : elle reste enregistrée et se reprend plus tard.
    const warning = isTerminalRunning(t.sessionId) ? interruptionWarning(getActivity(t.sessionId)) : null;
    if (warning) {
      const ok = await ask(`${warning}\n\nFermer « ${t.title} » quand même ?`, {
        title: "Fermer la conversation",
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
    const ok = await ask(`Mettre la conversation « ${s.title} » à la Corbeille ?\nElle pourra être récupérée depuis la Corbeille.`, {
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

  /**
   * Archive ou met à la Corbeille plusieurs conversations (sélection multiple d'un projet) :
   * une seule confirmation, un seul avertissement pour celles modifiées il y a moins de
   * 2 minutes (toutes continuées ou toutes ignorées), un seul message pour les échecs et
   * un seul rafraîchissement à la fin. `confirmed` : la confirmation a déjà été demandée
   * (archivage d'un projet). Renvoie `null` si l'utilisateur a annulé, sinon les
   * conversations traitées et le nombre de celles qui ne l'ont pas été (ignorées ou en échec).
   */
  const bulkSessionAction = async (
    list: SessionInfo[],
    kind: "archive" | "trash",
    confirmed = false,
  ): Promise<{ done: SessionInfo[]; remaining: number } | null> => {
    if (list.length === 0) return null;
    const trash = kind === "trash";
    const count = (n: number) => `${n} conversation${n > 1 ? "s" : ""}`;
    const titles = (l: SessionInfo[]) =>
      l.slice(0, 8).map((s) => `• ${s.title}`).join("\n") + (l.length > 8 ? `\n… et ${l.length - 8} autre(s)` : "");
    const plural = list.length > 1;
    const ok =
      confirmed ||
      (await ask(
      trash
        ? `Mettre ${count(list.length)} à la Corbeille ?\n${plural ? "Elles pourront être récupérées" : "Elle pourra être récupérée"} depuis la Corbeille.\n\n${titles(list)}`
        : `Archiver ${count(list.length)} ?\n${plural ? "Elles pourront être restaurées" : "Elle pourra être restaurée"} depuis les Archives.\n\n${titles(list)}`,
      {
        title: trash ? "Supprimer les conversations" : "Archiver les conversations",
        kind: "warning",
        okLabel: trash ? "Mettre à la Corbeille" : "Archiver",
        cancelLabel: "Annuler",
      },
    ));
    if (!ok) return null;

    const run = async (s: SessionInfo, force: boolean) => {
      if (trash) await api.trashSession(s.projectKey, s.id, force);
      else setConfig(await api.archiveSession(s.projectKey, s.id, force));
    };
    const doneList: SessionInfo[] = [];
    const active: SessionInfo[] = [];
    const failed: string[] = [];
    const attempt = async (s: SessionInfo, force: boolean) => {
      try {
        await run(s, force);
        doneList.push(s);
      } catch (e) {
        const msg = errorMessage(e);
        if (!force && msg.startsWith(ERR_ACTIVE)) active.push(s);
        else failed.push(`« ${s.title} » : ${msg}`);
      }
    };
    for (const s of list) await attempt(s, false);

    let skipped = 0;
    if (active.length > 0) {
      const go = await ask(
        `${count(active.length)} ${active.length > 1 ? "ont été modifiées" : "a été modifiée"} il y a moins de 2 minutes : ` +
          `peut-être ouverte${active.length > 1 ? "s" : ""} dans Claude Desktop ou dans un autre terminal.\n\n${titles(active)}`,
        {
          title: "Conversations peut-être en cours",
          kind: "warning",
          okLabel: trash ? "Les mettre aussi à la Corbeille" : "Les archiver aussi",
          cancelLabel: "Les ignorer",
        },
      );
      if (go) for (const s of active) await attempt(s, true);
      else skipped = active.length;
    }

    const done = doneList.length;
    if (done > 0) {
      const what = trash ? (done > 1 ? "envoyées à la Corbeille" : "envoyée à la Corbeille") : done > 1 ? "archivées" : "archivée";
      toast(`${count(done)} ${what}` + (skipped ? ` (${skipped} ignorée${skipped > 1 ? "s" : ""})` : ""));
    } else if (skipped) {
      toast(`Aucune conversation ${trash ? "supprimée" : "archivée"} (${skipped} ignorée${skipped > 1 ? "s" : ""})`);
    }
    if (failed.length > 0) {
      toast(`Échec pour ${count(failed.length)} :\n` + failed.slice(0, 5).join("\n") + (failed.length > 5 ? `\n… et ${failed.length - 5} autre(s)` : ""), true);
    }
    await refresh();
    return { done: doneList, remaining: skipped + failed.length };
  };

  /**
   * Archive un projet : toutes ses conversations (worktrees compris) partent dans les
   * archives, puis le projet est masqué de la barre latérale. Il garde sa catégorie, sa
   * couleur et ses sections. S'il reste une conversation (ignorée ou en échec), le projet
   * n'est pas archivé.
   */
  const archiveProject = async (p: ProjectInfo) => {
    const name = projectName(p, config);
    if (terminals.some((t) => p.sessions.some((s) => s.id === t.sessionId))) {
      toast(`Fermez d'abord les onglets ouverts du projet « ${name} ».`, true);
      return;
    }
    const sessions = p.sessions.filter((s) => !s.provisional);
    const n = sessions.length;
    const ok = await ask(
      `Archiver le projet « ${name} » ?\n\n` +
        (n > 0 ? `Ses ${n} conversation${n > 1 ? "s seront archivées" : " sera archivée"} avec lui. ` : "") +
        "Le projet disparaît de la barre latérale et se restaure depuis les Archives, avec sa catégorie, sa couleur et ses sections.\nLe dossier du projet n'est pas touché.",
      { title: "Archiver le projet", kind: "warning", okLabel: "Archiver le projet", cancelLabel: "Annuler" },
    );
    if (!ok) return;
    let ids: string[] = [];
    if (n > 0) {
      const r = await bulkSessionAction(sessions, "archive", true);
      if (!r) return;
      if (r.remaining > 0) {
        toast(
          `Le projet « ${name} » n'a pas été archivé : ${r.remaining} conversation${r.remaining > 1 ? "s sont restées" : " est restée"} en place. ` +
            "Celles déjà archivées se restaurent depuis les Archives.",
          true,
        );
        return;
      }
      ids = r.done.map((s) => s.id);
    }
    try {
      setConfig(await api.markProjectArchived(p.key, ids));
      toast(`Projet « ${name} » archivé`);
      setSelection((sel) => (sel?.kind === "project" && sel.key === p.key ? null : sel));
    } catch (e) {
      showError(e);
    }
  };

  const restoreProject = async (key: string, name: string) => {
    try {
      const r = await api.restoreProject(key);
      setConfig(r.config);
      toast(`Projet « ${name} » restauré` + (r.restored ? ` (${r.restored} conversation${r.restored > 1 ? "s" : ""})` : ""));
      if (r.errors.length > 0) {
        toast(
          `${r.errors.length} conversation${r.errors.length > 1 ? "s sont restées" : " est restée"} dans les archives :\n` +
            r.errors.slice(0, 5).join("\n") +
            (r.errors.length > 5 ? `\n… et ${r.errors.length - 5} autre(s)` : ""),
          true,
        );
      }
    } catch (e) {
      showError(e);
    }
    await refresh();
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
    // Conversation ouverte dans un onglet : on y va, et l'interface de conversation défile
    // jusqu'au message trouvé.
    if (!s.archived && terminals.some((t) => t.sessionId === s.sessionId)) {
      setSearchOpen(false);
      setActiveTerminal(s.sessionId);
      return;
    }
    setSelection(archived ? { kind: "archives" } : { kind: "project", key: s.projectKey });
    setSearchOpen(false);
    setActiveTerminal(null);
  };

  // ---- Rendu ----------------------------------------------------------------------------

  // Projet courant de la barre latérale : celui de la conversation affichée, sinon le projet sélectionné.
  const activeProject =
    activeTerminal !== null ? [...projects.values()].find((p) => p.sessions.some((s) => s.id === activeTerminal)) : undefined;
  const currentProject = activeProject ?? selectedProject;

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
        currentProject={currentProject}
        activeSessionId={activeTerminal}
        onConfigChange={updateConfig}
        onNewConversation={(p, sectionId) => startNewConversation(p.key, p.path, sectionId)}
        onOpenConversation={(s, p) => openInTerminal(s, p.path)}
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
        onSettings={() => setDialog({ kind: "settings" })}
      />

      <div className="main-column">
      <TerminalTabBar terminals={tabs} active={activeTerminal} onSelect={(id) => {
        // « Projets » : retour au projet de la conversation qu'on quitte.
        if (id === null && activeProject) {
          setSearchOpen(false);
          setSelection({ kind: "project", key: activeProject.key });
        }
        setActiveTerminal(id);
      }} onClose={closeTerminal} />
      <TerminalStack
        terminals={terminals}
        active={activeTerminal}
        onClose={closeTerminal}
        onStarted={terminalStarted}
        focus={searchFocus}
        onDismissSuggestion={(s) => updateConfig((c) => dismissSuggestion(c, s))}
      />
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
          onRestoreProject={restoreProject}
          focus={searchFocus?.archived ? searchFocus : null}
        />
      ) : selectedProject ? (
        <ProjectView
          project={selectedProject}
          config={config}
          terminal={scan.terminal}
          onLaunch={(id, path) => launch(path ?? selectedProject.path, id)}
          onNew={(sectionId, worktree) => startNewConversation(selectedProject.key, selectedProject.path, sectionId, worktree)}
          onOpen={(s) => openInTerminal(s, selectedProject.path)}
          onArchive={archiveSession}
          onTrash={trashSession}
          onArchiveMany={(list) => bulkSessionAction(list, "archive").then((r) => r !== null)}
          onTrashMany={(list) => bulkSessionAction(list, "trash").then((r) => r !== null)}
          onArchiveProject={() => archiveProject(selectedProject)}
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
              const key = await api.addProject(r.path, r.language);
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

      {dialog?.kind === "settings" && <SettingsDialog config={config} onChange={updateConfig} onClose={() => setDialog(null)} />}

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
