// « Vue Hub » (onglet ouvert en cliquant le nom d'un hub) : ses membres, avec rôle et pastille
// d'état, puis le fil chronologique des messages entre ses conversations (« A → B : résumé »,
// dépliable pour lire le message complet). Cliquer un nom ouvre la conversation.
// Les messages sont lus dans les `.jsonl` des membres (voir src/messages.ts) ; l'app ne les
// transporte pas.

import { useMemo, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import type { Config, Hub, ProjectInfo } from "../api";
import { projectName, formatDate } from "../util";
import { useActivities } from "../activity";
import { roleLabel, sortedMembers } from "../hubs";
import { messageHeadline, useHubThread, type HubMessage, type HubPeer } from "../messages";
import { renderMarkdown } from "../markdown";
import { ActivityDot } from "./Activity";

interface Props {
  hub: Hub;
  config: Config;
  projects: Map<string, ProjectInfo>;
  /** Titre d'une conversation (projet ou archives), null si inconnue. */
  titleOf: (id: string) => string | null;
  /** Ouvre une conversation par son identifiant (onglet, ou archives). */
  onOpenConversation: (id: string) => void;
}

export function HubView({ hub, config, projects, titleOf, onOpenConversation }: Props) {
  const activities = useActivities();
  const thread = useHubThread(hub);
  const projectOf = (id: string) => [...projects.values()].find((p) => p.sessions.some((s) => s.id === id)) ?? null;

  return (
    <main className="main hub-view">
      <header className="project-header">
        <div className="project-title">
          <h2>
            <span className="hub-view-icon" aria-hidden>
              🔗
            </span>{" "}
            {hub.name}
          </h2>
        </div>
        <p className="muted">
          Hub de {hub.members.length} conversation{hub.members.length > 1 ? "s" : ""}. Les messages sont ceux que les conversations s'envoient avec la
          messagerie de Claude Code (outil <code>SendMessage</code>).
        </p>
      </header>
      <div className="session-list hub-view-body">
        <h3 className="archives-heading">Membres</h3>
        {hub.members.length === 0 && <p className="muted">Aucune conversation : « Ajouter à un hub… » sur une conversation, ou glissez-la sur le hub.</p>}
        {sortedMembers(hub).map((m) => {
          const title = titleOf(m.conversationId);
          const project = projectOf(m.conversationId);
          const archived = !project && config.archives.some((a) => a.sessionId === m.conversationId);
          return (
            <div key={m.conversationId} className={"session-row hub-view-member" + (title ? "" : " gone")}>
              <ActivityDot activity={activities.get(m.conversationId)} />
              <div className="session-main">
                <button className="link-btn session-title" onClick={() => onOpenConversation(m.conversationId)} title="Ouvrir la conversation">
                  {title ?? "Conversation introuvable"}
                </button>
                <div className="session-meta">{project ? projectName(project, config) : archived ? "archivée" : ""}</div>
              </div>
              <span className={"hub-role role-" + m.role}>{roleLabel(m.role)}</span>
            </div>
          );
        })}

        <h3 className="archives-heading">Messages</h3>
        {thread === null ? (
          <p className="muted">Lecture des messages…</p>
        ) : thread.length === 0 ? (
          <p className="muted">Aucun message entre ces conversations pour l'instant.</p>
        ) : (
          <div className="hub-thread">
            {thread.map((m, i) => (
              <HubThreadItem key={i} message={m} titleOf={titleOf} onOpen={onOpenConversation} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

/** Nom d'une extrémité : titre de la conversation si elle est connue (cliquable), sinon nom brut. */
function PeerName({ peer, titleOf, onOpen }: { peer: HubPeer; titleOf: Props["titleOf"]; onOpen: (id: string) => void }) {
  const title = peer.conversationId ? titleOf(peer.conversationId) : null;
  if (peer.conversationId && title) {
    const id = peer.conversationId;
    return (
      <button
        className="link-btn hub-peer"
        title={`Ouvrir la conversation « ${title} »`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen(id);
        }}
      >
        {title}
      </button>
    );
  }
  return (
    <span className="hub-peer unknown" title="Conversation inconnue (nom de messagerie)">
      {peer.name}
    </span>
  );
}

function HubThreadItem({ message, titleOf, onOpen }: { message: HubMessage; titleOf: Props["titleOf"]; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (open ? renderMarkdown(message.text) : ""), [open, message.text]);
  return (
    <div className={"hub-message" + (open ? " open" : "")}>
      <div className="hub-message-row" onClick={() => setOpen((o) => !o)} title={open ? "Replier" : "Lire le message complet"}>
        {open ? <ChevronDown size={13} className="action-chevron" /> : <ChevronRight size={13} className="action-chevron" />}
        <PeerName peer={message.from} titleOf={titleOf} onOpen={onOpen} />
        <ArrowRight size={12} className="hub-message-arrow" />
        <PeerName peer={message.to} titleOf={titleOf} onOpen={onOpen} />
        <span className="hub-message-summary">: {messageHeadline(message)}</span>
        {message.timestamp && <span className="hub-message-date">{formatDate(message.timestamp)}</span>}
      </div>
      {open && <div className="hub-message-text markdown" dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
}
