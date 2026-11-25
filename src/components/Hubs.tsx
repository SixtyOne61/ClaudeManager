// Hubs dans l'interface (voir src/hubs.ts) : onglet « Hubs » de la barre latérale, icône 🔗
// d'une conversation membre, fenêtres « Ajouter à un hub… » et « + Exécutant ».

import { useEffect, useState } from "react";
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { Archive, ChevronDown, ChevronRight, Pencil, Plus, Trash2, UserPlus, X } from "lucide-react";
import { api, type ArchiveEntry, type Config, type Hub, type HubMember, type HubRole, type ProjectInfo, type SessionInfo } from "../api";
import { colorStyle, projectName } from "../util";
import { countActivities, type Activity } from "../activity";
import { hasSuggestion, useSuggestions } from "../suggestions";
import { HUB_ROLES, activeHubs, coordinatorOf, executorBlocker, hubHint, hubOf, roleLabel, sortedMembers } from "../hubs";
import { messagesApi } from "../messages";
import { ActivityCounts, ActivityDot } from "./Activity";
import { ColorPicker } from "./ColorPicker";
import { ConversationSuggestionIcon, SuggestionIcon } from "./Suggestions";
import { Modal } from "./Dialogs";

/** Préfixe des zones de dépôt des hubs (glisser un membre sur un autre hub). */
export const HUB_DROP_PREFIX = "hub:";

/** Icône 🔗 d'une conversation membre d'un hub (info-bulle : nom du hub et rôle) ; rien sinon. */
export function HubLinkIcon({ config, sessionId }: { config: Config; sessionId: string }) {
  const found = hubOf(config, sessionId);
  if (!found) return null;
  const hint = hubHint(found.hub, found.role);
  return (
    <span className="hub-link-icon" title={hint} aria-label={hint} role="img">
      🔗
    </span>
  );
}

/** Actions sur les hubs, fournies par App.tsx. */
export interface HubActions {
  /** Ouvre une conversation par son identifiant (onglet, ou archives). */
  onOpenConversation: (sessionId: string) => void;
  /**
   * Clic sur le nom d'un hub : ouvre la « Vue Hub » dans la zone principale. Absent : le clic
   * déplie ou replie le hub.
   */
  onOpenHub?: (hubId: string) => void;
  onRename: (hub: Hub) => void;
  onColor: (hub: Hub, color: string | null) => void;
  /** Archive le hub et toutes ses conversations. */
  onArchive: (hub: Hub) => void;
  /** Supprime le regroupement seulement. */
  onDelete: (hub: Hub) => void;
  onSetRole: (hub: Hub, sessionId: string, role: HubRole) => void;
  onRemoveMember: (hub: Hub, sessionId: string) => void;
  /** « + Exécutant » : lance une nouvelle conversation exécutante (hub avec coordinateur). */
  onAddExecutor?: (hub: Hub) => void;
}

/** Conversation d'un membre : dans un projet, ou dans les archives. */
type MemberInfo = { session: SessionInfo; project: ProjectInfo; archived: null } | { session: null; project: null; archived: ArchiveEntry | null };

export function memberInfo(config: Config, projects: Map<string, ProjectInfo>, id: string): MemberInfo {
  for (const p of projects.values()) {
    const s = p.sessions.find((x) => x.id === id);
    if (s) return { session: s, project: p, archived: null };
  }
  return { session: null, project: null, archived: config.archives.find((a) => a.sessionId === id) ?? null };
}

/**
 * Onglet « Hubs » de la barre latérale : bouton « + Hub » et liste des hubs, chacun dépliable
 * sur ses membres. Un membre se glisse d'un hub à l'autre (zones de dépôt `hub:<id>`).
 */
