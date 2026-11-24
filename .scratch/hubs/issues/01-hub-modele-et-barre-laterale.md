# Hub : modèle et barre latérale

Status: resolved

## Ce qu'on veut

Créer, renommer, colorer, archiver et supprimer des hubs, et y ranger des conversations avec un rôle.

## Comportement attendu

- Les hubs forment un bloc en haut de la barre latérale, au-dessus des catégories, avec les mêmes compteurs de pastilles d'état que les projets.
- Un hub se déplie pour lister ses membres (nom de la conversation, projet en petit, rôle, pastille d'état). Cliquer un membre ouvre la conversation.
- Créer un hub : bouton « + Hub ». Ajouter une conversation : menu de la conversation « Ajouter à un hub… » (choix du hub et du rôle), ou glisser-déposer sur le hub.
- Rôles : au plus un coordinateur ; en désigner un nouveau rétrograde l'ancien en exécutant.
- Dans son projet, une conversation membre porte une icône 🔗 (info-bulle : nom du hub et rôle).
- Archiver un hub archive le hub et toutes ses conversations ; désarchiver restaure les deux. Supprimer un hub ne supprime que le regroupement.
- Retirer une conversation d'un hub ; une conversation supprimée ou passée à la corbeille disparaît du hub.
- Hand off d'un membre (si le ticket suggestions/02 est fait) : la suite remplace la parente dans le hub avec le même rôle, et le résumé de passation contient la liste des membres et la consigne de les prévenir de son nouveau nom de messagerie.

## Vérifications

- Tests Rust de la persistance et des règles (un seul coordinateur, archivage en cascade, suppression).

## Comments

Fait :

- **Données** : `config.json` passe en version 5, champ `hubs` (liste ordonnée de `Hub { id, name, color, members: [{ conversationId, role }], createdAt, archived: { archivedAt, sessionIds } | null }`, rôles `"coordinateur" | "executant" | "pair"`). Types dans `config.rs` (`Hub`, `HubMember`, `HubRole`, `HubArchive`) et `src/api.ts`. Fichier plus ancien : aucun hub, rien à convertir.
- **Gérés par le backend seulement** (comme `handoffLinks`) : `save_config` garde les hubs du backend ; toute modification passe par une commande `hub_*`. Règles dans `src-tauri/src/hubs.rs`, testées :
  - une conversation est dans **un hub au plus** (l'ajouter ailleurs l'y déplace) — choix fait ici, le ticket ne le précisait pas ;
  - au plus un coordinateur : en désigner un nouveau rétrograde l'ancien en exécutant ;
  - archivage en cascade, sur le modèle des projets : l'interface archive les conversations une à une (confirmation habituelle, « modifiée il y a peu »), puis `hub_mark_archived` ; s'il en reste une, le hub n'est pas archivé. `hub_restore` restaure les conversations archivées avec lui puis le hub. Une conversation restaurée seule fait revenir son hub ; mise à la Corbeille depuis les archives, elle sort de sa liste (`detach_from_archived_hub`). Les membres déjà archivés seuls avant l'archivage du hub restent dans les archives ;
  - supprimer un hub ne touche pas aux conversations ;
  - une conversation qui n'existe plus (ni sur le disque ni dans les archives) quitte son hub au scan suivant (`prune_conversations` → `hubs::prune`) ; une conversation archivée seule reste membre (affichée « archivée », le clic ouvre les archives).
- **Hand off d'un membre** : `handoff::apply` appelle `hubs::replace_member` (la suite prend la place et le rôle de la parente). `handoff_summary` construit un `hubs::HandoffContext` (nom du hub, rôle, autres membres avec titre, rôle et nom de messagerie actuel lu dans `~/.claude/sessions/<pid>.json` par `hubs::messaging_names`, tolérant) ; `handoff::first_message(parent_title, summary, Option<&HandoffContext>)` ajoute la liste et la consigne de prévenir chacun de son nouveau nom de messagerie avec SendMessage.
- **Barre latérale** : bloc des hubs en tête, dans les deux vues (Projets et Conversations), avec compteurs de pastilles, 💡, nombre de membres ; repliable (mémorisé avec les catégories, clé `hub:<id>`). Membres : pastille d'état, nom, projet en petit, rôle (au survol : choix du rôle et « Retirer du hub »). Clic sur un membre : ouvre la conversation. Survol du hub : renommer, couleur, archiver, supprimer. Bouton « + Hub » à côté de « + Catégorie ». Glisser-déposer : depuis la vue « Conversations » de la barre latérale sur un hub (rôle par défaut : exécutant s'il y a un coordinateur, sinon pair). La vue projet a son propre `DndContext` : pas de dépôt depuis elle, on y utilise « Ajouter à un hub… ».
- **Vue projet** : 🔗 après le titre d'une conversation membre (info-bulle « Hub « X » · Rôle ») — aussi dans la liste de la barre latérale — et bouton « Ajouter à un hub… » (icône maillon, à côté du hand off) : fenêtre `HubDialog` (hub existant ou « Nouveau hub… », rôle, avertissement « « X » deviendra exécutant », « Retirer du hub »).
- **Archives** : section « Hubs archivés » avec « Restaurer le hub ».
- Mode dev : hub fictif « Refonte du site » (trois membres, deux projets), commandes `hub_*` simulées.

API pour les tickets suivants :

- Rust (`hubs.rs`) : `find`, `hub_of(cfg, id) -> Option<(&Hub, HubRole)>`, `create`, `update`, `delete`, `set_member`, `remove_member`, `mark_archived`, `archived_ids`, `unarchive`, `detach_from_archived_hub`, `replace_member`, `prune`, `role_label`, `messaging_names(sessions_dir) -> HashMap<sessionId, name>` (utile pour hubs/02), `handoff_context`.
- Commandes : `hub_create(name, color) -> { config, hubId }`, `hub_update(hubId, name, color)`, `hub_delete(hubId)`, `hub_set_member(hubId, conversationId, role)`, `hub_remove_member(hubId, conversationId)`, `hub_mark_archived(hubId, sessionIds)` → `Config` ; `hub_restore(hubId) -> { config, restored, errors }`.
- TS : `api.hubCreate/hubUpdate/hubDelete/hubSetMember/hubRemoveMember/hubMarkArchived/hubRestore` ; lecture dans `src/hubs.ts` : `activeHubs`, `archivedHubs`, `hubOf`, `coordinatorOf`, `defaultRole`, `sortedMembers`, `HUB_ROLES`, `roleLabel`, `hubHint`. Composants dans `src/components/Hubs.tsx` : `HubsBlock`, `HubLinkIcon`, `HubDialog`, `HubActions`.
- **Point d'accroche hubs/02** : `HubActions.onOpenHub?(hubId)` (clic sur le nom du hub ; absent pour l'instant, le clic déplie/replie). Le brancher dans `hubActions` d'`App.tsx`.
