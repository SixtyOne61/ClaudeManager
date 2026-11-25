// « Vue Hub » : affichée dans la zone principale quand on clique un hub dans l'onglet Hubs de
// la barre latérale, au même niveau que la vue d'un projet. En-tête (nom, actions du hub),
// membres présentés comme les conversations d'un projet (pastille d'état, titre, rôle, projet,
// date), puis le fil chronologique des messages entre ses conversations (« A → B : résumé »,
// dépliable pour lire le message complet), repliable. Cliquer un membre ouvre la conversation.
// Les messages sont lus dans les `.jsonl` des membres (voir src/messages.ts) ; l'app ne les
// transporte pas.

import { useMemo, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import type { Config, Hub, ProjectInfo } from "../api";
import { colorStyle, projectName, formatDate, relativeDate } from "../util";
import { useActivities } from "../activity";
import { roleLabel, sortedMembers } from "../hubs";
import { messageHeadline, useHubThread, type HubMessage, type HubPeer } from "../messages";
import { renderMarkdown } from "../markdown";
import { ActivityDot } from "./Activity";
import { HubHeaderActions, HubMemberControls, memberInfo, type HubActions } from "./Hubs";
import { ConversationSuggestionIcon } from "./Suggestions";

interface Props {
  hub: Hub;
  config: Config;
  projects: Map<string, ProjectInfo>;
  /** Titre d'une conversation (projet ou archives), null si inconnue. */
  titleOf: (id: string) => string | null;
  /** Actions sur le hub et ses membres (ouvrir une conversation, renommer, « + Exécutant »…). */
  actions: HubActions;
}

export function HubView({ hub, config, projects, titleOf, actions }: Props) {
  const activities = useActivities();
  const thread = useHubThread(hub);
  const [threadOpen, setThreadOpen] = useState(true);
  const open = actions.onOpenConversation;

  return (
    <main className="main hub-view">
      <header className="project-header" style={colorStyle(hub.color)}>
        <div className="project-title">
          <h2>
            <span className="hub-view-icon" aria-hidden>
              🔗
            </span>{" "}
            {hub.name}
          </h2>
          <div className="project-actions hub-view-actions">
            <HubHeaderActions hub={hub} actions={actions} />
          </div>
        </div>
        <p className="muted">
          Hub de {hub.members.length} conversation{hub.members.length > 1 ? "s" : ""}. Les messages sont ceux que les conversations s'envoient avec la
          messagerie de Claude Code (outil <code>SendMessage</code>).
        </p>
      </header>
      <div className="session-list hub-view-body">
        <h3 className="archives-heading">Conversations</h3>
        {hub.members.length === 0 && <p className="muted">Aucune conversation : « Ajouter à un hub… » sur une conversation.</p>}
        {sortedMembers(hub).map((m) => {
          const info = memberInfo(config, projects, m.conversationId);
          const title = info.session?.title ?? info.archived?.title ?? titleOf(m.conversationId);
          const date = info.session?.updatedAt ?? null;
          return (
            <div
              key={m.conversationId}
              className={"session-row hub-view-member" + (title ? "" : " gone")}
              onClick={() => open(m.conversationId)}
              title={info.session?.firstPrompt ?? "Ouvrir la conversation"}
            >
              <ActivityDot activity={activities.get(m.conversationId)} />
              <div className="session-main">
                <div className="session-title">
                  {title ?? "Conversation introuvable"}
                  <ConversationSuggestionIcon sessionId={m.conversationId} />
                </div>
                <div className="session-meta">
                  {info.project ? (
                    <span className="hub-view-project" style={colorStyle(config.projects[info.project.key]?.color)}>
                      {projectName(info.project, config)}
                    </span>
                  ) : info.archived ? (
                    <span>archivée</span>
                  ) : null}
                  {date && (
                    <>
                      <span className="dot">·</span>
                      <span title={formatDate(date)}>{relativeDate(date)}</span>
                    </>
                  )}
                </div>
              </div>
              <span className={"hub-role role-" + m.role}>{roleLabel(m.role)}</span>
              <span className="session-actions hub-member-actions" onClick={(e) => e.stopPropagation()}>
                <HubMemberControls hub={hub} member={m} actions={actions} />
              </span>
            </div>
          );
        })}

        <h3 className="archives-heading hub-thread-heading">
          <button className="icon-btn bare" onClick={() => setThreadOpen((o) => !o)} title={threadOpen ? "Replier" : "Déplier"}>
            {threadOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          Messages {thread && thread.length > 0 && <span className="count">{thread.length}</span>}
        </h3>
        {threadOpen &&
          (thread === null ? (
            <p className="muted">Lecture des messages…</p>
          ) : thread.length === 0 ? (
            <p className="muted">Aucun message entre ces conversations pour l'instant.</p>
          ) : (
            <div className="hub-thread">
              {thread.map((m, i) => (
                <HubThreadItem key={i} message={m} titleOf={titleOf} onOpen={open} />
              ))}
            </div>
          ))}
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
