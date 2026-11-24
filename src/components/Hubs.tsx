// Hubs dans l'interface (voir src/hubs.ts) : bloc en haut de la barre latérale, icône 🔗 d'une
// conversation membre, fenêtre « Ajouter à un hub… ».

import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Archive, ChevronDown, ChevronRight, Pencil, Trash2, X } from "lucide-react";
import type { ArchiveEntry, Config, Hub, HubRole, ProjectInfo, SessionInfo } from "../api";
import { colorStyle, projectName } from "../util";
import { countActivities, type Activity } from "../activity";
import { hasSuggestion, useSuggestions } from "../suggestions";
import { HUB_ROLES, activeHubs, coordinatorOf, hubHint, hubOf, roleLabel, sortedMembers } from "../hubs";
import { ActivityCounts, ActivityDot } from "./Activity";
import { ColorPicker } from "./ColorPicker";
import { ConversationSuggestionIcon, SuggestionIcon } from "./Suggestions";
import { Modal } from "./Dialogs";

/** Préfixe des zones de dépôt des hubs (glisser une conversation sur un hub). */
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
   * Clic sur le nom d'un hub : ouvrira la « Vue Hub » (ticket hubs/02). Absent : le clic
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
}

/** Conversation d'un membre : dans un projet, ou dans les archives. */
type MemberInfo = { session: SessionInfo; project: ProjectInfo; archived: null } | { session: null; project: null; archived: ArchiveEntry | null };

function memberInfo(config: Config, projects: Map<string, ProjectInfo>, id: string): MemberInfo {
  for (const p of projects.values()) {
    const s = p.sessions.find((x) => x.id === id);
    if (s) return { session: s, project: p, archived: null };
  }
  return { session: null, project: null, archived: config.archives.find((a) => a.sessionId === id) ?? null };
}

/**
 * Bloc des hubs, en haut de la barre latérale (rien s'il n'y a aucun hub). À placer dans un
 * `DndContext` : chaque hub est une zone de dépôt `hub:<id>` pour les conversations.
 */
export function HubsBlock(props: {
  config: Config;
  projects: Map<string, ProjectInfo>;
  activities: ReadonlyMap<string, Activity>;
  activeSessionId: string | null;
  /** Identifiants repliés (hubs : `hub:<id>`). */
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  actions: HubActions;
}) {
  const hubs = activeHubs(props.config);
  if (hubs.length === 0) return null;
  return (
    <div className="hubs-block">
      {hubs.map((hub) => (
        <HubBlock
          key={hub.id}
          {...props}
          hub={hub}
          collapsed={props.collapsed.has(HUB_DROP_PREFIX + hub.id)}
          onToggle={() => props.onToggle(HUB_DROP_PREFIX + hub.id)}
        />
      ))}
    </div>
  );
}

function HubBlock(props: {
  config: Config;
  projects: Map<string, ProjectInfo>;
  activities: ReadonlyMap<string, Activity>;
  activeSessionId: string | null;
  hub: Hub;
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
      <div className="category-header hub-header">
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
          <button className="icon-btn" title="Renommer" onClick={() => actions.onRename(hub)}>
            <Pencil size={13} />
          </button>
          <ColorPicker compact value={hub.color} onChange={(c) => actions.onColor(hub, c)} title="Couleur du hub" />
          <button className="icon-btn" title="Archiver le hub et ses conversations" onClick={() => actions.onArchive(hub)}>
            <Archive size={13} />
          </button>
          <button className="icon-btn" title="Supprimer le hub (les conversations restent dans leur projet)" onClick={() => actions.onDelete(hub)}>
            <Trash2 size={13} />
          </button>
        </span>
      </div>
      {!props.collapsed && (
        <div className="category-body">
          {sortedMembers(hub).map((m) => {
            const info = memberInfo(props.config, props.projects, m.conversationId);
            const title = info.session?.title ?? info.archived?.title ?? "Conversation introuvable";
            const where = info.project ? projectName(info.project, props.config) : info.archived ? "archivée" : "";
            return (
              <div
                key={m.conversationId}
                className={"project-row conv-row hub-member" + (props.activeSessionId === m.conversationId ? " selected" : "") + (info.session ? "" : " gone")}
                title={info.session?.firstPrompt ?? title}
                onClick={() => actions.onOpenConversation(m.conversationId)}
              >
                <ActivityDot activity={props.activities.get(m.conversationId)} />
                <span className="hub-member-main">
                  <span className="project-name">{title}</span>
                  {where && <span className="hub-member-project">{where}</span>}
                </span>
                <ConversationSuggestionIcon sessionId={m.conversationId} />
                <span className={"hub-role role-" + m.role}>{roleLabel(m.role)}</span>
                <span className="hub-member-actions" onClick={(e) => e.stopPropagation()}>
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
                </span>
              </div>
            );
          })}
          {hub.members.length === 0 && <div className="empty-zone">Déposez des conversations ici, ou « Ajouter à un hub… » sur une conversation</div>}
        </div>
      )}
    </section>
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
