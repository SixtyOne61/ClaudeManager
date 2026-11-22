// Barre latérale : catégories (réordonnables), projets (déplaçables entre catégories),
// section « Non classés », accès aux archives.

import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
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
  GripVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { Category, Config, ProjectInfo } from "../api";
import { colorStyle, projectName, relativeDate } from "../util";
import { ColorPicker } from "./ColorPicker";
import { UpdateButton } from "./UpdateButton";
import { UsageLimits } from "./UsageLimits";
import { ActivityCounts } from "./Activity";
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
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>Claude Manager</h1>
        <button className="icon-btn" title="Rafraîchir" onClick={props.onRefresh} disabled={props.loading}>
          <RefreshCw size={16} className={props.loading ? "spin" : ""} />
        </button>
      </div>
      <div className="sidebar-toolbar">
        <button className="btn small" onClick={props.onAddCategory}>
          <Plus size={14} /> Catégorie
        </button>
        <button className="btn small" onClick={props.onAddProject}>
          <FolderPlus size={14} /> Projet
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
        <button
          className={"nav-item" + (props.selection?.kind === "archives" && !props.searchActive ? " selected" : "")}
          onClick={() => props.onSelect({ kind: "archives" })}
        >
          <Archive size={15} /> Archives <span className="count">{config.archives.length}</span>
        </button>
        {(hiddenTemp > 0 || config.showTempProjects) && (
          <label className="checkbox small">
            <input type="checkbox" checked={config.showTempProjects} onChange={(e) => props.onToggleTemp(e.target.checked)} />
            Afficher les projets temporaires ({hiddenTemp})
          </label>
        )}
        <UsageLimits />
        <UpdateButton />
      </div>
    </aside>
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
