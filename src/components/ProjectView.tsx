// Vue d'un projet : en-tête (nom, couleur, catégorie, actions) et liste des conversations,
// regroupées en sections (« Sans section » en haut, puis les sections dans l'ordre choisi).

import { useEffect, useMemo, useState } from "react";
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
  FolderOpen,
  GripVertical,
  ListPlus,
  MessageSquarePlus,
  Pencil,
  Play,
  Plus,
  Search,
  GitBranch,
  GitBranchPlus,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { api, errorMessage, type Config, type ProjectInfo, type Section, type SessionInfo } from "../api";
import { colorStyle, formatDate, projectName, relativeDate } from "../util";
import {
  addSection,
  conversationColor,
  deleteSection,
  groupBySection,
  moveSection,
  putConversationInSection,
  renameSection,
  setConversationColor,
  setSectionCollapsed,
  setSectionColor,
} from "../sections";
import { ColorPicker } from "./ColorPicker";
import { useScrollToFocus, type SearchFocus } from "./GlobalSearch";
import { TextPrompt, WorktreePrompt } from "./Dialogs";
import { worktreeNameError } from "../pty";
import { ActivityDot } from "./Activity";
import { useActivities, type Activity } from "../activity";

/** Zone « Sans section » (pas une vraie section). */
const NONE = "none";

interface Props {
  project: ProjectInfo;
  config: Config;
  terminal: string;
  /** `path` : dossier où relancer (worktree), sinon celui du projet. */
  onLaunch: (sessionId?: string, path?: string) => void;
  /**
   * Nouvelle conversation dans le terminal intégré, rangée dans `sectionId` : bouton « + »
   * de l'en-tête d'une section, ou `null` (« Sans section ») pour le bouton principal.
   * `worktree` : dans un nouveau worktree, avec ce nom (vide = nom choisi par Claude Code).
   */
  onNew: (sectionId: string | null, worktree?: string) => void;
  /** Ouvre la conversation dans le terminal intégré. */
  onOpen: (s: SessionInfo) => void;
  onArchive: (s: SessionInfo) => void;
  onTrash: (s: SessionInfo) => void;
  onRename: () => void;
  onColor: (color: string | null) => void;
  onMove: (categoryId: string | null) => void;
  onForget: () => void;
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
  /** Section de la nouvelle conversation en worktree dont on demande le nom (null = « Sans section »). */
  const [worktreeFor, setWorktreeFor] = useState<{ sectionId: string | null } | null>(null);

  // ---- Sections -------------------------------------------------------------------------

  const [sectionDialog, setSectionDialog] = useState<{ kind: "new" } | { kind: "rename"; section: Section } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const groups = useMemo(() => groupBySection(config, p.key, sessions), [config, p.key, sessions]);
  const hasSections = groups.sections.length > 0;
  const filtering = query.trim().length > 0;
  const change = props.onConfigChange;

