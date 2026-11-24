# Les hubs affichent la messagerie de Claude Code au lieu d'en créer une, et l'app n'agit que sur un clic

Les hubs font travailler plusieurs conversations ensemble : un coordinateur confie des tâches à des exécutants, et des pairs s'interrogent. Claude Code sait déjà faire communiquer les conversations qui tournent sur la machine : l'outil `SendMessage` envoie un message à une autre conversation désignée par son nom de messagerie, et le destinataire le reçoit comme un message utilisateur balisé `<cross-session-message from="…" from-name="…">`. Les deux côtés sont écrits dans les `.jsonl`. Le fichier `~/.claude/sessions/<pid>.json` relie chaque conversation en cours (`sessionId`) à son nom de messagerie (`name`), avec son dossier et son état. Claude Manager s'appuie donc sur cette messagerie : il **lit** ces fichiers pour dessiner les hubs et les échanges, sans transporter lui-même de message et sans dépenser de token.

Dans le même esprit, et en prolongement de l'ADR 0001, les suggestions (hand off, worktree, hub) ne déclenchent jamais d'action seules. Quand l'utilisateur clique, l'app peut taper un texte dans le terminal intégré à sa place (la consigne du résumé de passation, la tâche d'un exécutant), comme s'il l'avait tapé lui-même. Elle ne répond toujours jamais à une demande de permission.

## Options écartées

- **Une messagerie propre à l'app** (fichier partagé, file de messages, serveur local) : double ce que Claude Code fait déjà, et l'agent ne saurait pas s'en servir sans outil supplémentaire.
- **Un serveur MCP fourni par l'app pour que le coordinateur lance lui-même ses exécutants**, comme l'outil `start_session` de Claude Desktop : plus puissant, mais l'app deviendrait un outil de l'agent. Reporté ; à décider dans un ADR dédié.
- **Lancer le hand off automatiquement à un seuil de contexte** : couperait l'agent en pleine tâche.

## Conséquences

- Le nom de messagerie change à chaque lancement de Claude Code : l'app relit `~/.claude/sessions/` pour relier un nom à une conversation, et garde la correspondance des noms déjà vus pour les messages anciens.
- Ce fichier et le format `<cross-session-message>` ne sont pas documentés comme une interface stable : la lecture doit tolérer leur absence ou un changement de format (les hubs restent utilisables, seul le fil des messages se vide).
- Les messages reçus s'affichent dans la conversation comme des bulles « Message de … », et non comme des messages tapés par l'utilisateur.
