// Barre latérale : catégories (réordonnables), projets (déplaçables entre catégories),
// section « Non classés », accès aux archives.

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
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  FolderTree,
  GripVertical,
  ListPlus,
  MoreHorizontal,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { Category, Config, ProjectInfo, Section, SessionInfo } from "../api";
import { colorStyle, projectName, relativeDate } from "../util";
import { ask } from "@tauri-apps/plugin-dialog";
import { addSection, deleteSection, groupBySection, moveSection, projectSections, putConversationInSection, renameSection, setSectionCollapsed, setSectionColor } from "../sections";
import { TextPrompt } from "./Dialogs";
import { ColorPicker } from "./ColorPicker";
import { UpdateButton } from "./UpdateButton";
import { UsageLimits } from "./UsageLimits";
import { ActivityCounts, ActivityDot } from "./Activity";
import { countActivities, useActivities, type ActivityCount } from "../activity";

/** Identifiants des conversations d'une liste de projets (pour les compteurs d'activité). */
const sessionIds = (list: ProjectInfo[]) => list.flatMap((p) => p.sessions.map((s) => s.id));

/** Conteneur « Non classés » (pas une vraie catégorie). */
const NONE = "none";

export type Selection = { kind: "project"; key: string } | { kind: "archives" } | null;

interface Props {
  config: Config;
  projects: Map<string, ProjectInfo>;
  selection: Selection;
  loading: boolean;
  onSelect: (s: Selection) => void;
  onRefresh: () => void;
  onCategoriesChange: (cats: Category[]) => void;
  onAddCategory: () => void;
  onRenameCategory: (cat: Category) => void;
  onDeleteCategory: (cat: Category) => void;
  onAddProject: () => void;
  onToggleTemp: (show: boolean) => void;
  /** Recherche globale (dans le contenu de toutes les conversations). */
  onSearch?: () => void;
  searchActive?: boolean;
  /** Projet de la conversation affichée (ou, à défaut, du projet sélectionné). */
  currentProject?: ProjectInfo;
  /** Conversation dont l'onglet est affiché. */
  activeSessionId?: string | null;
  /** Ouvre une conversation dans le terminal intégré. */
  onOpenConversation: (s: SessionInfo, project: ProjectInfo) => void;
  /** Modifie la configuration (sections du projet courant). */
  onConfigChange: (change: (c: Config) => Config) => void;
  /** Nouvelle conversation dans le terminal intégré, rangée dans la section (null = « Sans section »). */
  onNewConversation: (project: ProjectInfo, sectionId: string | null) => void;
}

/** Vue de la barre latérale : liste des projets, ou conversations du projet courant. */
type SidebarView = "projects" | "conversations";

// Vue et réduction mémorisées (confort local, sans importance si perdues).
function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(v ?? "") ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible : on ignore */
  }
}

// Mémorise les catégories repliées (confort local, sans importance si perdu).
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("collapsed") ?? "[]"));
  } catch {
    return new Set();
  }
}
function saveCollapsed(s: Set<string>) {
  try {
    localStorage.setItem("collapsed", JSON.stringify([...s]));
  } catch {
    /* stockage indisponible : on ignore */
  }
}

