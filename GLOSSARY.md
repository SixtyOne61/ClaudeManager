# Claude Manager

Client de bureau pour Claude Code qui remplace Claude Desktop, avec en plus une organisation des projets et des conversations propre à l'utilisateur.

## Organisation

**Projet** :
Un dossier sur le disque dans lequel on travaille avec l'agent. Les conversations d'un worktree de ce dossier appartiennent au même projet.
_Éviter_ : dépôt, workspace, dossier projet

**Catégorie** :
Un regroupement de projets choisi par l'utilisateur, propre à Claude Manager.
_Éviter_ : groupe, dossier

**Section** :
Un regroupement de conversations à l'intérieur d'un projet, choisi par l'utilisateur et propre à Claude Manager.
_Éviter_ : sous-catégorie, dossier, groupe

**Couleur** :
Une teinte choisie par l'utilisateur pour repérer une catégorie, un projet ou une conversation.

## Conversations

**Conversation** :
Un échange avec l'agent dans un projet, repéré par son identifiant, et repris tel quel dans Claude Manager, Claude Desktop ou le terminal.
_Éviter_ : session, chat, discussion

**État** :
Où en est une conversation : *en cours* (l'agent travaille), *action requise* (une permission ou une question attend l'utilisateur), *à toi* (l'agent a fini son tour et attend le prochain message), ou *fermée* (aucun terminal intégré ouvert). Affiché par une pastille d'activité colorée.
_Éviter_ : statut, status, terminée, attend ta réponse

**Terminal intégré** :
Le terminal affiché dans Claude Manager où tourne la conversation, avec Claude Code tel qu'Anthropic le fournit.
_Éviter_ : console, shell, chat

**Worktree** :
Une copie de travail séparée d'un projet, dans laquelle une conversation peut tourner sans toucher au dossier principal.

**Suggestion** :
Une bonne pratique que l'app propose quand elle repère une situation (contexte trop rempli, troisième conversation dans le même dossier…). Affichée par une icône 💡 et un bandeau avec un bouton d'action et un bouton « Ignorer ». L'app n'agit jamais d'elle-même : c'est l'utilisateur qui clique.
_Éviter_ : alerte, avertissement, notification, conseil

**Hand off** :
Passer le relais d'une conversation dont le contexte est trop rempli à une nouvelle conversation du même projet, qui démarre avec un résumé de passation écrit par l'ancienne. L'ancienne devient la **parente** (archivée), la nouvelle sa **suite**, à la même place dans la barre latérale.
_Éviter_ : compactage, `/compact`, passation (pour le nom de l'action), relais

**Résumé de passation** :
Le texte que la parente rédige pour sa suite lors d'un hand off : objectif, état actuel, décisions, fichiers touchés, prochaines étapes.
_Éviter_ : résumé (seul), handoff doc

## Hubs

**Hub** :
Un regroupement de conversations, éventuellement de projets différents, qui travaillent ensemble et s'échangent des messages. Propre à Claude Manager. Une conversation reste rangée dans son projet ; le hub n'y fait que renvoyer.
_Éviter_ : équipe, groupe, espace, salon

**Coordinateur** :
La conversation d'un hub qui répartit le travail et reçoit les comptes rendus. Un hub en a au plus un.
_Éviter_ : chef, orchestrateur, leader

**Exécutant** :
Une conversation d'un hub qui réalise une tâche confiée par le coordinateur, en général dans un worktree, et lui rend compte. Dans un hub sans coordinateur, les membres sont de simples **pairs**.
_Éviter_ : worker, sous-agent, agent

**Message entre conversations** :
Un message qu'une conversation envoie à une autre par la messagerie de Claude Code (outil `SendMessage`). Il est reçu comme un message utilisateur balisé `<cross-session-message>`. L'app les lit et les affiche, elle ne les transporte pas.
_Éviter_ : message d'agent, ping, notification

**Nom de messagerie** :
Le nom par lequel Claude Code adresse une conversation en cours pour lui envoyer un message (par exemple `claudemanager-bf`). Il change à chaque lancement de Claude Code, contrairement à l'identifiant de la conversation.
_Éviter_ : adresse, pseudo, identifiant (qui désigne celui de la conversation)
