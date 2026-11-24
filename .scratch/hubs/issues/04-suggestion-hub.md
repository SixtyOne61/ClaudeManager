# Suggérer un hub quand deux conversations ont échangé

Status: resolved
Blocked by: 01, 02

## Ce qu'on veut

Quand deux conversations qui ne sont pas dans un même hub ont échangé un message entre conversations, l'app suggère de les regrouper.

## Comportement attendu

- Nouvelle règle du moteur de suggestions (`.scratch/suggestions/issues/01-…`) : bandeau dans les deux conversations « Cette conversation a échangé avec *autre* : les regrouper dans un hub ? » ; boutons **Créer un hub** (l'expéditeur du premier message devient coordinateur, le destinataire exécutant ; si l'une est déjà dans un hub, proposer d'y ajouter l'autre) et **Ignorer** (pour cette paire, définitivement).
- Icône 💡 comme les autres suggestions. Case dans les réglages pour couper la règle.

## Comments

Fait :

- **Repérage des échanges** (`src-tauri/src/messages.rs`, testé) : `first_exchanges(fil)` garde le premier message de chaque paire dont l'expéditeur et le destinataire sont tous deux des conversations connues et différentes (`Exchange { from, to }`). `ExchangeTracker` tient ces échanges à jour : il garde les messages de chaque conversation qui en a au moins un, et `update(store, fichiers changés, noms, existe)` relit seulement les fichiers changés, ne recalcule (`hub_thread` sur les conversations suivies) que si un message est apparu ou a disparu, et écarte les échanges avec une conversation qui n'existe plus (Corbeille) mais reste reconnue par un nom déjà vu. Les noms appris par appariement vont dans le cache (`remember_names`).
- **Performances** (choix) : rien n'est lu au moment du calcul des suggestions, qui ne fait que reprendre les échanges déjà repérés.
  - `MessageStore` lit désormais un `.jsonl` **par la fin** : quand le fichier a grandi, seule la suite est lue (une ligne pas encore terminée sera lue la fois suivante) ; un fichier raccourci est relu en entier. La liste garde la même identité (`Arc::ptr_eq`) tant qu'aucun message n'apparaît, ce qui permet à l'`ExchangeTracker` de savoir sans comparer qu'il n'y a rien à recalculer. La Vue Hub (`hub_messages`) en profite aussi.
  - Au démarrage, un thread lit une fois les conversations dont le `.jsonl` a changé depuis moins de 7 jours (`EXCHANGE_RECENT_MS`, `recent_conversation_files`), avec le repérage par sous-chaîne déjà en place. Ensuite, l'observateur des `.jsonl` (`start_watcher`) transmet chaque fichier qui change ; ils sont traités par lots de ~2 s (`update_exchanges` dans lib.rs), et les suggestions ne sont émises que si les échanges ont changé. Une conversation plus ancienne qui n'a pas changé depuis n'est donc jamais lue, mais un échange avec elle est repéré dès que l'autre conversation (récente) lui écrit ou reçoit d'elle, grâce aux noms de messagerie.
- **Règle `hub`** (`suggestions.rs`, testée) : `Inputs.exchanges` ; `detect_hub` propose une suggestion dans chacune des deux conversations (clé `hub:<autre>`, palier 1, `since: None` donc « Ignorer » définitif), sauf si elles sont déjà dans un même hub (non archivé) ou si l'une est archivée. Données : `other`, `from`/`to` (premier message), et si l'une est dans un hub : `hubId`, `hubName`, `joiner` (celle qui le rejoindrait : l'autre si la conversation du bandeau est dans un hub, sinon elle-même) et `leaves` (hub qu'elle quitterait, cas de deux hubs différents). Les commandes `hub_*` recalculent et émettent les suggestions (`change_hubs`, `hub_restore`).
- **Interface** (`src/suggestions.ts`, `Suggestions.tsx`) : `SUGGESTION_RULES.hub` avec bandeau « Cette conversation a échangé avec « *autre* » : les regrouper dans un hub ? » (ou « … : l'ajouter au hub « H » ? » / « …, du hub « H » : rejoindre ce hub ? », avec « (elle quittera le hub « X ») » au besoin) ; bouton **Créer un hub** / **Ajouter au hub** / **Rejoindre le hub**. Pour cela, le texte d'un bandeau reçoit les titres des conversations (`SuggestionTextContext`, via `ConversationLinksContext`) et le libellé d'une action peut dépendre de la suggestion. 💡 dans la barre latérale comme les autres ; case « Conversations qui ont échangé » dans les réglages (automatique avec `SUGGESTION_RULES`).
- **Actions** (`App.tsx`, `acceptHubSuggestion`) : sans hub, fenêtre « Créer un hub » (nom proposé : titre de l'expéditeur, rappel des rôles), puis hub créé avec l'expéditeur du premier message en coordinateur et le destinataire en exécutant ; avec un hub, `joiner` le rejoint avec le rôle par défaut du hub (`defaultRole` : exécutant s'il a un coordinateur, sinon pair). **Ignorer** (`dismissSuggestion`) masque la paire dans les deux conversations.
- Mode dev (`devMock.ts`) : deux échanges fictifs (deux conversations hors hub ; une conversation de « JeuDeCartes » qui a écrit au coordinateur du hub fictif), même règle que Rust, suggestions recalculées après chaque commande `hub_*`.
