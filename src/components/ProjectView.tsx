// Vue d'un projet : en-tête (nom, couleur, catégorie, actions) et liste des conversations,
// regroupées en sections dans l'ordre choisi, dont la section par défaut (voir src/sections.ts).
// Chaque en-tête de section a une case pour sélectionner toutes ses conversations.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileSearch,
  FolderInput,
  FolderOpen,
  GripVertical,
  ListChecks,
  ListPlus,
  MessageSquarePlus,
  Pencil,
  Play,
  Plus,
  Search,
  GitBranch,
  GitBranchPlus,
  Handshake,
  Link2,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { api, errorMessage, type Config, type ProjectInfo, type Section, type SessionInfo } from "../api";
import { colorStyle, formatDate, isMac, modKey, projectName, relativeDate } from "../util";
import {
  DEFAULT_SECTION_ID,
  addSection,
  conversationColor,
  defaultSection,
  deleteSection,
  groupBySection,
  moveSection,
  projectSections,
  putConversationInSection,
  renameSection,
  setConversationColor,
  setSectionCollapsed,
  setSectionColor,
  storedSectionId,
} from "../sections";
import { ColorPicker } from "./ColorPicker";
import { useScrollToFocus, type SearchFocus } from "./GlobalSearch";
import { TextPrompt, WorktreePrompt } from "./Dialogs";
import { worktreeNameError } from "../pty";
import { ActivityDot } from "./Activity";
import { useActivities, type Activity } from "../activity";
import { handoffBlocker, useHandoffState } from "../handoff";
import { hubHint, hubOf } from "../hubs";
import { HubLinkIcon } from "./Hubs";

interface Props {
  project: ProjectInfo;
  config: Config;
  terminal: string;
  /** `path` : dossier où relancer (worktree), sinon celui du projet. */
  onLaunch: (sessionId?: string, path?: string) => void;
  /**
   * Nouvelle conversation dans le terminal intégré, rangée dans `sectionId` : bouton « + »
   * de l'en-tête d'une section, ou `null` (section par défaut) pour le bouton principal.
   * `worktree` : dans un nouveau worktree, avec ce nom (vide = nom choisi par Claude Code).
   */
  onNew: (sectionId: string | null, worktree?: string) => void;
  /** Ouvre la conversation dans le terminal intégré. */
  onOpen: (s: SessionInfo) => void;
  onArchive: (s: SessionInfo) => void;
  onTrash: (s: SessionInfo) => void;
  /** Hand off d'une conversation (voir src/handoff.ts). */
  onHandoff: (s: SessionInfo) => void;
  /** « Ajouter à un hub… » : choix du hub et du rôle (voir src/hubs.ts). */
  onAddToHub: (s: SessionInfo) => void;
  /**
   * Archive / met à la Corbeille plusieurs conversations du projet (sélection multiple).
   * Renvoie `false` si l'utilisateur a annulé (la sélection est alors gardée).
   */
  onArchiveMany: (list: SessionInfo[]) => Promise<boolean>;
  onTrashMany: (list: SessionInfo[]) => Promise<boolean>;
  onRename: () => void;
  onColor: (color: string | null) => void;
  onMove: (categoryId: string | null) => void;
  onForget: () => void;
  /** Archive le projet et toutes ses conversations (il disparaît de la barre latérale). */
  onArchiveProject: () => void;
  onError: (msg: string) => void;
  /** Conversation ouverte depuis la recherche globale : affichée et mise en évidence. */
  focus?: SearchFocus | null;
  /** Modifie la configuration (sections, couleurs des conversations). */
  onConfigChange: (change: (c: Config) => Config) => void;
}

