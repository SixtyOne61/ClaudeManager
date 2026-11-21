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