export function Sidebar(props: Props) {
  const { config, projects } = props;
  const [dragId, setDragId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [view, setViewState] = useState<SidebarView>(() => loadPref("sidebarView", ["projects", "conversations"], "projects"));
  const [reduced, setReducedState] = useState(() => loadPref("sidebarReduced", ["0", "1"], "0") === "1");
  const setView = (v: SidebarView) => {
    setViewState(v);
    savePref("sidebarView", v);
  };
  const setReduced = (r: boolean) => {
    setReducedState(r);
    savePref("sidebarReduced", r ? "1" : "0");
  };
  // État des conversations : compteurs « en cours » et « action requise ».
  const activities = useActivities();

  // Un petit déplacement est nécessaire avant de commencer à glisser : les clics restent des clics.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  /** Catégorie contenant un projet (ou NONE). */
  const containerOf = (key: string) => config.categories.find((c) => c.projectKeys.includes(key))?.id ?? NONE;

  /** Projet archivé : il n'apparaît plus que dans les Archives. */
  const isArchived = (p: ProjectInfo) => !!config.projects[p.key]?.archived;

  /** Projets de chaque catégorie, dans l'ordre enregistré (sans les projets archivés). */
  const categoryProjects = (cat: Category) =>
    cat.projectKeys.map((k) => projects.get(k)).filter((p): p is ProjectInfo => !!p && !isArchived(p));

  /** Non classés : par activité la plus récente ; les projets temporaires sont masqués par défaut. */
  const uncategorized = useMemo(() => {
    const assigned = new Set(config.categories.flatMap((c) => c.projectKeys));
    return [...projects.values()]
      .filter((p) => !assigned.has(p.key) && !isArchived(p) && (config.showTempProjects || !p.isTemp))
      .sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
  }, [projects, config]);
  const hiddenTemp = useMemo(() => {
    const assigned = new Set(config.categories.flatMap((c) => c.projectKeys));
    return [...projects.values()].filter((p) => p.isTemp && !assigned.has(p.key) && !isArchived(p)).length;
  }, [projects, config]);

  /**
   * Détection de la cible : en glissant un projet, on vise d'abord un autre projet,
   * puis une zone de dépôt ; en glissant une catégorie, uniquement les catégories.
   */
  const collision: CollisionDetection = (args) => {
    const active = String(args.active.id);
    if (active.startsWith("c:")) {
      const cats = args.droppableContainers.filter((c) => String(c.id).startsWith("c:"));
      return closestCenter({ ...args, droppableContainers: cats });
    }
    const hits = pointerWithin(args);
    for (const prefix of ["p:", "zone:", "c:"]) {
      const hit = hits.filter((h) => String(h.id).startsWith(prefix));
      if (hit.length) return hit;
    }
    return [];
  };

  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragId(null);
    if (!over) return;
    const a = String(active.id);
    const o = String(over.id);
    const cats = config.categories.map((c) => ({ ...c, projectKeys: [...c.projectKeys] }));

    // Réordonner les catégories.
    if (a.startsWith("c:")) {
      const from = cats.findIndex((c) => "c:" + c.id === a);
      const to = cats.findIndex((c) => "c:" + c.id === o);
      if (from >= 0 && to >= 0 && from !== to) props.onCategoriesChange(arrayMove(cats, from, to));
      return;
    }

    // Déplacer un projet.
    const key = a.slice(2);
    const source = containerOf(key);
    let target: string;
    let overKey: string | null = null;
    if (o.startsWith("p:")) {
      overKey = o.slice(2);
      target = containerOf(overKey);
    } else if (o.startsWith("zone:")) {
      target = o.slice(5);
    } else if (o.startsWith("c:")) {
      target = o.slice(2);
    } else return;

    if (source === target) {
      // Réordonner dans la même catégorie (« Non classés » est triée automatiquement).
      if (target === NONE || !overKey || overKey === key) return;
      const cat = cats.find((c) => c.id === target)!;
      const from = cat.projectKeys.indexOf(key);
      const to = cat.projectKeys.indexOf(overKey);
      cat.projectKeys = arrayMove(cat.projectKeys, from, to);
    } else {
      // Retirer de la source, insérer dans la cible (à la place du projet survolé, sinon à la fin).
      for (const c of cats) c.projectKeys = c.projectKeys.filter((k) => k !== key);
      const cat = cats.find((c) => c.id === target);
      if (cat) {
        const idx = overKey ? cat.projectKeys.indexOf(overKey) : -1;
        if (idx >= 0) cat.projectKeys.splice(idx, 0, key);
        else cat.projectKeys.push(key);
      }
    }
    props.onCategoriesChange(cats);
  };

  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollapsed(next);
      return next;
    });
  };

  const draggedProject = dragId?.startsWith("p:") ? projects.get(dragId.slice(2)) : undefined;
  const draggedCategory = dragId?.startsWith("c:") ? config.categories.find((c) => "c:" + c.id === dragId) : undefined;
  const selectedKey = props.selection?.kind === "project" && !props.searchActive ? props.selection.key : null;

  const row = (p: ProjectInfo, container: string) => (
    <ProjectRow
      key={p.key}
      project={p}
      container={container}
      name={projectName(p, config)}
      color={config.projects[p.key]?.color}
      selected={selectedKey === p.key}
      activity={countActivities(activities, sessionIds([p]))}
      onClick={() => props.onSelect({ kind: "project", key: p.key })}
    />
  );

  return (
    <aside className={"sidebar" + (reduced ? " reduced" : "")}>
      {reduced ? (
        <div className="sidebar-rail">
          <button className="icon-btn" title="Agrandir la barre latérale" onClick={() => setReduced(false)}>
            <PanelLeftOpen size={17} />
          </button>
          <button
            className={"icon-btn" + (view === "projects" ? " on" : "")}
            title="Projets"
            onClick={() => {
              setView("projects");
              setReduced(false);
            }}
          >
            <FolderTree size={17} />
          </button>
          <button
            className={"icon-btn" + (view === "conversations" ? " on" : "")}
            title="Conversations du projet courant"
            onClick={() => {
              setView("conversations");
              setReduced(false);
            }}
          >
            <MessagesSquare size={17} />
          </button>
        </div>
      ) : (
        <>
          <div className="sidebar-header">
            <h1>Claude Manager</h1>
            <span className="sidebar-header-actions">
              <button className="icon-btn" title="Ajouter un projet" onClick={props.onAddProject}>
                <FolderPlus size={16} />
              </button>
              <button className="icon-btn" title="Rafraîchir" onClick={props.onRefresh} disabled={props.loading}>
                <RefreshCw size={16} className={props.loading ? "spin" : ""} />
              </button>
              <MoreMenu>
                <button
                  className={"nav-item" + (props.selection?.kind === "archives" && !props.searchActive ? " selected" : "")}
                  onClick={() => props.onSelect({ kind: "archives" })}
                >
                  <Archive size={15} /> Archives <span className="count">{config.archives.length}</span>
                </button>
                {view === "projects" && (hiddenTemp > 0 || config.showTempProjects) && (
                  <label className="checkbox small" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={config.showTempProjects} onChange={(e) => props.onToggleTemp(e.target.checked)} />
                    Afficher les projets temporaires ({hiddenTemp})
                  </label>
                )}
              </MoreMenu>
              <button className="icon-btn" title="Réduire la barre latérale" onClick={() => setReduced(true)}>
                <PanelLeftClose size={16} />
              </button>
            </span>
          </div>
          <div className="sidebar-views" role="tablist">
            <button role="tab" aria-selected={view === "projects"} className={"sidebar-view" + (view === "projects" ? " active" : "")} onClick={() => setView("projects")}>
              <FolderTree size={14} /> Projets
            </button>
            <button
              role="tab"
              aria-selected={view === "conversations"}
              className={"sidebar-view" + (view === "conversations" ? " active" : "")}
              onClick={() => setView("conversations")}
              title="Conversations du projet courant"
            >
              <MessagesSquare size={14} /> Conversations
            </button>
          </div>
        </>
      )}
      {!reduced && view === "conversations" && (
        <ConversationsPanel
          config={config}
          project={props.currentProject}
          activeSessionId={props.activeSessionId ?? null}
          activities={activities}
          onOpen={props.onOpenConversation}
          onConfigChange={props.onConfigChange}
          onNew={props.onNewConversation}
        />
      )}
      {!reduced && view === "projects" && (
        <>
      <div className="sidebar-toolbar">
        <button className="btn small" onClick={props.onAddCategory}>
          <Plus size={14} /> Catégorie
        </button>
      </div>

      <div className="sidebar-scroll">
        <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
          <SortableContext items={config.categories.map((c) => "c:" + c.id)} strategy={verticalListSortingStrategy}>
            {config.categories.map((cat) => {
              const list = categoryProjects(cat);
              return (
                <CategoryBlock
                  key={cat.id}
                  category={cat}
                  count={list.length}
                  activity={countActivities(activities, sessionIds(list))}
                  collapsed={collapsed.has(cat.id)}
                  onToggle={() => toggleCollapsed(cat.id)}
                  onRename={() => props.onRenameCategory(cat)}
                  onDelete={() => props.onDeleteCategory(cat)}
                  onColor={(color) =>
                    props.onCategoriesChange(config.categories.map((c) => (c.id === cat.id ? { ...c, color } : c)))
                  }
                >
                  <SortableContext items={list.map((p) => "p:" + p.key)} strategy={verticalListSortingStrategy}>
                    {list.map((p) => row(p, cat.id))}
                  </SortableContext>
                </CategoryBlock>
              );
            })}
          </SortableContext>

          <Zone id={NONE} className="category uncategorized">
            <div className="category-header static">
              <span className="category-name">Non classés</span>
              <ActivityCounts {...countActivities(activities, sessionIds(uncategorized))} />
              <span className="count">{uncategorized.length}</span>
            </div>
            <SortableContext items={uncategorized.map((p) => "p:" + p.key)} strategy={verticalListSortingStrategy}>
              {uncategorized.map((p) => row(p, NONE))}
            </SortableContext>
            {uncategorized.length === 0 && <div className="empty-zone">Aucun projet</div>}
          </Zone>

          <DragOverlay dropAnimation={null}>
            {draggedProject && (
              <div className="project-row overlay" style={colorStyle(config.projects[draggedProject.key]?.color)}>
                {projectName(draggedProject, config)}
              </div>
            )}
            {draggedCategory && (
              <div className="category overlay" style={colorStyle(draggedCategory.color)}>
                <div className="category-header">{draggedCategory.name}</div>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>

        </>
      )}

      {!reduced && (
      <div className="sidebar-footer">
        {props.onSearch && (
          <button
            className={"nav-item" + (props.searchActive ? " selected" : "")}
            onClick={props.onSearch}
            title="Chercher dans le contenu de toutes les conversations (Ctrl+Maj+F)"
          >
            <Search size={15} /> Rechercher partout
          </button>
        )}
        <UsageLimits />
        <UpdateButton />
      </div>
      )}
    </aside>
  );
}

/** Menu « … » de l'en-tête : options rarement utilisées. */
function MoreMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
  return (
    <div className="color-picker" ref={ref}>
      <button className="icon-btn" title="Plus" onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="popover menu more-menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Conversations du projet courant, rangées par section (la plus récente d'abord). */
function ConversationsPanel(props: {
  config: Config;
  project?: ProjectInfo;
  activeSessionId: string | null;
  activities: ReadonlyMap<string, import("../activity").Activity>;
  onOpen: (s: SessionInfo, project: ProjectInfo) => void;
  /** Nouvelle conversation dans le terminal intégré, rangée dans la section (null = « Sans section »). */
  onNew: (project: ProjectInfo, sectionId: string | null) => void;
  onConfigChange: (change: (c: Config) => Config) => void;
}) {
  const { project, config } = props;
  const [dialog, setDialog] = useState<{ kind: "new" } | { kind: "rename"; section: Section } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  // Un petit déplacement est nécessaire avant de commencer à glisser : les clics restent des clics.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  if (!project) return <div className="sidebar-scroll"><div className="empty-zone">Aucun projet courant</div></div>;
  const list = [...project.sessions].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const groups = groupBySection(config, project.key, list);
  const hasSections = groups.sections.length > 0;
  const change = props.onConfigChange;

  const confirmDelete = async (section: Section) => {
    const ok = await ask(`Supprimer la section « ${section.name} » ?\nSes conversations reviendront dans « Sans section ».`, {
      title: "Supprimer la section",
      kind: "warning",
      okLabel: "Supprimer",
      cancelLabel: "Annuler",
    });
    if (ok) change((c) => deleteSection(c, project.key, section.id));
  };

  /**
   * Détection de la cible : une section glissée vise les autres sections ; une conversation
   * glissée vise une zone de dépôt (corps d'une section ou « Sans section »), sinon un en-tête.
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
      if (o.startsWith("s:")) change((c) => moveSection(c, project.key, a.slice(2), o.slice(2)));
      return;
    }
    const target = o.startsWith("zone:") ? o.slice(5) : o.startsWith("s:") ? o.slice(2) : null;
    if (!target || !a.startsWith("v:")) return;
    const id = a.slice(2);
    const current = groups.sections.find((g) => g.section.conversationIds.includes(id))?.section.id ?? NONE;
    if (current === target) return;
    change((c) => {
      const next = putConversationInSection(c, project.key, target === NONE ? null : target, id);
      const sec = projectSections(next, project.key).find((s) => s.id === target);
      // Section repliée : dépliée pour voir la conversation arriver.
      return sec?.collapsed ? setSectionCollapsed(next, project.key, sec.id, false) : next;
    });
  };

  const convRow = (s: SessionInfo) => (
    <ConversationRow
      key={s.id}
      session={s}
      color={config.conversations[s.id]?.color}
      selected={props.activeSessionId === s.id}
      activity={props.activities.get(s.id)}
      onClick={() => props.onOpen(s, project)}
    />
  );

  const draggedSession = dragId?.startsWith("v:") ? list.find((s) => s.id === dragId.slice(2)) : undefined;
  const draggedSection = dragId?.startsWith("s:") ? groups.sections.find((g) => g.section.id === dragId.slice(2))?.section : undefined;

  const projectColor = config.projects[project.key]?.color;
  return (
    <>
      <div className="sidebar-project-title" style={colorStyle(projectColor)} title={project.path ?? project.key}>
        <span className="project-name">{projectName(project, config)}</span>
        <span className="count">{list.length}</span>
      </div>
      <div className="sidebar-toolbar">
        <button className="btn small" onClick={() => setDialog({ kind: "new" })} title="Regrouper des conversations de ce projet">
          <ListPlus size={14} /> Section
        </button>
        <button
          className="btn small"
          disabled={!project.path}
          onClick={() => props.onNew(project, null)}
          title="Nouvelle conversation dans le terminal intégré"
        >
          <Plus size={14} /> Conversation
        </button>
      </div>
      <div className="sidebar-scroll">
        {list.length === 0 && <div className="empty-zone">Aucune conversation</div>}
        <DndContext sensors={sensors} collisionDetection={collision} onDragStart={(e) => setDragId(String(e.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
          {hasSections ? (
            <Zone id={NONE} className="category unsectioned">
              <div className="category-header static">
                <span className="category-name">Sans section</span>
                <span className="count">{groups.unsectioned.length}</span>
              </div>
              <div className="category-body">
                {groups.unsectioned.map(convRow)}
                {groups.unsectioned.length === 0 && <div className="empty-zone">Déposez ici pour sortir d'une section</div>}
              </div>
            </Zone>
          ) : (
            groups.unsectioned.map(convRow)
          )}
          <SortableContext items={groups.sections.map((g) => "s:" + g.section.id)} strategy={verticalListSortingStrategy}>
            {groups.sections.map(({ section, sessions }) => (
              <SectionBlock
                key={section.id}
                section={section}
                count={sessions.length}
                onToggle={() => change((c) => setSectionCollapsed(c, project.key, section.id, !section.collapsed))}
                onRename={() => setDialog({ kind: "rename", section })}
                onDelete={() => confirmDelete(section)}
                onColor={(color) => change((c) => setSectionColor(c, project.key, section.id, color))}
                onNew={
                  project.path
                    ? () => {
                        if (section.collapsed) change((c) => setSectionCollapsed(c, project.key, section.id, false));
                        props.onNew(project, section.id);
                      }
                    : undefined
                }
              >
                {sessions.map(convRow)}
              </SectionBlock>
            ))}
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {draggedSession && (
              <div className="project-row overlay" style={colorStyle(config.conversations[draggedSession.id]?.color)}>
                {draggedSession.title}
              </div>
            )}
            {draggedSection && (
              <div className="category overlay" style={colorStyle(draggedSection.color)}>
                <div className="category-header">{draggedSection.name}</div>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>
      {dialog?.kind === "new" && (
        <TextPrompt
          title="Nouvelle section"
          label="Nom"
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            change((c) => addSection(c, project.key, name));
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <TextPrompt
          title="Renommer la section"
          label="Nom"
          initial={dialog.section.name}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            change((c) => renameSection(c, project.key, dialog.section.id, name));
            setDialog(null);
          }}
        />
      )}
    </>
  );
}

/** Conversation de la liste (glissable vers une section). */
function ConversationRow(props: {
  session: SessionInfo;
  color?: string | null;
  selected: boolean;
  activity?: import("../activity").Activity;
  onClick: () => void;
}) {
  const { session: s } = props;
  const drag = useDraggable({ id: "v:" + s.id });
  return (
    <div
      ref={drag.setNodeRef}
      className={"project-row conv-row" + (props.selected ? " selected" : "") + (props.color ? " colored" : "")}
      style={{ ...colorStyle(props.color), opacity: drag.isDragging ? 0.35 : 1 }}
      title={s.firstPrompt ?? s.title}
      onClick={props.onClick}
      {...drag.attributes}
      {...drag.listeners}
    >
      <ActivityDot activity={props.activity} />
      <span className="project-name">{s.title}</span>
      <span className="project-meta">{s.provisional ? "nouveau" : relativeDate(s.updatedAt)}</span>
    </div>
  );
}

/** Section réordonnable, qui reçoit des conversations. */
function SectionBlock(props: {
  section: Section;
  count: number;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
  onColor: (c: string | null) => void;
  onNew?: () => void;
  children: React.ReactNode;
}) {
  const { section } = props;
  const sortable = useSortable({ id: "s:" + section.id });
  const zone = useDroppable({ id: "zone:" + section.id });
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : 1,
    ...colorStyle(section.color),
  };
  // Les boutons ne doivent pas déclencher le glisser-déposer.
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <section
      ref={sortable.setNodeRef}
      style={style}
      className={"category" + (section.color ? " colored" : "") + (zone.isOver || sortable.isOver ? " drop-over" : "")}
    >
      <div className="category-header" {...sortable.attributes} {...sortable.listeners}>
        <GripVertical size={14} className="grip" />
        <button className="icon-btn bare" onPointerDown={stop} onClick={props.onToggle} title={section.collapsed ? "Déplier" : "Replier"}>
          {section.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span className="category-name" onDoubleClick={props.onRename}>
          {section.name}
        </span>
        <span className="count">{props.count}</span>
        <span className="hover-actions" onPointerDown={stop}>
          {props.onNew && (
            <button className="icon-btn" title="Nouvelle conversation dans cette section (terminal intégré)" onClick={props.onNew}>
              <Plus size={13} />
            </button>
          )}
          <button className="icon-btn" title="Renommer" onClick={props.onRename}>
            <Pencil size={13} />
          </button>
          <ColorPicker compact value={section.color} onChange={props.onColor} title="Couleur de la section" />
          <button className="icon-btn" title="Supprimer la section" onClick={props.onDelete}>
            <Trash2 size={13} />
          </button>
        </span>
      </div>
      <div ref={zone.setNodeRef} className="category-body">
        {!section.collapsed && props.children}
        {!section.collapsed && props.count === 0 && <div className="empty-zone">Déposez des conversations ici</div>}
      </div>
    </section>
  );
}

/** Zone de dépôt (liste de projets d'une catégorie). */
function Zone({ id, className, children }: { id: string; className: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "zone:" + id });
  return (
    <section ref={setNodeRef} className={className + (isOver ? " drop-over" : "")}>
      {children}
    </section>
  );
}

function CategoryBlock(props: {
  category: Category;
  count: number;
  /** Conversations en cours / en attente de réponse dans la catégorie. */
  activity: ActivityCount;
  collapsed: boolean;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
  onColor: (c: string | null) => void;
  children: React.ReactNode;
}) {
  const { category: cat } = props;
  const sortable = useSortable({ id: "c:" + cat.id });
  const zone = useDroppable({ id: "zone:" + cat.id });
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : 1,
    ...colorStyle(cat.color),
  };
  // Les boutons ne doivent pas déclencher le glisser-déposer.
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <section ref={sortable.setNodeRef} style={style} className={"category" + (cat.color ? " colored" : "") + (zone.isOver ? " drop-over" : "")}>
      <div className="category-header" {...sortable.attributes} {...sortable.listeners}>
        <GripVertical size={14} className="grip" />
        <button className="icon-btn bare" onPointerDown={stop} onClick={props.onToggle} title={props.collapsed ? "Déplier" : "Replier"}>
          {props.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span className="category-name" onDoubleClick={props.onRename}>
          {cat.name}
        </span>
        <ActivityCounts {...props.activity} />
        <span className="count">{props.count}</span>
        <span className="hover-actions" onPointerDown={stop}>
          <button className="icon-btn" title="Renommer" onClick={props.onRename}>
            <Pencil size={13} />
          </button>
          <ColorPicker compact value={cat.color} onChange={props.onColor} title="Couleur de la catégorie" />
          <button className="icon-btn" title="Supprimer la catégorie" onClick={props.onDelete}>
            <Trash2 size={13} />
          </button>
        </span>
      </div>
      <div ref={zone.setNodeRef} className="category-body">
        {!props.collapsed && props.children}
        {!props.collapsed && props.count === 0 && <div className="empty-zone">Déposez des projets ici</div>}
      </div>
    </section>
  );
}

function ProjectRow(props: {
  project: ProjectInfo;
  container: string;
  name: string;
  color?: string | null;
  selected: boolean;
  /** Conversations en cours / en attente de réponse dans le projet. */
  activity: ActivityCount;
  onClick: () => void;
}) {
  const { project: p } = props;
  const s = useSortable({ id: "p:" + p.key, data: { container: props.container } });
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(s.transform),
    transition: s.transition,
    opacity: s.isDragging ? 0.35 : 1,
    ...colorStyle(props.color),
  };
  return (
    <div
      ref={s.setNodeRef}
      style={style}
      className={"project-row" + (props.selected ? " selected" : "") + (props.color ? " colored" : "")}
      onClick={props.onClick}
      title={p.path ?? p.key}
      {...s.attributes}
      {...s.listeners}
    >
      <span className="project-name">{props.name}</span>
      {!p.exists && <TriangleAlert size={13} className="warn" aria-label="Dossier introuvable" />}
      <ActivityCounts {...props.activity} />
      <span className="project-meta">
        {p.sessions.length > 0 ? `${p.sessions.length} · ${relativeDate(p.lastActivity)}` : "vide"}
      </span>
    </div>
  );
}
