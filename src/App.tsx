// Composant racine : charge les données, garde la configuration et relie les vues au backend.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import {
  api,
  ERR_ACTIVE,
  isUiError,
  errorMessage,
  type ArchiveEntry,
  type Category,
  type Config,
  type Hub,
  type ProjectInfo,
  type ScanResult,
  type SessionInfo,
  type SearchHit,
  type SessionHits,
  type SkillListing,
  type SkillProposal,
  type WorktreeInfo,
} from "./api";
import { Sidebar, type Selection } from "./components/Sidebar";
import { ProjectView } from "./components/ProjectView";
import { ArchivesView } from "./components/ArchivesView";
import { GlobalSearch, type SearchFocus } from "./components/GlobalSearch";
import { NewProjectDialog, TextPrompt, WorktreeOfferDialog } from "./components/Dialogs";
import { newId, projectName, worktreePath } from "./util";
import { TerminalStack, TerminalTabBar, type OpenTerminal, type TabInfo } from "./components/TerminalTabs";
import { HubView } from "./components/HubView";
import { ConversationLinksContext, messagesApi } from "./messages";
import { isTerminalRunning, killTerminal, ptyApi, startInNewWorktree, worktreeNameError } from "./pty";
import { putConversationInSection } from "./sections";
import { getActivities, getActivity, interruptionWarning } from "./activity";
import {
  ACTION_HUB,
  RULE_WORKTREE,
  dismissStale,
  dismissSuggestion,
  hubSuggestionData,
  isLocalSuggestion,
  isRuleEnabled,
  noteTyping,
  type Suggestion,
} from "./suggestions";
import { SettingsDialog } from "./components/Settings";
import { ExecutorDialog, HubDialog, type ExecutorRequest, type HubActions, type HubChoice } from "./components/Hubs";
import { activeHubs, coordinatorOf, defaultRole, executorBlocker, executorFirstMessage, hubOf } from "./hubs";
import {
  endHandoff,
  handoffBlocker,
  handoffPrompt,
  isHandoffRunning,
  parentOf,
  requestSummary,
  sendWhenReady,
  successorOf,
  type HandoffLineage,
} from "./handoff";
import { cancelAnalysis, isAnalysing, onAnalysisDone, runAnalysis, skillSettings } from "./skills";
import { SkillsDialog, SkillsReminder } from "./components/SkillProposals";
import { t, useLanguage } from "./i18n";
import { applyLanguage, pendingCount, startTranslation, translationRunning } from "./i18n/translate";

/** Titre provisoire d'une nouvelle conversation, en attendant celui de son fichier. */
const newConversationTitle = () => t("app.newConversationTitle");

/** Liste à puces des titres (8 au plus), pour les confirmations. */
const titleList = (l: SessionInfo[]) =>
  l.slice(0, 8).map((s) => `• ${s.title}`).join("\n") + (l.length > 8 ? "\n" + t("app.andMore", { count: l.length - 8 }) : "");

/** Les 5 premières lignes, puis « … et N autre(s) ». */
const shortList = (l: string[]) => l.slice(0, 5).join("\n") + (l.length > 5 ? "\n" + t("app.andMore", { count: l.length - 5 }) : "");

/** Boîte de dialogue ouverte (une seule à la fois). */
type DialogState =
  | { kind: "newCategory" }
  | { kind: "renameCategory"; category: Category }
  | { kind: "renameProject"; project: ProjectInfo }
  | { kind: "newProject" }
  | { kind: "settings" }
  | { kind: "skills" }
  | { kind: "newHub" }
  | { kind: "renameHub"; hub: Hub }
  | { kind: "addToHub"; session: SessionInfo }
  | { kind: "addExecutor"; hubId: string }
  | { kind: "hubFromExchange"; from: string; to: string }
  | { kind: "worktreeOffer"; projectKey: string; path: string; sectionId: string | null; count: number }
  | null;