export function ProjectView(props: Props) {
  const { project: p, config } = props;
  const [query, setQuery] = useState("");
  const [deep, setDeep] = useState(false);
  const [deepHits, setDeepHits] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);
  // État de chaque conversation (pastille d'activité).
  const activities = useActivities();

  // Nouvelle recherche quand on change de projet.
  useEffect(() => {
    setQuery("");
    setDeepHits(null);
  }, [p.key]);

  // Conversation ouverte depuis la recherche globale : vide le filtre pour qu'elle soit visible.
  useEffect(() => {
    if (props.focus) setQuery("");
  }, [props.focus]);
  useScrollToFocus(props.focus);

  // Recherche dans le contenu des conversations (côté Rust), avec un petit délai de frappe.
  useEffect(() => {
    if (!deep || query.trim().length < 2) {
      setDeepHits(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      api
        .searchSessions(p.key, query)
        .then((ids) => !cancelled && setDeepHits(new Set(ids)))
        .catch((e) => !cancelled && props.onError(errorMessage(e)))
        .finally(() => !cancelled && setSearching(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deep, query, p.key]);

  /** Filtre local instantané (titre, premier message, id) + résultats plein texte. */
  const sessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return p.sessions;
    return p.sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.firstPrompt ?? "").toLowerCase().includes(q) ||
        s.id.startsWith(q) ||
        deepHits?.has(s.id),
    );
  }, [p.sessions, query, deepHits]);

  const categoryId = config.categories.find((c) => c.projectKeys.includes(p.key))?.id ?? "";
  const color = config.projects[p.key]?.color;
  const canLaunch = p.exists && !!p.path;

  /** Une conversation de worktree se reprend dans le dossier du worktree. */
  const resumePath = (s: SessionInfo) => (s.worktree && s.projectKey !== p.key ? s.worktree.path : undefined);
  const canResume = (s: SessionInfo) => (s.worktree && s.projectKey !== p.key ? s.worktree.exists : canLaunch);

  // « Dans un nouveau worktree » : proposé seulement si le dossier du projet est un dépôt git.
  const [isGit, setIsGit] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setIsGit(false);
    if (canLaunch && p.path) api.isGitRepo(p.path).then((g) => !cancelled && setIsGit(g)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [p.path, canLaunch]);
  /** Section de la nouvelle conversation en worktree dont on demande le nom (null = section par défaut). */
  const [worktreeFor, setWorktreeFor] = useState<{ sectionId: string | null } | null>(null);

  // ---- Sections -------------------------------------------------------------------------

  const [sectionDialog, setSectionDialog] = useState<{ kind: "new" } | { kind: "rename"; section: Section } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const groups = useMemo(() => groupBySection(config, p.key, sessions), [config, p.key, sessions]);
  const defaultName = defaultSection(config, p.key).name;
  /** Projet sans aucune conversation ni autre section : un message plutôt qu'une section vide. */
  const empty = sessions.length === 0 && groups.sections.length === 1;
  const filtering = query.trim().length > 0;
  const change = props.onConfigChange;

  // ---- Sélection multiple ---------------------------------------------------------------
  // Ctrl+clic ajoute ou retire une conversation, Maj+clic sélectionne une plage (dans l'ordre
  // affiché), la case à cocher fait comme Ctrl+clic. Tant qu'une sélection existe, un simple
  // clic sur une ligne la coche ou la décoche au lieu d'ouvrir la conversation.
  // Limitée au projet affiché ; les conversations provisoires (sans fichier) en sont exclues.

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** Point de départ d'une plage Maj+clic : dernière conversation cochée ou décochée. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [sectionForSelection, setSectionForSelection] = useState(false);

  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
  }, [p.key]);

  /**
   * Conversations sélectionnées encore présentes (une conversation archivée ou supprimée
   * disparaît d'elle-même). Celles masquées par la recherche restent sélectionnées.
   */
  const selectedSessions = useMemo(() => p.sessions.filter((s) => !s.provisional && selected.has(s.id)), [p.sessions, selected]);
  const selecting = selectedSessions.length > 0;

  /** Conversations sélectionnables, dans l'ordre affiché (sections repliées exclues). */
  const displayed = useMemo(
    () => groups.sections.flatMap((g) => (g.section.collapsed ? [] : g.sessions)).filter((s) => !s.provisional),
    [groups],
  );
  const allDisplayedSelected = displayed.length > 0 && displayed.every((s) => selected.has(s.id));

  const clearSelection = () => {
    setSelected(new Set());
    setAnchor(null);
  };
  const selectAll = () => setSelected((sel) => new Set([...sel, ...displayed.map((s) => s.id)]));

  /** Case d'une section : état (aucune / partielle / toutes) et bascule, section repliée comprise. */
  const sectionSelectable = (list: SessionInfo[]) => list.filter((s) => !s.provisional);
  const sectionSelectState = (list: SessionInfo[]): "none" | "some" | "all" => {
    const ids = sectionSelectable(list);
    const n = ids.filter((s) => selected.has(s.id)).length;
    return n === 0 ? "none" : n === ids.length ? "all" : "some";
  };
  const toggleSection = (list: SessionInfo[]) => {
    const ids = sectionSelectable(list).map((s) => s.id);
    const all = sectionSelectState(list) === "all";
    setSelected((sel) => {
      const next = new Set(sel);
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  /** Clic sur la case à cocher (`toggle`) ou sur la ligne d'une conversation. */
  const selectClick = (s: SessionInfo, e: React.MouseEvent, toggle: boolean) => {
    const from = anchor ? displayed.findIndex((x) => x.id === anchor) : -1;
    const to = displayed.findIndex((x) => x.id === s.id);
    if (e.shiftKey && from >= 0 && to >= 0) {
      // Plage, comme dans l'Explorateur : remplace la sélection (Ctrl+Maj : s'y ajoute).
      const range = displayed.slice(Math.min(from, to), Math.max(from, to) + 1).map((x) => x.id);
      setSelected((sel) => new Set([...(e.ctrlKey || e.metaKey ? sel : []), ...range]));
      return;
    }
    if (!toggle && !(e.ctrlKey || e.metaKey || e.shiftKey)) return;
    setSelected((sel) => {
      const next = new Set(sel);
      if (next.has(s.id)) next.delete(s.id);
      else next.add(s.id);
      return next;
    });
    setAnchor(s.id);
  };

  // Échap vide la sélection (sauf si un menu ou une boîte de dialogue est ouvert : Échap le ferme).
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".popover, .modal-backdrop")) return;
      setSelected(new Set());
      setAnchor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);

  /**
   * Range des conversations dans une section (`null` = section par défaut) et la déplie, pour
   * que les conversations déplacées (souvent encore sélectionnées) restent visibles.
   */
  const putInSection = (cfg: Config, sectionId: string | null, ids: string[]) => {
    const next = ids.reduce((c, id) => putConversationInSection(c, p.key, storedSectionId(sectionId), id), cfg);
    const target = projectSections(next, p.key).find((s) => s.id === (sectionId ?? DEFAULT_SECTION_ID));
    return target?.collapsed ? setSectionCollapsed(next, p.key, target.id, false) : next;
  };

  /**
   * Conversations à faire défiler jusqu'à l'écran une fois arrivées dans leur section
   * (après un déplacement) : `center` pour le menu « Ranger dans une section », `nearest`
   * après un glisser-déposer (la cible est déjà sous les yeux).
   */
  const [reveal, setReveal] = useState<{ sectionId: string; ids: string[]; block: ScrollLogicalPosition } | null>(null);
  const moveTo = (sectionId: string | null, ids: string[], block: ScrollLogicalPosition) => {
    change((c) => putInSection(c, sectionId, ids));
    setReveal({ sectionId: sectionId ?? DEFAULT_SECTION_ID, ids, block });
  };

  useEffect(() => {
    if (!reveal) return;
    // La configuration se met à jour après coup : on attend que les lignes soient dans la section.
    const zone = document.querySelector(`[data-section-id="${window.CSS.escape(reveal.sectionId)}"]`);
    const rows = reveal.ids
      .map((id) => zone?.querySelector(`[data-session-id="${window.CSS.escape(id)}"]`))
      .filter((el): el is Element => !!el);
    if (rows.length > 0) {
      rows[0].scrollIntoView({ block: reveal.block, behavior: "smooth" });
      setReveal(null);
      return;
    }
    // Conversations masquées (recherche) : on abandonne.
    const t = window.setTimeout(() => setReveal(null), 1500);
    return () => window.clearTimeout(t);
  }, [reveal, groups]);

  /** Couleur commune des conversations sélectionnées (aucune si elles diffèrent). */
  const selectionColor = useMemo(() => {
    const colors = new Set(selectedSessions.map((s) => conversationColor(config, s.id)));
    return colors.size === 1 ? [...colors][0] : null;
  }, [selectedSessions, config]);

  const bulk = async (run: (list: SessionInfo[]) => Promise<boolean>) => {
    if (await run(selectedSessions)) clearSelection();
  };

  // Un petit déplacement est nécessaire avant de commencer à glisser : les clics restent des clics.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  /**
   * Détection de la cible : une section glissée vise les autres sections ; une conversation
   * glissée vise une zone de dépôt (corps d'une section), sinon un en-tête.
   */
  const collision: CollisionDetection = (args) => {
    if (String(args.active.id).startsWith("s:")) {
      const secs = args.droppableContainers.filter((c) => String(c.id).startsWith("s:"));
      return closestCenter({ ...args, droppableContainers: secs });
    }
    const hits = pointerWithin(args);
    for (const prefix of ["zone:", "s:"]) {
      const hit = hits.filter((h) => String(h.id).startsWith(prefix));
      if (hit.length) return hit;
    }
    return [];
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragId(null);
    if (!over) return;
    const a = String(active.id);
    const o = String(over.id);
    if (a.startsWith("s:")) {
      if (o.startsWith("s:")) change((c) => moveSection(c, p.key, a.slice(2), o.slice(2)));
      return;
    }
    const target = o.startsWith("zone:") ? o.slice(5) : o.startsWith("s:") ? o.slice(2) : null;
    if (!target || !a.startsWith("v:")) return;
    // Une conversation sélectionnée emmène toute la sélection.
    const ids = draggedIds(a.slice(2)).filter(
      (id) => (groups.sections.find((g) => g.sessions.some((s) => s.id === id))?.section.id ?? DEFAULT_SECTION_ID) !== target,
    );
    if (ids.length === 0) return;
    moveTo(storedSectionId(target), ids, "nearest");
  };

  /** Conversations déplacées en glissant `id` : toute la sélection si elle en fait partie. */
  const draggedIds = (id: string) => (selected.has(id) && selecting ? selectedSessions.map((s) => s.id) : [id]);

  const confirmDeleteSection = async (section: Section) => {
    const n = section.conversationIds.length;
    const ok = await ask(
      `Supprimer la section « ${section.name} » ?` + (n ? `\nSes conversations reviendront dans « ${defaultName} ».` : ""),
      { title: "Supprimer la section", kind: "warning", okLabel: "Supprimer", cancelLabel: "Annuler" },
    );
    if (ok) change((c) => deleteSection(c, p.key, section.id));
  };

  const draggedSession = dragId?.startsWith("v:") ? p.sessions.find((s) => s.id === dragId.slice(2)) : undefined;
  const draggedSection = dragId?.startsWith("s:") ? groups.sections.find((g) => g.section.id === dragId.slice(2))?.section : undefined;
  /** Nombre de conversations glissées ensemble (sélection). */
  const draggedCount = draggedSession ? draggedIds(draggedSession.id).length : 0;
  const draggingSelection = draggedCount > 1;

  const row = (s: SessionInfo) => (
    <SessionRow
      key={s.id}
      session={s}
      color={conversationColor(config, s.id)}
      activity={activities.get(s.id)}
      canLaunch={canResume(s)}
      selected={!s.provisional && selected.has(s.id)}
      selecting={selecting}
      dimmed={draggingSelection && selected.has(s.id)}
      onSelect={(e, toggle) => selectClick(s, e, toggle)}
      onLaunch={() => props.onLaunch(s.id, resumePath(s))}
      onOpen={() => props.onOpen(s)}
      terminal={props.terminal}
      onArchive={() => props.onArchive(s)}
      onTrash={() => props.onTrash(s)}
      onColor={(c) => change((cfg) => setConversationColor(cfg, s.id, c))}
      onHandoff={() => props.onHandoff(s)}
      config={config}
      onAddToHub={() => props.onAddToHub(s)}
    />
  );

  return (
    <main className="main">
      <header className="project-header" style={colorStyle(color)}>
        <div className="project-title">
          <h2>{projectName(p, config)}</h2>
          <button className="icon-btn" title="Renommer (nom d'affichage)" onClick={props.onRename}>
            <Pencil size={15} />
          </button>
        </div>
        <button
          className="project-path"
          title={isMac ? "Ouvrir dans le Finder" : "Ouvrir dans l'Explorateur"}
          disabled={!canLaunch}
          onClick={() => p.path && api.openFolder(p.path).catch((e) => props.onError(errorMessage(e)))}
        >
          <FolderOpen size={13} /> {p.path ?? "Chemin inconnu"}
        </button>
        <div className="project-actions">
          <button
            className="btn primary"
            disabled={!canLaunch}
            onClick={() => props.onNew(null)}
            title={`Lance « claude » dans le terminal intégré (rangée dans « ${defaultName} »)`}
          >
            <MessageSquarePlus size={15} /> Nouvelle conversation
          </button>
          {isGit && (
            <button
              className="btn ghost"
              disabled={!canLaunch}
              onClick={() => setWorktreeFor({ sectionId: null })}
              title="Nouvelle conversation dans un nouveau worktree : copie de travail séparée (claude --worktree)"
            >
              <GitBranchPlus size={14} /> Dans un nouveau worktree
            </button>
          )}
          <button className="btn ghost" disabled={!canLaunch} onClick={() => props.onLaunch()} title={`Ouvre ${props.terminal} et lance « claude »`}>
            <ExternalLink size={14} /> Nouveau dans un terminal externe
          </button>
          <ColorPicker value={color} onChange={props.onColor} title="Couleur" />
          <select className="select" value={categoryId} onChange={(e) => props.onMove(e.target.value || null)} title="Catégorie">
            <option value="">Non classés</option>
            {config.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            className="btn ghost"
            onClick={props.onArchiveProject}
            title="Archive le projet et toutes ses conversations : il disparaît de la barre latérale et se restaure depuis les Archives (le dossier n'est pas touché)"
          >
            <Archive size={14} /> Archiver le projet
          </button>
          {p.sessions.length === 0 && (
            <button className="btn ghost" onClick={props.onForget} title="Retire ce projet de la liste (le dossier n'est pas touché)">
              <X size={14} /> Retirer de la liste
            </button>
          )}
        </div>
      </header>

      {!p.exists && (
        <div className="banner warn">
          <TriangleAlert size={15} /> Le dossier de ce projet est introuvable : impossible de lancer Claude depuis ici.
        </div>
      )}

      <div className="search-bar">
        <Search size={15} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher une conversation…" />
        {query && (
          <button className="icon-btn" onClick={() => setQuery("")} title="Effacer">
            <X size={14} />
          </button>
        )}
        <label className={"toggle" + (deep ? " on" : "")} title="Cherche aussi dans le texte de tous les messages">
          <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
          <FileSearch size={14} /> Dans le contenu {searching && "…"}
        </label>
        <button
          className="icon-btn"
          disabled={displayed.length === 0 || allDisplayedSelected}
          onClick={selectAll}
          title={`Tout sélectionner (conversations affichées) — ou ${modKey}+clic, Maj+clic sur les conversations`}
        >
          <ListChecks size={15} />
        </button>
        <button className="btn small" onClick={() => setSectionDialog({ kind: "new" })} title="Regrouper des conversations de ce projet">
          <ListPlus size={14} /> Section
        </button>
      </div>

      <div className="session-list">
        {empty && (
          <div className="empty">{p.sessions.length === 0 ? "Aucune conversation dans ce projet." : "Aucune conversation ne correspond à la recherche."}</div>
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          onDragStart={(e) => setDragId(String(e.active.id))}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragId(null)}
        >
          <SortableContext items={groups.sections.map((g) => "s:" + g.section.id)} strategy={verticalListSortingStrategy}>
            {groups.sections.map(({ section, sessions: list }) =>
              (filtering || empty) && list.length === 0 ? null : (
                <SectionBlock
                  key={section.id}
                  section={section}
                  count={list.length}
                  selectState={sectionSelectState(list)}
                  selecting={selecting}
                  onSelectAll={sectionSelectable(list).length ? () => toggleSection(list) : undefined}
                  onToggle={() => change((c) => setSectionCollapsed(c, p.key, section.id, !section.collapsed))}
                  onRename={() => setSectionDialog({ kind: "rename", section })}
                  onDelete={section.id === DEFAULT_SECTION_ID ? undefined : () => confirmDeleteSection(section)}
                  onColor={(color) => change((c) => setSectionColor(c, p.key, section.id, color))}
                  onNew={
                    canLaunch
                      ? () => {
                          // Section repliée : dépliée pour voir la nouvelle conversation.
                          if (section.collapsed) change((c) => setSectionCollapsed(c, p.key, section.id, false));
                          props.onNew(storedSectionId(section.id));
                        }
                      : undefined
                  }
                  onNewWorktree={
                    canLaunch && isGit
                      ? () => {
                          if (section.collapsed) change((c) => setSectionCollapsed(c, p.key, section.id, false));
                          setWorktreeFor({ sectionId: storedSectionId(section.id) });
                        }
                      : undefined
                  }
                >
                  {list.map(row)}
                </SectionBlock>
              ),
            )}
          </SortableContext>

          <DragOverlay dropAnimation={null}>
            {draggedSession && (
              <div className="session-row overlay" style={colorStyle(conversationColor(config, draggedSession.id))}>
                <div className="session-title">{draggedSession.title}</div>
                {draggingSelection && <span className="badge drag-count">{draggedCount} conversations</span>}
              </div>
            )}
            {draggedSection && (
              <div className="section overlay" style={colorStyle(draggedSection.color)}>
                <div className="section-header">{draggedSection.name}</div>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>

      {selecting && (
        <div className="selection-bar">
          <span className="selection-count">
            {selectedSessions.length} sélectionnée{selectedSessions.length > 1 ? "s" : ""}
          </span>
          <button className="btn small ghost" disabled={allDisplayedSelected} onClick={selectAll} title="Sélectionne toutes les conversations affichées">
            Tout sélectionner
          </button>
          <button className="btn small ghost" onClick={clearSelection} title="Échap">
            Tout désélectionner
          </button>
          <span className="selection-spacer" />
          <SectionMenu
            sections={projectSections(config, p.key)}
            onPick={(sectionId) => moveTo(storedSectionId(sectionId), selectedSessions.map((s) => s.id), "center")}
            onNew={() => setSectionForSelection(true)}
          />
          <ColorPicker
            value={selectionColor}
            onChange={(color) => change((c) => selectedSessions.reduce((cfg, s) => setConversationColor(cfg, s.id, color), c))}
            title="Couleur"
          />
          <button className="btn small" onClick={() => bulk(props.onArchiveMany)}>
            <Archive size={13} /> Archiver
          </button>
          <button className="btn small danger" onClick={() => bulk(props.onTrashMany)}>
            <Trash2 size={13} /> Corbeille
          </button>
        </div>
      )}

      {worktreeFor && (
        <WorktreePrompt
          validate={worktreeNameError}
          onClose={() => setWorktreeFor(null)}
          onSubmit={(name) => {
            props.onNew(worktreeFor.sectionId, name);
            setWorktreeFor(null);
          }}
        />
      )}
      {sectionDialog?.kind === "new" && (
        <TextPrompt
          title="Nouvelle section"
          label="Nom"
          onClose={() => setSectionDialog(null)}
          onSubmit={(name) => {
            change((c) => addSection(c, p.key, name));
            setSectionDialog(null);
          }}
        />
      )}
      {sectionForSelection && (
        <TextPrompt
          title="Nouvelle section"
          label="Nom"
          onClose={() => setSectionForSelection(false)}
          onSubmit={(name) => {
            const ids = selectedSessions.map((s) => s.id);
            change((c) => {
              const next = addSection(c, p.key, name);
              const list = projectSections(next, p.key);
              const created = list[list.length - 1];
              if (!created) return next;
              setReveal({ sectionId: created.id, ids, block: "center" });
              return putInSection(next, created.id, ids);
            });
            setSectionForSelection(false);
          }}
        />
      )}
      {sectionDialog?.kind === "rename" && (
        <TextPrompt
          title="Renommer la section"
          label="Nom"
          initial={sectionDialog.section.name}
          onClose={() => setSectionDialog(null)}
          onSubmit={(name) => {
            change((c) => renameSection(c, p.key, sectionDialog.section.id, name));
            setSectionDialog(null);
          }}
        />
      )}
    </main>
  );
}

function SectionBlock(props: {
  section: Section;
  count: number;
  /** Conversations de la section dans la sélection : aucune, une partie, toutes. */
  selectState: "none" | "some" | "all";
  /** Une sélection existe : la case reste visible. */
  selecting: boolean;
  /** Coche ou décoche toutes les conversations de la section (absent si elle n'en a pas). */
  onSelectAll?: () => void;
  onToggle: () => void;
  onRename: () => void;
  /** Absent pour la section par défaut, qui ne se supprime pas. */
  onDelete?: () => void;
  onColor: (c: string | null) => void;
  /** Nouvelle conversation dans cette section (absent si le projet ne peut pas lancer Claude). */
  onNew?: () => void;
  /** Idem, dans un nouveau worktree (absent si le projet n'est pas un dépôt git). */
  onNewWorktree?: () => void;
  children: React.ReactNode;
}) {
  const { section } = props;
  const sortable = useSortable({ id: "s:" + section.id });
  const zone = useDroppable({ id: "zone:" + section.id });
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : 1,
  };
  // Les boutons ne doivent pas déclencher le glisser-déposer.
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <section
      ref={sortable.setNodeRef}
      data-section-id={section.id}
      style={style}
      className={"section" + (section.color ? " colored" : "") + (zone.isOver || sortable.isOver ? " drop-over" : "")}
    >
      <div
        className={"section-header" + (props.selecting || props.selectState !== "none" ? " selecting" : "")}
        style={colorStyle(section.color)}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical size={14} className="grip" />
        {props.onSelectAll && <SectionCheck state={props.selectState} onToggle={props.onSelectAll} onPointerDown={stop} />}
        <button className="icon-btn bare" onPointerDown={stop} onClick={props.onToggle} title={section.collapsed ? "Déplier" : "Replier"}>
          {section.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span className="section-name" onDoubleClick={props.onRename}>
          {section.name}
        </span>
        <span className="count">{props.count}</span>
        <span className="hover-actions" onPointerDown={stop}>
          {props.onNew && (
            <button className="icon-btn" title="Nouvelle conversation dans cette section (terminal intégré)" onClick={props.onNew}>
              <Plus size={13} />
            </button>
          )}
          {props.onNewWorktree && (
            <button className="icon-btn" title="Nouvelle conversation dans un nouveau worktree, dans cette section" onClick={props.onNewWorktree}>
              <GitBranchPlus size={13} />
            </button>
          )}
          <button className="icon-btn" title="Renommer" onClick={props.onRename}>
            <Pencil size={13} />
          </button>
          <ColorPicker compact value={section.color} onChange={props.onColor} title="Couleur de la section" />
          {props.onDelete && (
            <button className="icon-btn" title="Supprimer la section" onClick={props.onDelete}>
              <Trash2 size={13} />
            </button>
          )}
        </span>
      </div>
      <div ref={zone.setNodeRef} className="section-body">
        {!section.collapsed && props.children}
        {!section.collapsed && props.count === 0 && <div className="empty-zone">Déposez des conversations ici</div>}
      </div>
    </section>
  );
}

/** Case à trois états de l'en-tête d'une section : sélectionne toutes ses conversations. */
function SectionCheck(props: { state: "none" | "some" | "all"; onToggle: () => void; onPointerDown: (e: React.PointerEvent) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = props.state === "some";
  }, [props.state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="section-check"
      checked={props.state === "all"}
      readOnly
      title={props.state === "all" ? "Désélectionner les conversations de la section" : "Sélectionner toutes les conversations de la section"}
      onPointerDown={props.onPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        props.onToggle();
      }}
    />
  );
}

/** Menu « Ranger dans une section… » de la barre de sélection. */
function SectionMenu(props: { sections: Section[]; onPick: (sectionId: string | null) => void; onNew: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fermeture au clic à l'extérieur ou sur Échap (comme le sélecteur de couleur).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (run: () => void) => {
    setOpen(false);
    run();
  };
  return (
    <div className="color-picker" ref={ref}>
      <button className="btn small" onClick={() => setOpen((o) => !o)}>
        <FolderInput size={13} /> Ranger dans une section…
      </button>
      {open && (
        <div className="popover menu">
          {props.sections.map((s) => (
            <button key={s.id} className="menu-item" onClick={() => pick(() => props.onPick(s.id))}>
              <span className="swatch-dot" style={{ background: s.color ?? "transparent" }} /> {s.name}
            </button>
          ))}
          <div className="menu-separator" />
          <button className="menu-item" onClick={() => pick(props.onNew)}>
            <Plus size={13} /> Nouvelle section…
          </button>
        </div>
      )}
    </div>
  );
}

function SessionRow(props: {
  session: SessionInfo;
  color: string | null;
  /** État de la conversation (absent : fermée). */
  activity?: Activity;
  canLaunch: boolean;
  /** Fait partie de la sélection multiple. */
  selected: boolean;
  /** Une sélection existe : la case à cocher reste visible et un clic coche au lieu d'ouvrir. */
  selecting: boolean;
  /** Emmenée avec la sélection en cours de glisser-déposer. */
  dimmed: boolean;
  /** Clic de sélection : `toggle` pour la case à cocher, sinon selon Ctrl / Maj. */
  onSelect: (e: React.MouseEvent, toggle: boolean) => void;
  onLaunch: () => void;
  /** Ouvre la conversation dans le terminal intégré. */
  onOpen: () => void;
  /** Nom du terminal externe, pour l'info-bulle. */
  terminal: string;
  onArchive: () => void;
  onTrash: () => void;
  onColor: (c: string | null) => void;
  /** Hand off (disponible quand la conversation est « à toi »). */
  onHandoff: () => void;
  config: Config;
  /** « Ajouter à un hub… ». */
  onAddToHub: () => void;
}) {
  const { session: s, canLaunch } = props;
  const handoffReason = handoffBlocker(props.activity, useHandoffState(s.id));
  const drag = useDraggable({ id: "v:" + s.id });
  // Les boutons ne doivent pas déclencher le glisser-déposer.
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  const onClick = (e: React.MouseEvent) => {
    // Une conversation provisoire (sans fichier) ne se sélectionne pas.
    if (!s.provisional && (props.selecting || e.ctrlKey || e.metaKey || e.shiftKey)) props.onSelect(e, props.selecting);
    else if (!props.selecting && canLaunch) props.onOpen();
  };
  return (
    <div
      ref={drag.setNodeRef}
      data-session-id={s.id}
      className={"session-row" + (props.color ? " colored" : "") + (props.selected ? " selected" : "") + (props.selecting ? " selecting" : "")}
      style={{ ...colorStyle(props.color), opacity: drag.isDragging || props.dimmed ? 0.35 : 1 }}
      onClick={onClick}
      // Maj+clic : pas de sélection de texte.
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      {...drag.attributes}
      {...drag.listeners}
    >
      {s.provisional ? (
        <span className="session-check" />
      ) : (
        <input
          type="checkbox"
          className="session-check"
          checked={props.selected}
          readOnly
          title={`Sélectionner (${modKey}+clic, Maj+clic pour une plage)`}
          onPointerDown={stop}
          onClick={(e) => {
            e.stopPropagation();
            props.onSelect(e, true);
          }}
        />
      )}
      {/* Pastille d'activité : elle garde ses propres couleurs, séparée de la couleur de
          la conversation (le fond de la ligne). */}
      <ActivityDot activity={props.activity} />
      <div className="session-main">
        <div className="session-title" title={s.firstPrompt ?? s.title}>
          {s.title}
          <HubLinkIcon config={props.config} sessionId={s.id} />
        </div>
        {s.provisional ? (
          <div className="session-meta">
            <span>Pas encore de message : envoyez-en un dans le terminal intégré</span>
            {s.worktree && (
              <span className="badge worktree" title={`Nouveau worktree : ${s.worktree.path}`}>
                <GitBranch size={11} /> worktree {s.worktree.name}
              </span>
            )}
            <span className="session-id">{s.id.slice(0, 8)}</span>
          </div>
        ) : (
        <div className="session-meta">
          <span title={`Créée le ${formatDate(s.createdAt)}`}>{formatDate(s.updatedAt)}</span>
          <span className="dot">·</span>
          <span>{relativeDate(s.updatedAt)}</span>
          <span className="dot">·</span>
          <span>
            {s.messageCount} message{s.messageCount > 1 ? "s" : ""}
          </span>
          {s.worktree && (
            <span
              className={"badge worktree" + (s.worktree.exists ? "" : " gone")}
              title={s.worktree.exists ? s.worktree.path : `Ce worktree n'existe plus : ${s.worktree.path}`}
            >
              <GitBranch size={11} /> {s.worktree.exists ? `worktree ${s.worktree.name}` : `worktree supprimé (${s.worktree.name})`}
            </span>
          )}
          {s.skippedLines > 0 && (
            <span className="warn" title="Lignes illisibles ignorées dans le fichier">
              · {s.skippedLines} ligne(s) ignorée(s)
            </span>
          )}
          <span className="session-id">{s.id.slice(0, 8)}</span>
        </div>
        )}
      </div>
      {/* Les clics des boutons ne remontent pas à la ligne (sinon la conversation s'ouvrirait deux fois). */}
      <div className="session-actions" onPointerDown={stop} onClick={(e) => e.stopPropagation()}>
        <button className="btn small primary" disabled={!canLaunch} onClick={props.onOpen} title="claude --resume, dans le terminal intégré">
          <Play size={13} /> Reprendre
        </button>
        {/* Sans fichier, rien d'autre n'est possible : reprise externe, archive, Corbeille. */}
        {!s.provisional && (
        <>
        <button className="icon-btn" disabled={!canLaunch} onClick={props.onLaunch} title={`Ouvrir dans un terminal externe (${props.terminal})`}>
          <ExternalLink size={15} />
        </button>
        <ColorPicker compact value={props.color} onChange={props.onColor} title="Couleur de la conversation" />
        <button
          className="icon-btn"
          disabled={!!handoffReason}
          title={handoffReason ? `Hand off\n${handoffReason}` : "Hand off : passer le relais à une nouvelle conversation, avec un résumé de passation"}
          onClick={props.onHandoff}
        >
          <Handshake size={15} />
        </button>
        <button className="icon-btn" title={hubButtonTitle(props.config, s.id)} onClick={props.onAddToHub}>
          <Link2 size={15} />
        </button>
        <button className="icon-btn" title="Archiver" onClick={props.onArchive}>
          <Archive size={15} />
        </button>
        <button className="icon-btn danger" title="Mettre à la Corbeille" onClick={props.onTrash}>
          <Trash2 size={15} />
        </button>
        </>
        )}
      </div>
    </div>
  );
}

/** Info-bulle du bouton « Ajouter à un hub… » (hub et rôle actuels, le cas échéant). */
function hubButtonTitle(config: Config, sessionId: string): string {
  const found = hubOf(config, sessionId);
  return found ? `Ajouter à un hub…\n${hubHint(found.hub, found.role)} : changer de hub ou de rôle, ou l'en retirer` : "Ajouter à un hub…";
}