export function HubsPanel(props: {
  config: Config;
  projects: Map<string, ProjectInfo>;
  activities: ReadonlyMap<string, Activity>;
  activeSessionId: string | null;
  /** Hub affiché dans la zone principale. */
  selectedHubId: string | null;
  /** Identifiants repliés (hubs : `hub:<id>`). */
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  actions: HubActions;
  onAddHub: () => void;
  /** Membre déposé sur un autre hub. */
  onDropOnHub: (hubId: string, sessionId: string) => void;
}) {
  const hubs = activeHubs(props.config);
  const [dragId, setDragId] = useState<string | null>(null);
  // Un petit déplacement est nécessaire avant de commencer à glisser : les clics restent des clics.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragId(null);
    const o = over ? String(over.id) : "";
    if (o.startsWith(HUB_DROP_PREFIX)) props.onDropOnHub(o.slice(HUB_DROP_PREFIX.length), String(active.id).slice(MEMBER_DRAG_PREFIX.length));
  };
  const dragged = dragId ? dragId.slice(MEMBER_DRAG_PREFIX.length) : null;
  const draggedTitle = dragged ? (memberInfo(props.config, props.projects, dragged).session?.title ?? "") : "";
  return (
    <>
      <div className="sidebar-toolbar">
        <button className="btn small" onClick={props.onAddHub} title="Regrouper des conversations qui travaillent ensemble, même de projets différents">
          <Plus size={14} /> Hub
        </button>
      </div>
      <div className="sidebar-scroll">
        {hubs.length === 0 && (
          <div className="empty-zone">Aucun hub. Créez-en un, ou « Ajouter à un hub… » sur une conversation.</div>
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={(e) => setDragId(String(e.active.id))}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragId(null)}
        >
          <div className="hubs-block">
            {hubs.map((hub) => (
              <HubBlock
                key={hub.id}
                config={props.config}
                projects={props.projects}
                activities={props.activities}
                activeSessionId={props.activeSessionId}
                actions={props.actions}
                hub={hub}
                selected={props.selectedHubId === hub.id}
                collapsed={props.collapsed.has(HUB_DROP_PREFIX + hub.id)}
                onToggle={() => props.onToggle(HUB_DROP_PREFIX + hub.id)}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>{dragged && <div className="project-row overlay">{draggedTitle}</div>}</DragOverlay>
        </DndContext>
      </div>
    </>
  );
}

/** Préfixe des membres glissés (`m:<identifiant de conversation>`). */
const MEMBER_DRAG_PREFIX = "m:";

function HubBlock(props: {
  config: Config;
  projects: Map<string, ProjectInfo>;
  activities: ReadonlyMap<string, Activity>;
  activeSessionId: string | null;
  hub: Hub;
  selected: boolean;
  collapsed: boolean;
  onToggle: () => void;
  actions: HubActions;
}) {
  const { hub, actions } = props;
  const zone = useDroppable({ id: HUB_DROP_PREFIX + hub.id });
  const suggestions = useSuggestions();
  const ids = hub.members.map((m) => m.conversationId);
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <section
      ref={zone.setNodeRef}
      className={"category hub" + (hub.color ? " colored" : "") + (zone.isOver ? " drop-over" : "")}
      style={colorStyle(hub.color)}
    >
      <div className={"category-header hub-header" + (props.selected ? " selected" : "")}>
        <button className="icon-btn bare" onPointerDown={stop} onClick={props.onToggle} title={props.collapsed ? "Déplier" : "Replier"}>
          {props.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span className="hub-link-icon" aria-hidden>
          🔗
        </span>
        <span
          className="category-name hub-name"
          title={actions.onOpenHub ? `Ouvrir le hub « ${hub.name} »` : hub.name}
          onClick={() => (actions.onOpenHub ? actions.onOpenHub(hub.id) : props.onToggle())}
          onDoubleClick={() => actions.onRename(hub)}
        >
          {hub.name}
        </span>
        {hasSuggestion(suggestions, ids) && <SuggestionIcon title="Une conversation a une suggestion" />}
        <ActivityCounts {...countActivities(props.activities, ids)} />
        <span className="count">{hub.members.length}</span>
        <span className="hover-actions" onPointerDown={stop}>
          <HubHeaderActions hub={hub} actions={actions} compact />
        </span>
      </div>
      {!props.collapsed && (
        <div className="category-body">
          {sortedMembers(hub).map((m) => (
            <HubMemberRow key={m.conversationId} {...props} member={m} />
          ))}
          {hub.members.length === 0 && <div className="empty-zone">« Ajouter à un hub… » sur une conversation, ou glissez ici le membre d'un autre hub</div>}
        </div>
      )}
    </section>
  );
}

/** Membre d'un hub dans la barre latérale (glissable vers un autre hub). */
function HubMemberRow(props: {
  config: Config;
  projects: Map<string, ProjectInfo>;
  activities: ReadonlyMap<string, Activity>;
  activeSessionId: string | null;
  hub: Hub;
  member: HubMember;
  actions: HubActions;
}) {
  const { hub, member: m, actions } = props;
  const drag = useDraggable({ id: MEMBER_DRAG_PREFIX + m.conversationId });
  const info = memberInfo(props.config, props.projects, m.conversationId);
  const title = info.session?.title ?? info.archived?.title ?? "Conversation introuvable";
  const where = info.project ? projectName(info.project, props.config) : info.archived ? "archivée" : "";
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <div
      ref={drag.setNodeRef}
      className={"project-row conv-row hub-member" + (props.activeSessionId === m.conversationId ? " selected" : "") + (info.session ? "" : " gone")}
      style={{ opacity: drag.isDragging ? 0.35 : 1 }}
      title={info.session?.firstPrompt ?? title}
      onClick={() => actions.onOpenConversation(m.conversationId)}
      {...drag.attributes}
      {...drag.listeners}
    >
      <ActivityDot activity={props.activities.get(m.conversationId)} />
      <span className="hub-member-main">
        <span className="project-name">{title}</span>
        {where && <span className="hub-member-project">{where}</span>}
      </span>
      <ConversationSuggestionIcon sessionId={m.conversationId} />
      <span className={"hub-role role-" + m.role}>{roleLabel(m.role)}</span>
      <span className="hub-member-actions" onPointerDown={stop} onClick={(e) => e.stopPropagation()}>
        <HubMemberControls hub={hub} member={m} actions={actions} />
      </span>
    </div>
  );
}

/** Choix du rôle et « Retirer du hub » d'un membre. */
export function HubMemberControls({ hub, member: m, actions }: { hub: Hub; member: HubMember; actions: HubActions }) {
  return (
    <>
      <select
        className="hub-role-select"
        value={m.role}
        title="Rôle dans le hub"
        onChange={(e) => actions.onSetRole(hub, m.conversationId, e.target.value as HubRole)}
      >
        {HUB_ROLES.map((r) => (
          <option key={r} value={r}>
            {roleLabel(r)}
          </option>
        ))}
      </select>
      <button className="icon-btn" title="Retirer du hub" onClick={() => actions.onRemoveMember(hub, m.conversationId)}>
        <X size={13} />
      </button>
    </>
  );
}

/** Actions d'un hub : « + Exécutant », renommer, couleur, archiver, supprimer. */
export function HubHeaderActions({ hub, actions, compact }: { hub: Hub; actions: HubActions; compact?: boolean }) {
  const size = compact ? 13 : 15;
  return (
    <>
      {actions.onAddExecutor && <AddExecutorButton hub={hub} onClick={() => actions.onAddExecutor?.(hub)} compact={compact} />}
      <button className="icon-btn" title="Renommer" onClick={() => actions.onRename(hub)}>
        <Pencil size={size} />
      </button>
      <ColorPicker compact={compact} value={hub.color} onChange={(c) => actions.onColor(hub, c)} title="Couleur du hub" />
      <button className="icon-btn" title="Archiver le hub et ses conversations" onClick={() => actions.onArchive(hub)}>
        <Archive size={size} />
      </button>
      <button className="icon-btn" title="Supprimer le hub (les conversations restent dans leur projet)" onClick={() => actions.onDelete(hub)}>
        <Trash2 size={size} />
      </button>
    </>
  );
}

/** Choix de la fenêtre « Ajouter à un hub… » : un hub existant, ou un nouveau hub à créer. */
export type HubChoice = { hubId: string; role: HubRole } | { newHubName: string; role: HubRole };

const NEW_HUB = "__new";

/**
 * « Ajouter à un hub… » : choix du hub (ou d'un nouveau) et du rôle. Pour une conversation
 * déjà membre, permet de changer de hub ou de rôle, ou de la retirer.
 */
export function HubDialog(props: {
  config: Config;
  sessionId: string;
  title: string;
  /** Titre d'une conversation (pour nommer le coordinateur rétrogradé). */
  titleOf: (id: string) => string;
  onSubmit: (choice: HubChoice) => void;
  onRemove: (hub: Hub) => void;
  onClose: () => void;
}) {
  const hubs = activeHubs(props.config);
  const current = hubOf(props.config, props.sessionId);
  const [hubId, setHubId] = useState<string>(current && !current.hub.archived ? current.hub.id : (hubs[0]?.id ?? NEW_HUB));
  const [name, setName] = useState("");
  const target = hubs.find((h) => h.id === hubId) ?? null;
  const initialRole = (h: Hub | null): HubRole =>
    h && current?.hub.id === h.id ? current.role : h && coordinatorOf(h) ? "executant" : "pair";
  const [role, setRole] = useState<HubRole>(() => initialRole(target));
  const isNew = hubId === NEW_HUB;
  const valid = isNew ? name.trim().length > 0 : !!target;
  const coordinator = target ? coordinatorOf(target) : null;
  const demoted = role === "coordinateur" && coordinator && coordinator.conversationId !== props.sessionId ? coordinator : null;
  const unchanged = !!target && current?.hub.id === target.id && current.role === role;

  return (
    <Modal title="Ajouter à un hub" onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || unchanged) return;
          props.onSubmit(isNew ? { newHubName: name.trim(), role } : { hubId, role });
        }}
      >
        <p className="muted hub-dialog-conv">
          Conversation : <strong>{props.title}</strong>
        </p>
        <label className="field">
          <span>Hub</span>
          <select
            value={hubId}
            onChange={(e) => {
              setHubId(e.target.value);
              setRole(initialRole(hubs.find((h) => h.id === e.target.value) ?? null));
            }}
            autoFocus
          >
            {hubs.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} ({h.members.length})
              </option>
            ))}
            <option value={NEW_HUB}>Nouveau hub…</option>
          </select>
        </label>
        {isNew && (
          <label className="field">
            <span>Nom du nouveau hub</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
        )}
        <div className="field">
          <span>Rôle</span>
          {HUB_ROLES.map((r) => (
            <label key={r} className="checkbox">
              <input type="radio" name="hub-role" checked={role === r} onChange={() => setRole(r)} />
              {roleLabel(r)}
              <small>
                {r === "coordinateur"
                  ? "répartit le travail et reçoit les comptes rendus (un seul par hub)"
                  : r === "executant"
                    ? "réalise une tâche confiée par le coordinateur"
                    : "membre d'un hub sans coordinateur"}
              </small>
            </label>
          ))}
          {demoted && <small>« {props.titleOf(demoted.conversationId)} » deviendra exécutant.</small>}
          {current && !current.hub.archived && target && current.hub.id !== target.id && <small>Elle quittera le hub « {current.hub.name} ».</small>}
          {current && isNew && <small>Elle quittera le hub « {current.hub.name} ».</small>}
        </div>
        <div className="modal-actions">
          {current && (
            <button type="button" className="btn ghost danger hub-dialog-remove" onClick={() => props.onRemove(current.hub)}>
              Retirer du hub « {current.hub.name} »
            </button>
          )}
          <button type="button" className="btn ghost" onClick={props.onClose}>
            Annuler
          </button>
          <button type="submit" className="btn primary" disabled={!valid || unchanged}>
            {current ? "Valider" : "Ajouter"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- « + Exécutant » ---------------------------------------------------------------------

/** Bouton « + Exécutant », grisé (avec l'explication) si le hub n'a pas de coordinateur. */
export function AddExecutorButton({ hub, onClick, compact }: { hub: Hub; onClick: () => void; compact?: boolean }) {
  const blocker = executorBlocker(hub);
  return compact ? (
    <button className="icon-btn" title={blocker ? `+ Exécutant : ${blocker}` : "+ Exécutant…"} disabled={!!blocker} onClick={onClick}>
      <UserPlus size={13} />
    </button>
  ) : (
    <button className="btn" title={blocker ?? "Lancer une nouvelle conversation exécutante, qui rendra compte au coordinateur"} disabled={!!blocker} onClick={onClick}>
      <UserPlus size={14} /> Exécutant
    </button>
  );
}

/** Demande de la fenêtre « + Exécutant ». */
export interface ExecutorRequest {
  projectKey: string;
  task: string;
  /** Nom du nouveau worktree (vide = nom choisi par Claude Code), ou null : dans le dossier du projet. */
  worktree: string | null;
}

/** Relecture du nom de messagerie du coordinateur tant que la fenêtre est ouverte (il peut être lancé entre-temps). */
const COORDINATOR_POLL_MS = 3000;

/**
 * « + Exécutant » : projet (par défaut celui du coordinateur), tâche, et « Dans un nouveau
 * worktree » coché par défaut (nom facultatif). Indique si le coordinateur tourne (son nom de
 * messagerie sera donné à l'exécutant) et propose sinon de l'ouvrir d'abord.
 */
export function ExecutorDialog(props: {
  hub: Hub;
  /** Projets proposés : connus, non archivés, avec un dossier. */
  projects: { key: string; name: string; path: string }[];
  defaultProjectKey: string | null;
  coordinator: { id: string; title: string };
  validateWorktree: (name: string) => string | null;
  onOpenCoordinator: () => void;
  onSubmit: (r: ExecutorRequest) => void;
  onClose: () => void;
}) {
  const [projectKey, setProjectKey] = useState(
    () => props.projects.find((p) => p.key === props.defaultProjectKey)?.key ?? props.projects[0]?.key ?? "",
  );
  const [task, setTask] = useState("");
  const [inWorktree, setInWorktree] = useState(true);
  const [worktree, setWorktree] = useState("");
  // Dépôt git ? (null : vérification en cours ; un worktree n'est possible que dans un dépôt git)
  const [isGit, setIsGit] = useState<boolean | null>(null);
  // Nom de messagerie du coordinateur : undefined = lecture en cours, null = il ne tourne pas.
  const [name, setName] = useState<string | null | undefined>(undefined);
  const path = props.projects.find((p) => p.key === projectKey)?.path ?? null;
  const coordinatorId = props.coordinator.id;

  useEffect(() => {
    setIsGit(null);
    if (!path) return;
    let cancelled = false;
    api
      .isGitRepo(path)
      .then((g) => !cancelled && setIsGit(g))
      .catch(() => !cancelled && setIsGit(false));
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    const pull = () =>
      messagesApi
        .messagingName(coordinatorId)
        .then((n) => !cancelled && setName(n))
        .catch(() => !cancelled && setName(null));
    pull();
    const timer = setInterval(pull, COORDINATOR_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [coordinatorId]);

  const worktreeOk = isGit !== false;
  const useWorktree = inWorktree && worktreeOk;
  const error = useWorktree ? props.validateWorktree(worktree) : null;
  const valid = !!path && task.trim().length > 0 && !error;
  const submit = () => {
    if (valid) props.onSubmit({ projectKey, task: task.trim(), worktree: useWorktree ? worktree.trim() : null });
  };

  return (
    <Modal title={`+ Exécutant dans « ${props.hub.name} »`} onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="executor-coordinator">
          <span>
            Coordinateur : <strong>{props.coordinator.title}</strong>
            {name && (
              <>
                {" "}
                (nom de messagerie <code>{name}</code>)
              </>
            )}
          </span>
          {name === null && (
            <div className="executor-warning">
              <span>
                Il ne tourne pas : l'exécutant ne connaîtra que le nom de sa conversation, pas son nom de messagerie (qui change à chaque lancement). Ouvrez-le
                d'abord pour que l'exécutant puisse lui rendre compte.
              </span>
              <button type="button" className="btn small" onClick={props.onOpenCoordinator}>
                Ouvrir le coordinateur
              </button>
            </div>
          )}
        </div>
        <label className="field">
          <span>Projet</span>
          <select value={projectKey} onChange={(e) => setProjectKey(e.target.value)}>
            {props.projects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Tâche</span>
          <textarea
            value={task}
            rows={6}
            placeholder="Ce que l'exécutant doit faire (envoyé comme premier message)"
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl+Entrée (⌘+Entrée) : valider.
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            }}
            autoFocus
          />
          <small>Suivie de la consigne de rendre compte au coordinateur avec l'outil SendMessage.</small>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={useWorktree} disabled={!worktreeOk} onChange={(e) => setInWorktree(e.target.checked)} />
          Dans un nouveau worktree
        </label>
        {!worktreeOk && <small className="executor-hint">Le dossier de ce projet n'est pas un dépôt git : l'exécutant démarrera dans le dossier du projet.</small>}
        {useWorktree && (
          <label className="field executor-worktree">
            <span>Nom du worktree (facultatif)</span>
            <input value={worktree} placeholder="ex. correction-connexion" onChange={(e) => setWorktree(e.target.value)} spellCheck={false} />
            <small>
              {error ?? "Copie de travail séparée dans .claude\\worktrees\\<nom>, sur la branche worktree-<nom>. Sans nom, Claude Code en choisit un."}
            </small>
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={props.onClose}>
            Annuler
          </button>
          <button type="submit" className="btn primary" disabled={!valid}>
            Lancer l'exécutant
          </button>
        </div>
      </form>
    </Modal>
  );
}