export default function App() {
  // Changement de langue : toute l'interface se redessine.
  useLanguage();
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [selection, setSelection] = useState<Selection>(null);

  // Langue de l'interface (voir src/i18n/translate.ts) : chargée au démarrage et à chaque choix
  // dans les réglages. Une langue dont des textes manquent ou ont changé (nouvelle version de
  // l'app) est complétée en arrière-plan, une fois par lancement ; en attendant, ces textes
  // s'affichent en français.
  const languageCode = config?.language ?? null;
  const configLoaded = config !== null;
  const languageCompleted = useRef(new Set<string>());
  useEffect(() => {
    if (!configLoaded) return;
    applyLanguage(languageCode).then(async () => {
      if (!languageCode || languageCompleted.current.has(languageCode) || translationRunning()) return;
      languageCompleted.current.add(languageCode);
      if ((await pendingCount(languageCode)) > 0) await startTranslation(languageCode, languageCode);
    }).catch(() => {});
  }, [languageCode, configLoaded]);
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
  /** Hub où ranger un nouvel exécutant (« + Exécutant »), une fois `claude` démarré. */
  const joinHub = useRef(new Map<string, string>());
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
      const ok = await ask(t("app.quit.busy", { count: busy }), {
        title: t("app.quit.title"),
        kind: "warning",
        okLabel: t("app.quit.ok"),
        cancelLabel: t("common.cancel"),
      });
      if (ok) ptyApi.quit();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Propositions de skills (voir src/skills.ts) : relues au démarrage, toutes les heures,
  // après chaque analyse de fin de conversation et quand leurs réglages changent.
  const [skillListing, setSkillListing] = useState<SkillListing | null>(null);
  const refreshSkills = useCallback(() => {
    api.skillsList().then(setSkillListing).catch(() => {});
  }, []);
  const skillWindow = config?.skills?.windowDays;
  const skillThreshold = config?.skills?.threshold;
  useEffect(() => {
    refreshSkills();
  }, [refreshSkills, skillWindow, skillThreshold]);
  useEffect(() => {
    const timer = setInterval(refreshSkills, 60 * 60_000);
    const unsubscribe = onAnalysisDone(refreshSkills);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [refreshSkills]);

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
  // Un hub sélectionné reste sélectionné quand on ouvre l'une de ses conversations : l'onglet
  // « Projets » y ramène.
  useEffect(() => {
    if (activeTerminal === null) return;
    const key = [...projects.values()].find((p) => p.sessions.some((s) => s.id === activeTerminal))?.key;
    if (!key) return;
    setSelection((sel) => {
      if (sel?.kind === "project" && sel.key === key) return sel;
      if (sel?.kind === "hub" && config?.hubs?.some((h) => h.id === sel.id && h.members.some((m) => m.conversationId === activeTerminal))) return sel;
      return { kind: "project", key };
    });
  }, [activeTerminal, projects, config]);

  // Un hub supprimé ou archivé n'est plus affiché.
  useEffect(() => {
    if (!config) return;
    setSelection((sel) => (sel?.kind === "hub" && !activeHubs(config).some((h) => h.id === sel.id) ? null : sel));
  }, [config]);

  if (!config || !scan) {
    return <div className="loading-screen">{t("app.loading")}</div>;
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
    const ok = await ask(t("app.category.deleteConfirm", { name: cat.name, count: cat.projectKeys.length }), {
      title: t("app.category.deleteTitle"),
      kind: "warning",
      okLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
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
      .then(() => toast(sessionId ? t("app.launch.resume") : t("app.launch.new")))
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
    // Rouverte pendant son analyse de fin : l'analyse est abandonnée, puis la conversation
    // est relancée normalement.
    if (isAnalysing(s.id)) {
      await cancelAnalysis(s.id);
      releasedAt.current.set(s.id, Date.now());
    }
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
      if (isUiError(e, ERR_ACTIVE)) {
        const ok = await ask(t("app.openElsewhere.confirm", { message: msg }), {
          title: t("app.maybeActive.title"),
          kind: "warning",
          okLabel: t("app.maybeActive.continue"),
          cancelLabel: t("common.cancel"),
        });
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
   * `opts.title` : titre provisoire ; `opts.inWorktree` : worktree existant dans lequel elle
   * tourne (`path` est alors son dossier). Renvoie son identifiant.
   */
  const startNewConversation = (
    projectKey: string,
    path: string | null,
    sectionId: string | null,
    worktree?: string,
    opts?: { title?: string; inWorktree?: WorktreeInfo | null },
  ): string | null => {
    if (!path) return null;
    const id = newId();
    const title = opts?.title ?? newConversationTitle();
    const now = new Date();
    // Dans un nouveau worktree (`worktree` défini, vide = nom choisi par Claude Code) :
    // badge « worktree » tout de suite ; le vrai chemin arrive avec le fichier (ticket 08).
    if (worktree !== undefined) startInNewWorktree(id, worktree);
    const wtName = worktree?.trim();
    const session: SessionInfo = {
      id,
      projectKey,
      cwd: path,
      title,
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
          ? (opts?.inWorktree ?? null)
          : {
              name: wtName || t("app.worktreeAutoName"),
              path: worktreePath(path, wtName),
              exists: true,
            },
    };
    placeIn.current.set(id, { projectKey, sectionId });
    setPending((ps) => [...ps, session]);
    setTerminals((ts) => [...ts, { sessionId: id, cwd: path, title, isNew: true }]);
    setActiveTerminal(id);
    return id;
  };

  /**
   * Nouvelle conversation demandée par l'utilisateur (barre latérale, vue du projet, nouveau
   * projet). Règle « worktree » des suggestions : si deux conversations ou plus tournent déjà
   * dans le dossier du projet (hors worktree) et que c'est un dépôt git, une fenêtre propose
   * de la démarrer dans un worktree. Pas de fenêtre si l'utilisateur a déjà choisi un nouveau
   * worktree, si la règle est coupée ou si le projet a « Ne plus demander ». Le hand off
   * appelle directement `startNewConversation` : sa suite remplace la parente.
   */
  const newConversation = async (projectKey: string, path: string | null, sectionId: string | null, worktree?: string) => {
    if (!path) return;
    if (worktree === undefined && config && isRuleEnabled(config, RULE_WORKTREE) && !config.projects[projectKey]?.noWorktreeOffer) {
      const open = terminals.map((t) => ({
        cwd: t.cwd,
        inWorktree: !!findSession(t.sessionId)?.s.worktree,
        running: isTerminalRunning(t.sessionId),
      }));
      const count = await api.worktreeOffer(path, open).catch(() => null);
      if (count !== null) {
        setDialog({ kind: "worktreeOffer", projectKey, path, sectionId, count });
        return;
      }
    }
    startNewConversation(projectKey, path, sectionId, worktree);
  };

  /**
   * `claude` a démarré : une nouvelle conversation est rangée dans sa section. Fait après le
   * lancement, pour que le backend garde sa place (terminal ouvert) même sans fichier.
   */
  const terminalStarted = (t: OpenTerminal) => {
    // Nouvel exécutant : rangé dans son hub une fois son terminal ouvert (sans fichier, il
    // serait sinon retiré du hub au scan suivant).
    const hubId = joinHub.current.get(t.sessionId);
    if (hubId) {
      joinHub.current.delete(t.sessionId);
      api.hubSetMember(hubId, t.sessionId, "executant").then(setConfig).catch(showError);
    }
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
    joinHub.current.delete(id);
    setPending((ps) => ps.filter((s) => s.id !== id));
    updateConfigRef.current((c) => putConversationInSection(c, "", null, id));
  };

  const closeTerminal = async (tab: OpenTerminal) => {
    // On ne prévient que si fermer interromprait quelque chose : l'agent travaille, ou une
    // action attend ta permission. Une conversation qui attend simplement ton message se ferme
    // sans question : elle reste enregistrée et se reprend plus tard.
    const warning = isTerminalRunning(tab.sessionId) ? interruptionWarning(getActivity(tab.sessionId)) : null;
    if (warning) {
      const ok = await ask(t("app.closeConversation.confirm", { warning, title: tab.title }), {
        title: t("app.closeConversation.title"),
        kind: "warning",
        okLabel: t("common.close"),
        cancelLabel: t("common.cancel"),
      });
      if (!ok) return;
    }
    await killTerminal(tab.sessionId).catch(() => {});
    releasedAt.current.set(tab.sessionId, Date.now());
    setTerminals((ts) => ts.filter((x) => x.sessionId !== tab.sessionId));
    setActiveTerminal((a) => (a === tab.sessionId ? null : a));
    if (tab.isNew) await dropIfEmpty(tab.sessionId);
  };

  /**
   * Terminer (barre d'outils de la conversation) : l'onglet se ferme et, si le réglage est
   * actif, l'analyse de fin de conversation tourne dans son terminal, caché, avant de l'arrêter.
   */
  const finishTerminal = (tab: OpenTerminal) => {
    if (!skillSettings(config).enabled || !isTerminalRunning(tab.sessionId)) {
      closeTerminal(tab);
      return;
    }
    const blocked = handoffBlocker(getActivity(tab.sessionId), null);
    if (blocked) {
      toast(blocked, true);
      return;
    }
    setTerminals((ts) => ts.filter((x) => x.sessionId !== tab.sessionId));
    setActiveTerminal((a) => (a === tab.sessionId ? null : a));
    runAnalysis(tab.sessionId, tab.cwd).then(() => releasedAt.current.set(tab.sessionId, Date.now()));
  };

  /**
   * Onglets avec le titre à jour (le vrai titre remplace « Nouvelle conversation ») et, si le
   * réglage est activé, leur groupe : le hub (non archivé) de la conversation, sinon son projet
   * (couleur du projet, sinon de sa catégorie).
   */
  /** Couleur d'un projet pour le liseré de ses onglets : la sienne, sinon celle de sa catégorie. */
  const projectColor = (key: string): string | null =>
    config?.projects[key]?.color ?? config?.categories.find((c) => c.projectKeys.includes(key))?.color ?? null;
  const tabs: TabInfo[] = terminals.map((t) => {
    const p = [...projects.values()].find((x) => x.sessions.some((s) => s.id === t.sessionId));
    const title = p?.sessions.find((s) => s.id === t.sessionId)?.title;
    const tab: TabInfo = title && title !== t.title ? { ...t, title } : t;
    if (config?.groupTabs === false) return tab;
    const hub = config ? hubOf(config, t.sessionId)?.hub : undefined;
    if (hub && !hub.archived) return { ...tab, group: { key: `hub:${hub.id}`, kind: "hub", name: hub.name, color: hub.color } };
    if (p) return { ...tab, group: { key: `project:${p.key}`, kind: "project", name: projectName(p, config), color: projectColor(p.key) } };
    const folder = t.cwd.split(/[\\/]/).filter(Boolean).pop() ?? t.cwd;
    return { ...tab, group: { key: `cwd:${t.cwd}`, kind: "project", name: folder, color: null } };
  });

  // ---- Hand off (voir src/handoff.ts) ----------------------------------------------------

  /** Conversation et projet affiché qui la contient (null : archivée ou disparue). */
  const findSession = (id: string): { s: SessionInfo; p: ProjectInfo } | null => {
    for (const p of projects.values()) {
      const s = p.sessions.find((x) => x.id === id);
      if (s) return { s, p };
    }
    return null;
  };

  /**
   * Hand off de la conversation (clic sur le bouton) : résumé de passation demandé à la
   * parente, suite créée dans le même dossier avec ce résumé pour premier message, puis la
   * suite prend la section et la couleur de la parente, qui est archivée. Annulé ou réponse
   * vide : rien n'est créé ni archivé.
   */
  const startHandoff = async (sessionId: string) => {
    const found = findSession(sessionId);
    if (!found || isHandoffRunning(sessionId)) return;
    const blocked = handoffBlocker(getActivity(sessionId), null);
    if (blocked) {
      toast(blocked, true);
      return;
    }
    const { s: parent, p } = found;
    const cwd = terminals.find((t) => t.sessionId === sessionId)?.cwd ?? parent.cwd ?? p.path;
    if (!cwd) return;
    const r = await requestSummary(sessionId, cwd, handoffPrompt(config), parent.title);
    if (r.kind === "cancelled") {
      toast(t("app.handoff.cancelled"));
      return;
    }
    if (r.kind === "failed") {
      toast(r.message, true);
      return;
    }
    try {
      // Même dossier (même worktree le cas échéant), même projet affiché.
      const successorId = startNewConversation(p.key, cwd, null, undefined, { title: t("app.handoff.successorTitle", { title: parent.title }), inWorktree: parent.worktree });
      if (!successorId) return;
      if (!(await sendWhenReady(successorId, r.summary.firstMessage))) {
        toast(t("app.handoff.notStarted"), true);
        return;
      }
      // La parente : terminal arrêté et onglet fermé (son fichier va être déplacé), puis archivée.
      await killTerminal(sessionId).catch(() => {});
      releasedAt.current.set(sessionId, Date.now());
      setTerminals((ts) => ts.filter((x) => x.sessionId !== sessionId));
      setActiveTerminal((a) => (a === sessionId ? successorId : a));
      const done = await api.handoffFinish(parent.projectKey, sessionId, successorId);
      setConfig(done.config);
      if (done.archiveError) toast(t("app.handoff.archiveFailed", { title: parent.title, error: errorMessage(done.archiveError) }), true);
      else toast(t("app.handoff.done", { title: parent.title }));
      refresh();
    } catch (e) {
      showError(e);
    } finally {
      endHandoff(sessionId);
    }
  };

  /** Titre d'une conversation, dans un projet ou dans les archives. */
  const conversationTitle = (id: string): string | null =>
    findSession(id)?.s.title ?? config.archives.find((a) => a.sessionId === id)?.title ?? null;

  /** Parente et suite d'une conversation (liens « ← Suite de … » et « Suite : … → »). */
  const lineageOf = (id: string): HandoffLineage => {
    const link = (x: string | null) => (x ? { id: x, title: conversationTitle(x) ?? t("app.conversationNotFound") } : null);
    return { parent: link(parentOf(config, id)), successor: link(successorOf(config, id)) };
  };

  /** Ouvre une conversation par son identifiant : son onglet, ou les archives où elle est rangée. */
  const openConversationById = (id: string) => {
    const archive = config.archives.find((a) => a.sessionId === id);
    if (archive) {
      setSearchOpen(false);
      setSearchFocus({ projectKey: archive.projectKey, sessionId: id, archived: true, line: null, uuid: null });
      setSelection({ kind: "archives" });
      setActiveTerminal(null);
      return;
    }
    const found = findSession(id);
    if (found) openInTerminal(found.s, found.p.path);
    else toast(t("app.conversationMissing"), true);
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
      if (!isUiError(e, ERR_ACTIVE)) throw e;
      const ok = await ask(t("app.maybeActive.confirm", { message: msg }), {
        title: t("app.maybeActive.title"),
        kind: "warning",
        okLabel: t("app.maybeActive.continue"),
        cancelLabel: t("common.cancel"),
      });
      if (!ok) return false;
      await run(true);
      return true;
    }
  };

  const archiveSession = async (s: SessionInfo) => {
    try {
      const done = await withActiveCheck(async (force) => setConfig(await api.archiveSession(s.projectKey, s.id, force)));
      if (done) toast(t("app.conversation.archived", { title: s.title }));
    } catch (e) {
      showError(e);
    }
    refresh();
  };

  const trashSession = async (s: SessionInfo) => {
    const ok = await ask(t("app.conversation.trashConfirm", { title: s.title }), {
      title: t("app.conversation.trashTitle"),
      kind: "warning",
      okLabel: t("app.moveToTrash"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    try {
      const done = await withActiveCheck((force) => api.trashSession(s.projectKey, s.id, force));
      if (done) toast(t("app.conversation.trashed"));
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
    const ok =
      confirmed ||
      (await ask(t(trash ? "app.bulk.trashConfirm" : "app.bulk.archiveConfirm", { count: list.length, titles: titleList(list) }), {
        title: trash ? t("app.bulk.trashTitle") : t("app.bulk.archiveTitle"),
        kind: "warning",
        okLabel: trash ? t("app.moveToTrash") : t("common.archive"),
        cancelLabel: t("common.cancel"),
      }));
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
        if (!force && isUiError(e, ERR_ACTIVE)) active.push(s);
        else failed.push(t("app.bulk.failedItem", { title: s.title, message: msg }));
      }
    };
    for (const s of list) await attempt(s, false);

    let skipped = 0;
    if (active.length > 0) {
      const go = await ask(t("app.bulk.activeConfirm", { count: active.length, titles: titleList(active) }), {
        title: t("app.bulk.activeTitle"),
        kind: "warning",
        okLabel: trash ? t("app.bulk.trashToo") : t("app.bulk.archiveToo"),
        cancelLabel: t("app.bulk.ignore"),
      });
      if (go) for (const s of active) await attempt(s, true);
      else skipped = active.length;
    }

    const done = doneList.length;
    if (done > 0) {
      toast(t(trash ? "app.bulk.trashed" : "app.bulk.archived", { count: done, skipped }));
    } else if (skipped) {
      toast(t(trash ? "app.bulk.noneTrashed" : "app.bulk.noneArchived", { skipped }));
    }
    if (failed.length > 0) {
      toast(t("app.bulk.failed", { count: failed.length, list: shortList(failed) }), true);
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
      toast(t("app.project.closeTabsFirst", { name }), true);
      return;
    }
    const sessions = p.sessions.filter((s) => !s.provisional);
    const n = sessions.length;
    const ok = await ask(t("app.project.archiveConfirm", { name, count: n }), {
      title: t("app.project.archiveTitle"),
      kind: "warning",
      okLabel: t("app.project.archiveTitle"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    let ids: string[] = [];
    if (n > 0) {
      const r = await bulkSessionAction(sessions, "archive", true);
      if (!r) return;
      if (r.remaining > 0) {
        toast(t("app.project.notArchived", { name, count: r.remaining }), true);
        return;
      }
      ids = r.done.map((s) => s.id);
    }
    try {
      setConfig(await api.markProjectArchived(p.key, ids));
      toast(t("app.project.archived", { name }));
      setSelection((sel) => (sel?.kind === "project" && sel.key === p.key ? null : sel));
    } catch (e) {
      showError(e);
    }
  };

  const restoreProject = async (key: string, name: string) => {
    try {
      const r = await api.restoreProject(key);
      setConfig(r.config);
      toast(t("app.project.restored", { name, count: r.restored }));
      if (r.errors.length > 0) toast(t("app.restore.errors", { count: r.errors.length, list: shortList(r.errors.map(errorMessage)) }), true);
    } catch (e) {
      showError(e);
    }
    await refresh();
  };

  const restoreArchive = async (a: ArchiveEntry) => {
    try {
      setConfig(await api.restoreArchive(a.sessionId));
      toast(t("app.conversation.restored", { title: a.title }));
    } catch (e) {
      showError(e);
    }
    refresh();
  };

  const trashArchive = async (a: ArchiveEntry) => {
    const ok = await ask(t("app.archive.trashConfirm", { title: a.title }), {
      title: t("app.archive.trashTitle"),
      kind: "warning",
      okLabel: t("app.moveToTrash"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    try {
      setConfig(await api.trashArchive(a.sessionId));
      toast(t("app.archive.trashed"));
    } catch (e) {
      showError(e);
    }
  };

  // ---- Hubs (voir src/hubs.ts) ------------------------------------------------------------

  /** Modification des hubs par le backend (règles garanties côté Rust). */
  const hubCall = async (run: () => Promise<Config>) => {
    try {
      setConfig(await run());
    } catch (e) {
      showError(e);
    }
  };

  const createHub = async (name: string) => {
    try {
      setConfig((await api.hubCreate(name, null)).config);
      toast(t("app.hub.createdHint", { name }));
    } catch (e) {
      showError(e);
    }
  };

  /** « Ajouter à un hub… » validé : hub existant, ou nouveau hub créé d'abord. */
  const addToHub = async (sessionId: string, choice: HubChoice) => {
    try {
      let hubId: string;
      if ("newHubName" in choice) {
        const created = await api.hubCreate(choice.newHubName, null);
        setConfig(created.config);
        hubId = created.hubId;
      } else hubId = choice.hubId;
      setConfig(await api.hubSetMember(hubId, sessionId, choice.role));
    } catch (e) {
      showError(e);
    }
  };

  /** Conversation déposée sur un hub : exécutant s'il a un coordinateur, sinon pair. */
  const dropOnHub = (hubId: string, sessionId: string) => {
    const hub = config.hubs?.find((h) => h.id === hubId);
    if (!hub || hub.members.some((m) => m.conversationId === sessionId)) return;
    hubCall(() => api.hubSetMember(hubId, sessionId, defaultRole(hub)));
  };

  /**
   * Archive un hub : ses conversations partent dans les archives (comme pour un projet), puis
   * le hub est masqué de la barre latérale. S'il reste une conversation (ignorée ou en échec),
   * le hub n'est pas archivé. Les membres déjà archivés seuls restent dans les archives à la
   * restauration du hub.
   */
  const archiveHub = async (hub: Hub) => {
    const sessions = hub.members.flatMap((m) => {
      const found = findSession(m.conversationId);
      return found && !found.s.provisional ? [found.s] : [];
    });
    if (terminals.some((t) => sessions.some((s) => s.id === t.sessionId))) {
      toast(t("app.hub.closeTabsFirst", { name: hub.name }), true);
      return;
    }
    const n = sessions.length;
    const ok = await ask(t("app.hub.archiveConfirm", { name: hub.name, count: n }), {
      title: t("app.hub.archiveTitle"),
      kind: "warning",
      okLabel: t("app.hub.archiveTitle"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    let ids: string[] = [];
    if (n > 0) {
      const r = await bulkSessionAction(sessions, "archive", true);
      if (!r) return;
      if (r.remaining > 0) {
        toast(t("app.hub.notArchived", { name: hub.name, count: r.remaining }), true);
        return;
      }
      ids = r.done.map((s) => s.id);
    }
    try {
      setConfig(await api.hubMarkArchived(hub.id, ids));
      toast(t("app.hub.archived", { name: hub.name }));
    } catch (e) {
      showError(e);
    }
  };

  const restoreHub = async (hub: Hub) => {
    try {
      const r = await api.hubRestore(hub.id);
      setConfig(r.config);
      toast(t("app.hub.restored", { name: hub.name, count: r.restored }));
      if (r.errors.length > 0) toast(t("app.restore.errors", { count: r.errors.length, list: shortList(r.errors.map(errorMessage)) }), true);
    } catch (e) {
      showError(e);
    }
    await refresh();
  };

  const deleteHub = async (hub: Hub) => {
    const ok = await ask(t("app.hub.deleteConfirm", { name: hub.name }), {
      title: t("app.hub.deleteTitle"),
      kind: "warning",
      okLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
    });
    if (ok) hubCall(() => api.hubDelete(hub.id));
  };

  /**
   * Suggestion « hub » acceptée (deux conversations ont échangé) : si l'une est déjà dans un
   * hub, l'autre l'y rejoint (rôle par défaut du hub) ; sinon, fenêtre de création d'un hub où
   * l'expéditeur du premier message sera coordinateur et le destinataire exécutant.
   */
  const acceptHubSuggestion = async (s: Suggestion) => {
    const d = hubSuggestionData(s);
    if (!d.hubId) {
      setDialog({ kind: "hubFromExchange", from: d.from, to: d.to });
      return;
    }
    const hub = config.hubs?.find((h) => h.id === d.hubId);
    if (!hub || !d.joiner) return;
    try {
      setConfig(await api.hubSetMember(hub.id, d.joiner, defaultRole(hub)));
      toast(t("app.hub.joined", { title: conversationTitle(d.joiner) ?? t("app.hub.theConversation"), hub: hub.name }));
    } catch (e) {
      showError(e);
    }
  };

  /** Nouveau hub pour deux conversations qui ont échangé : `from` coordinateur, `to` exécutant. */
  const createHubFromExchange = async (name: string, from: string, to: string) => {
    try {
      const created = await api.hubCreate(name, null);
      setConfig(created.config);
      await api.hubSetMember(created.hubId, from, "coordinateur");
      setConfig(await api.hubSetMember(created.hubId, to, "executant"));
      toast(t("app.hub.created", { name }));
    } catch (e) {
      showError(e);
    }
  };

  /** Projets proposés pour un exécutant : connus, non archivés, avec un dossier existant. */
  const executorProjects = () =>
    [...projects.values()]
      .filter((p) => p.path && p.exists && !config.projects[p.key]?.archived && (!p.isTemp || config.showTempProjects))
      .map((p) => ({ key: p.key, name: projectName(p, config), path: p.path! }))
      .sort((a, b) => a.name.localeCompare(b.name));

  /** Projet du coordinateur (celui où il est affiché, ou celui de son archive). */
  const projectOfConversation = (id: string): string | null =>
    findSession(id)?.p.key ?? config.archives.find((a) => a.sessionId === id)?.projectKey ?? null;

  /**
   * « + Exécutant » validé : nouvelle conversation dans le projet choisi (dans un nouveau
   * worktree si demandé, sans la fenêtre « troisième conversation » : le choix vient d'être
   * fait), rangée dans le hub comme exécutant une fois lancée, avec pour premier message la
   * tâche et la consigne de rendre compte au coordinateur (ADR 0002 : l'app tape ce texte
   * comme l'utilisateur l'aurait fait).
   */
  const startExecutor = async (hubId: string, r: ExecutorRequest) => {
    const hub = config.hubs?.find((h) => h.id === hubId);
    const coordinator = hub ? coordinatorOf(hub) : null;
    const p = projects.get(r.projectKey);
    if (!hub || !coordinator || !p?.path) return;
    // Nom de messagerie relu au dernier moment : il change à chaque lancement du coordinateur.
    const messagingName = await messagesApi.messagingName(coordinator.conversationId).catch(() => null);
    const text = executorFirstMessage(r.task, hub.name, { messagingName, title: conversationTitle(coordinator.conversationId) ?? "coordinateur" });
    const firstLine = r.task.split(/\r?\n/)[0].trim();
    const title = firstLine.length > 60 ? firstLine.slice(0, 59) + "…" : firstLine;
    const id = startNewConversation(p.key, p.path, null, r.worktree ?? undefined, { title: title || newConversationTitle() });
    if (!id) return;
    joinHub.current.set(id, hub.id);
    if (!(await sendWhenReady(id, text))) toast(t("app.hub.executorNotStarted"), true);
  };

  /** Ouvre la « Vue Hub » dans la zone principale, comme un projet. */
  const openHub = (hubId: string) => {
    setSearchOpen(false);
    setSearchFocus(null);
    setSelection({ kind: "hub", id: hubId });
    setActiveTerminal(null);
  };

  const hubActions: HubActions = {
    onOpenConversation: openConversationById,
    onOpenHub: openHub,
    onRename: (hub) => setDialog({ kind: "renameHub", hub }),
    onColor: (hub, color) => hubCall(() => api.hubUpdate(hub.id, hub.name, color)),
    onArchive: archiveHub,
    onDelete: deleteHub,
    onSetRole: (hub, id, role) => hubCall(() => api.hubSetMember(hub.id, id, role)),
    onRemoveMember: (hub, id) => hubCall(() => api.hubRemoveMember(hub.id, id)),
    onAddExecutor: (hub) => {
      const blocked = executorBlocker(hub);
      if (blocked) toast(blocked, true);
      else setDialog({ kind: "addExecutor", hubId: hub.id });
    },
  };

  // ---- Propositions de skills (voir src/skills.ts) ----------------------------------------

  /** Fenêtre « Skills proposés » : son ouverture compte comme une revue (le rappel disparaît). */
  const openSkills = () => {
    setDialog({ kind: "skills" });
    api.skillsMarkReviewed().catch(() => {}).finally(refreshSkills);
  };

  const normPath = (p: string) => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  const samePath = (a: string, b: string) => normPath(a) === normPath(b);
  const projectAt = (path: string) => [...projects.values()].find((p) => p.path && samePath(p.path, path));

  /**
   * Créer : nouvelle conversation dans le projet visé (ou celui de la dernière demande pour un
   * skill de l'utilisateur), qui reçoit la demande de création du skill comme premier message.
   */
  const createSkill = async (proposal: SkillProposal, projectScope: boolean) => {
    const dir = (projectScope ? proposal.projectScope : null) ?? proposal.latestProject;
    const p = dir ? projectAt(dir) : undefined;
    if (!dir || !p?.path) {
      toast(t("skills.noProject", { path: dir ?? "?" }), true);
      return;
    }
    try {
      const text = await api.skillsCreationMessage(proposal.id, projectScope);
      if (!text) return;
      setDialog(null);
      const id = startNewConversation(p.key, p.path, null, undefined, { title: t("skills.conversationTitle", { name: proposal.name }) });
      if (!id) return;
      await api.skillsSetStatus(proposal.id, "created");
      refreshSkills();
      if (await sendWhenReady(id, text)) toast(t("skills.created", { name: proposal.name }));
    } catch (e) {
      toast(t("skills.createFailed", { error: errorMessage(e) }), true);
    }
  };

  const refuseSkill = (proposal: SkillProposal) => {
    api.skillsSetStatus(proposal.id, "refused").catch(showError).finally(refreshSkills);
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

  const shownHub = selection?.kind === "hub" ? (activeHubs(config).find((h) => h.id === selection.id) ?? null) : null;
  const conversationLinks = { titleOf: conversationTitle, open: openConversationById };

  const defaultCategory = selectedProject ? config.categories.find((c) => c.projectKeys.includes(selectedProject.key))?.id ?? null : null;

  return (
    <ConversationLinksContext.Provider value={conversationLinks}>
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
        onNewConversation={(p, sectionId) => newConversation(p.key, p.path, sectionId)}
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
        onSettings={() => setDialog({ kind: "settings" })}
        onSkills={openSkills}
        onAddHub={() => setDialog({ kind: "newHub" })}
        hubActions={hubActions}
        onDropOnHub={dropOnHub}
      />

      <div className="main-column">
      <TerminalTabBar terminals={tabs} home={shownHub ? "hub" : "project"} active={activeTerminal} onSelect={(id) => {
        // « Projets » : retour au projet de la conversation qu'on quitte (ou au hub affiché).
        if (id === null && activeProject && !shownHub) {
          setSearchOpen(false);
          setSelection({ kind: "project", key: activeProject.key });
        }
        setActiveTerminal(id);
      }} onClose={closeTerminal} extra={skillListing?.due ? <SkillsReminder onOpen={openSkills} /> : null} />
      <TerminalStack
        terminals={terminals}
        active={activeTerminal}
        onClose={closeTerminal}
        onStarted={terminalStarted}
        focus={searchFocus}
        onDismissSuggestion={(s) => (isLocalSuggestion(s) ? dismissStale(s.sessionId) : updateConfig((c) => dismissSuggestion(c, s)))}
        onTyping={(id) => noteTyping(id, config)}
        suggestionActions={{ [ACTION_HUB]: { run: acceptHubSuggestion } }}
        onHandoff={startHandoff}
        onFinish={{ run: finishTerminal, analyse: skillSettings(config).enabled }}
        lineageOf={lineageOf}
        onOpenConversation={openConversationById}
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
      ) : shownHub ? (
        <HubView hub={shownHub} config={config} projects={projects} titleOf={conversationTitle} actions={hubActions} />
      ) : selection?.kind === "archives" ? (
        <ArchivesView
          config={config}
          onRestore={restoreArchive}
          onTrash={trashArchive}
          onRestoreProject={restoreProject}
          onRestoreHub={restoreHub}
          focus={searchFocus?.archived ? searchFocus : null}
          lineageOf={lineageOf}
          onOpenConversation={openConversationById}
        />
      ) : selectedProject ? (
        <ProjectView
          project={selectedProject}
          config={config}
          terminal={scan.terminal}
          onLaunch={(id, path) => launch(path ?? selectedProject.path, id)}
          onNew={(sectionId, worktree) => newConversation(selectedProject.key, selectedProject.path, sectionId, worktree)}
          onOpen={(s) => openInTerminal(s, selectedProject.path)}
          onArchive={archiveSession}
          onTrash={trashSession}
          onHandoff={(s) => startHandoff(s.id)}
          onAddToHub={(s) => setDialog({ kind: "addToHub", session: s })}
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
        <main className="main empty-main">{t("app.selectProject")}</main>
      )}
      </div>

      {dialog?.kind === "newCategory" && (
        <TextPrompt
          title={t("app.category.new")}
          label={t("common.name")}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            updateConfig((c) => ({ ...c, categories: [...c.categories, { id: newId(), name, color: null, projectKeys: [] }] }));
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "renameCategory" && (
        <TextPrompt
          title={t("app.category.rename")}
          label={t("common.name")}
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
          title={t("app.project.renameTitle")}
          label={t("app.project.renameLabel")}
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
              if (r.startConversation) newConversation(key, r.path, null);
            } catch (e) {
              showError(e);
            }
          }}
        />
      )}

      {dialog?.kind === "worktreeOffer" && (
        <WorktreeOfferDialog
          count={dialog.count}
          validate={worktreeNameError}
          onClose={() => setDialog(null)}
          onSubmit={(worktree, dontAskAgain) => {
            setDialog(null);
            if (dontAskAgain) setProjectPref(dialog.projectKey, { noWorktreeOffer: true });
            startNewConversation(dialog.projectKey, dialog.path, dialog.sectionId, worktree ?? undefined);
          }}
        />
      )}
      {dialog?.kind === "newHub" && (
        <TextPrompt
          title={t("app.hub.new")}
          label={t("common.name")}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            setDialog(null);
            createHub(name);
          }}
        />
      )}
      {dialog?.kind === "renameHub" && (
        <TextPrompt
          title={t("app.hub.rename")}
          label={t("common.name")}
          initial={dialog.hub.name}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            setDialog(null);
            hubCall(() => api.hubUpdate(dialog.hub.id, name, dialog.hub.color));
          }}
        />
      )}
      {dialog?.kind === "addToHub" && (
        <HubDialog
          config={config}
          sessionId={dialog.session.id}
          title={dialog.session.title}
          titleOf={(id) => conversationTitle(id) ?? t("app.conversationNotFound")}
          onClose={() => setDialog(null)}
          onSubmit={(choice) => {
            setDialog(null);
            addToHub(dialog.session.id, choice);
          }}
          onRemove={(hub) => {
            setDialog(null);
            hubCall(() => api.hubRemoveMember(hub.id, dialog.session.id));
          }}
        />
      )}
      {dialog?.kind === "addExecutor" &&
        (() => {
          const hub = config.hubs?.find((h) => h.id === dialog.hubId);
          const coordinator = hub ? coordinatorOf(hub) : null;
          if (!hub || !coordinator) return null;
          return (
            <ExecutorDialog
              hub={hub}
              projects={executorProjects()}
              defaultProjectKey={projectOfConversation(coordinator.conversationId)}
              coordinator={{ id: coordinator.conversationId, title: conversationTitle(coordinator.conversationId) ?? t("app.conversationNotFoundTitle") }}
              validateWorktree={worktreeNameError}
              onOpenCoordinator={() => openConversationById(coordinator.conversationId)}
              onClose={() => setDialog(null)}
              onSubmit={(r) => {
                setDialog(null);
                startExecutor(hub.id, r);
              }}
            />
          );
        })()}
      {dialog?.kind === "hubFromExchange" && (
        <TextPrompt
          title={t("app.hub.createTitle")}
          label={t("app.hub.createFromExchangeLabel", { from: conversationTitle(dialog.from) ?? "?", to: conversationTitle(dialog.to) ?? "?" })}
          initial={conversationTitle(dialog.from) ?? ""}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            setDialog(null);
            createHubFromExchange(name, dialog.from, dialog.to);
          }}
        />
      )}
      {dialog?.kind === "skills" && skillListing && (
        <SkillsDialog
          listing={skillListing}
          windowDays={skillSettings(config).windowDays}
          projectName={(path) => {
            const p = projectAt(path);
            return p ? projectName(p, config) : "";
          }}
          onCreate={createSkill}
          onRefuse={refuseSkill}
          onClose={() => setDialog(null)}
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
    </ConversationLinksContext.Provider>
  );
}