  // Un petit déplacement est nécessaire avant de commencer à glisser : les clics restent des clics.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

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
      if (o.startsWith("s:")) change((c) => moveSection(c, p.key, a.slice(2), o.slice(2)));
      return;
    }
    const target = o.startsWith("zone:") ? o.slice(5) : o.startsWith("s:") ? o.slice(2) : null;
    if (!target || !a.startsWith("v:")) return;
    const id = a.slice(2);
    const current = groups.sections.find((g) => g.section.conversationIds.includes(id))?.section.id ?? NONE;
    if (current === target) return;
    change((c) => putConversationInSection(c, p.key, target === NONE ? null : target, id));
  };

  const confirmDeleteSection = async (section: Section) => {
    const n = section.conversationIds.length;
    const ok = await ask(
      `Supprimer la section « ${section.name} » ?` + (n ? `\nSes conversations reviendront dans « Sans section ».` : ""),
      { title: "Supprimer la section", kind: "warning", okLabel: "Supprimer", cancelLabel: "Annuler" },
    );
    if (ok) change((c) => deleteSection(c, p.key, section.id));
  };

  const draggedSession = dragId?.startsWith("v:") ? p.sessions.find((s) => s.id === dragId.slice(2)) : undefined;
  const draggedSection = dragId?.startsWith("s:") ? groups.sections.find((g) => g.section.id === dragId.slice(2))?.section : undefined;

  const row = (s: SessionInfo) => (
    <SessionRow
      key={s.id}
      session={s}
      color={conversationColor(config, s.id)}
      activity={activities.get(s.id)}
      canLaunch={canResume(s)}
      onLaunch={() => props.onLaunch(s.id, resumePath(s))}
      onOpen={() => props.onOpen(s)}
      terminal={props.terminal}
      onArchive={() => props.onArchive(s)}
      onTrash={() => props.onTrash(s)}
      onColor={(c) => change((cfg) => setConversationColor(cfg, s.id, c))}
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
          title="Ouvrir dans l'Explorateur"
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
            title={"Lance « claude » dans le terminal intégré" + (hasSections ? " (rangée dans « Sans section »)" : "")}
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
        <button className="btn small" onClick={() => setSectionDialog({ kind: "new" })} title="Regrouper des conversations de ce projet">
          <ListPlus size={14} /> Section
        </button>
      </div>

      <div className="session-list">
        {sessions.length === 0 && !hasSections && (
          <div className="empty">{p.sessions.length === 0 ? "Aucune conversation dans ce projet." : "Aucune conversation ne correspond à la recherche."}</div>
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          onDragStart={(e) => setDragId(String(e.active.id))}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragId(null)}
        >
          {hasSections ? (
            <SessionZone id={NONE} className="section unsectioned">
              <div className="section-header static">
                <span className="section-name">Sans section</span>
                <span className="count">{groups.unsectioned.length}</span>
              </div>
              {groups.unsectioned.map(row)}
              {groups.unsectioned.length === 0 && <div className="empty-zone">{filtering ? "Aucun résultat" : "Déposez ici une conversation pour la sortir de sa section"}</div>}
            </SessionZone>
          ) : (
            groups.unsectioned.map(row)
          )}

          <SortableContext items={groups.sections.map((g) => "s:" + g.section.id)} strategy={verticalListSortingStrategy}>
            {groups.sections.map(({ section, sessions: list }) =>
              filtering && list.length === 0 ? null : (
                <SectionBlock
                  key={section.id}
                  section={section}
                  count={list.length}
                  onToggle={() => change((c) => setSectionCollapsed(c, p.key, section.id, !section.collapsed))}
                  onRename={() => setSectionDialog({ kind: "rename", section })}
                  onDelete={() => confirmDeleteSection(section)}
                  onColor={(color) => change((c) => setSectionColor(c, p.key, section.id, color))}
                  onNew={
                    canLaunch
                      ? () => {
                          // Section repliée : dépliée pour voir la nouvelle conversation.
                          if (section.collapsed) change((c) => setSectionCollapsed(c, p.key, section.id, false));
                          props.onNew(section.id);
                        }
                      : undefined
                  }
                  onNewWorktree={
                    canLaunch && isGit
                      ? () => {
                          if (section.collapsed) change((c) => setSectionCollapsed(c, p.key, section.id, false));
                          setWorktreeFor({ sectionId: section.id });
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

/** Zone de dépôt des conversations (« Sans section » ou corps d'une section). */
function SessionZone({ id, className, children }: { id: string; className: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "zone:" + id });
  return (
    <section ref={setNodeRef} className={className + (isOver ? " drop-over" : "")}>
      {children}
    </section>
  );
}

function SectionBlock(props: {
  section: Section;
  count: number;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
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
      style={style}
      className={"section" + (section.color ? " colored" : "") + (zone.isOver || sortable.isOver ? " drop-over" : "")}
    >
      <div className="section-header" style={colorStyle(section.color)} {...sortable.attributes} {...sortable.listeners}>
        <GripVertical size={14} className="grip" />
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
          <button className="icon-btn" title="Supprimer la section" onClick={props.onDelete}>
            <Trash2 size={13} />
          </button>
        </span>
      </div>
      <div ref={zone.setNodeRef} className="section-body">
        {!section.collapsed && props.children}
        {!section.collapsed && props.count === 0 && <div className="empty-zone">Déposez des conversations ici</div>}
      </div>
    </section>
  );
}

function SessionRow(props: {
  session: SessionInfo;
  color: string | null;
  /** État de la conversation (absent : fermée). */
  activity?: Activity;
  canLaunch: boolean;
  onLaunch: () => void;
  /** Ouvre la conversation dans le terminal intégré. */
  onOpen: () => void;
  /** Nom du terminal externe, pour l'info-bulle. */
  terminal: string;
  onArchive: () => void;
  onTrash: () => void;
  onColor: (c: string | null) => void;
}) {
  const { session: s, canLaunch } = props;
  const drag = useDraggable({ id: "v:" + s.id });
  // Les boutons ne doivent pas déclencher le glisser-déposer.
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <div
      ref={drag.setNodeRef}
      data-session-id={s.id}
      className={"session-row" + (props.color ? " colored" : "")}
      style={{ ...colorStyle(props.color), opacity: drag.isDragging ? 0.35 : 1 }}
      onClick={() => canLaunch && props.onOpen()}
      {...drag.attributes}
      {...drag.listeners}
    >
      {/* Pastille d'activité : elle garde ses propres couleurs, séparée de la couleur de
          la conversation (le fond de la ligne). */}
      <ActivityDot activity={props.activity} />
      <div className="session-main">
        <div className="session-title" title={s.firstPrompt ?? s.title}>
          {s.title}
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
