# Vue Hub et bulles de messages entre conversations

Status: resolved
Blocked by: 01

## Ce qu'on veut

Voir qui parle à qui dans un hub, et reconnaître un message reçu d'une autre conversation.

## Comportement attendu

- Côté Rust, lire les messages entre conversations :
  - envoyés : blocs `tool_use` de nom `SendMessage` (champs `to`, `summary`, `message`) dans le `.jsonl` de l'expéditeur ;
  - reçus : messages utilisateur dont le texte contient `<cross-session-message from="…" from-name="…">…</cross-session-message>`.
- Relier un nom de messagerie à une conversation : lire `~/.claude/sessions/*.json` (`sessionId`, `name`, `cwd`, `status`) ; garder dans le cache la correspondance des noms déjà vus, car le nom change à chaque lancement. Les identifiants `local_<uuid>` de Claude Desktop sont aussi possibles. Tolérer l'absence ou un format inattendu (fil vide, pas d'erreur).
- Vue Hub (onglet ouvert en cliquant le hub) : membres avec rôle et pastille d'état, puis fil chronologique « A → B : résumé », dépliable pour lire le message complet. Cliquer un nom ouvre la conversation.
- Dans l'interface de conversation : un message reçu s'affiche dans une bulle distincte « Message de *conversation* » (cliquable si la conversation est connue), et non comme un message de l'utilisateur. Un `SendMessage` envoyé s'affiche comme « Message à *conversation* ».

## Vérifications

- Tests Rust de l'extraction (envoyés, reçus, format inattendu) et de la correspondance des noms.

## Comments

Fait :

- **Lecture (Rust, `src-tauri/src/messages.rs`, nouveau)** : envoyés = `tool_use` `SendMessage` (`to`, sinon `recipient` ; `message`, sinon `content` ; `summary`) ; reçus = `<cross-session-message from="…" from-name="…">…</cross-session-message>` dans un message utilisateur (chaîne ou blocs `text`), à défaut le champ `origin` (`kind: "peer"`, `from`, `name`, `body`) écrit avec lui. Le message reçu est écrit avec `isMeta: true` : il est repéré avant le filtre `isMeta`. `<agent-message>` (sous-agent), lignes `queue-operation`/`api-request-blob`, sous-agents (`isSidechain`) : ignorés. Format inattendu → rien, jamais d'erreur. Tests à partir d'extraits réels.
- **Noms de messagerie** : `running_names(~/.claude/sessions)` → `NameUse { name, sessionId, since }` (`since` = `nameSince`, sinon `startedAt`), car un même nom (« claudemanager-bf », dérivé du dossier) peut être repris plus tard par une autre conversation. `resolve(names, peer, at)` : la conversation la plus récente à avoir pris ce nom avant le message, sinon la première. Gardés dans `cache.json` (champ `names` du cache du scanner, `#[serde(default)]`, pas de changement de version ; `Scanner::remember_names`, 2000 au plus). `hubs::messaging_names` passe par `running_names`.
- **`local_<uuid>` de Claude Desktop** : appris par appariement dans un hub (envoi et réception de même texte, dans une autre conversation, à ±60 s, chez le destinataire connu s'il l'est) puis gardés dans le cache ; vérifié sur les deux fichiers SpaceL réels (les deux `local_…` sont appris). Inconnu : nom brut (ou `from-name`) affiché.
- **Vue Hub** (`src/components/HubView.tsx`) : clic sur le nom du hub dans la barre latérale (`hubActions.onOpenHub`) → onglet « 🔗 nom » dans la barre d'onglets (onglet `hub:<id>` dans `activeTerminal`, `HUB_TAB_PREFIX`/`hubTabId` dans TerminalTabs.tsx ; fermé si le hub est supprimé ou archivé). Membres (pastille, titre cliquable, projet, rôle), puis fil « A → B : résumé » (résumé, sinon première ligne), date, dépliable (Markdown). Noms cliquables si la conversation est connue.
- **Conversation** : nouvelle entrée `kind: "message"` (`conversation::Entry::Message { line, uuid, id, sent, peer, peerName, summary, text, truncated, timestamp }`). Reçu : bulle à gauche « Message de *titre* » (nouveau bloc, pas une bulle utilisateur) ; envoyé : bulle « Message à *titre* » dans le tour de Claude (au lieu d'une action), « non remis » si le résultat de l'outil est une erreur. Long message avec résumé : replié. Titres et ouverture via `ConversationLinksContext` fourni par App.tsx.
- **Performances** : `hub_messages` ne lit que les `.jsonl` des membres (fichier d'archive pour un membre archivé), avec un cache mémoire par fichier (`MessageStore`, relu si date/taille changent) et un repérage par sous-chaîne avant décodage JSON. Côté interface, relu sur `conversation-changed` d'un membre (regroupé 400 ms) + filet toutes les 15 s ; les noms (`messaging_directory`) ne sont lus que si une bulle de message est affichée, et relus sur `sessions-changed`.
- Mode dev : messages fictifs dans le hub « Refonte du site » (coordinateur → exécutant, compte rendu, et un message d'une conversation Desktop hors hub, nom brut).

API (utile à hubs/04) :

- Rust `messages.rs` : `parse_line(text, line) -> Vec<CrossMessage>`, `read_file(path) -> Vec<CrossMessage>` (`CrossMessage { line, uuid, timestamp, sent, peer, peer_name, summary, text }`), `MessageStore::read(path) -> Arc<Vec<CrossMessage>>` (géré par Tauri : `State<messages::MessageStore>`), `sent_in_block(&Value)`, `received_in(&Value)`, `received_messages(&str)`, `running_names`, `merge_names`, `resolve`, `iso_ms`, `hub_thread(members: &[(id, Arc<Vec<CrossMessage>>)], names) -> (Vec<HubMessage>, Vec<NameUse> appris)`. Pour détecter que deux conversations ont échangé : `hub_thread` sur les deux (ou plus) conversations ; un `HubMessage` dont `from.conversationId` et `to.conversationId` sont tous deux connus = échange avéré. `Scanner::remember_names(&learned)` pour garder les noms appris.
- Commandes : `hub_messages(hubId) -> HubMessage[]` (`{ from: {conversationId|null, name}, to, summary, text, timestamp }`), `messaging_directory() -> NameUse[]`.
- TS `src/messages.ts` : `messagesApi.hubMessages/messagingDirectory`, `useHubThread(hub)`, `useMessagingDirectory()`, `resolvePeer(names, peer, timestamp)`, `messageHeadline`, `ConversationLinksContext`.
