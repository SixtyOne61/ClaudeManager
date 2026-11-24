# « + Exécutant »

Status: resolved
Blocked by: 01

## Ce qu'on veut

Lancer un exécutant depuis un hub qui a un coordinateur.

## Comportement attendu

- Dans la vue ou le menu du hub, bouton **+ Exécutant** : fenêtre avec le projet (par défaut celui du coordinateur), la tâche (texte), et « Dans un nouveau worktree » coché par défaut (nom facultatif).
- L'app crée la conversation, l'ajoute au hub comme exécutant, et envoie comme premier message la tâche suivie de :

  > Tu es un exécutant du hub « *nom du hub* ». Ton coordinateur est la conversation `<nom de messagerie du coordinateur>`. Quand tu as fini (ou si tu es bloqué), envoie-lui un compte rendu avec l'outil SendMessage.

- Le nom de messagerie du coordinateur est lu dans `~/.claude/sessions/` ; si le coordinateur ne tourne pas, la fenêtre l'indique et propose de l'ouvrir d'abord (le bouton reste utilisable, la ligne cite alors seulement le nom de la conversation).
- Sans coordinateur dans le hub, le bouton est grisé avec une explication.

## Comments

Fait :

- **Bouton « + Exécutant »** (`AddExecutorButton`, `src/components/Hubs.tsx`) : dans l'en-tête de la Vue Hub, et en icône (silhouette « + ») dans les actions au survol du hub dans la barre latérale (`HubActions.onAddExecutor`). Hub sans coordinateur : grisé, info-bulle « Désignez d'abord un coordinateur : c'est à lui que l'exécutant rendra compte » (`executorBlocker`, `src/hubs.ts`).
- **Fenêtre** `ExecutorDialog` (`Hubs.tsx`) : projet (liste des projets connus, non archivés, dont le dossier existe, temporaires seulement s'ils sont affichés ; par défaut celui du coordinateur, ou celui de son archive), tâche (zone de texte, Ctrl+Entrée valide), « Dans un nouveau worktree » coché par défaut avec nom facultatif vérifié par `worktreeNameError`. Projet qui n'est pas un dépôt git : case grisée et décochée, avec l'explication. Ligne « Coordinateur : *titre* (nom de messagerie `…`) » ; s'il ne tourne pas, encadré d'avertissement et bouton **Ouvrir le coordinateur** (ouvre son onglet, la fenêtre reste ouverte) ; le nom est relu toutes les 3 s tant que la fenêtre est ouverte, l'encadré disparaît donc dès que le coordinateur a démarré. Le bouton « Lancer l'exécutant » reste utilisable.
- **Nom de messagerie** : nouvelle commande `messaging_name(sessionId) -> string | null` (lib.rs, via `hubs::messaging_names`, seulement les conversations en cours d'après `~/.claude/sessions/`) ; `messagesApi.messagingName` dans `src/messages.ts`. Relu au moment de valider (il change à chaque lancement).
- **Création** (`startExecutor`, `App.tsx`) : `startNewConversation` directement (pas `newConversation`), donc pas de fenêtre « troisième conversation → worktree » ; titre provisoire = première ligne de la tâche. L'exécutant est rangé dans le hub (`hub_set_member`, rôle exécutant) dans `terminalStarted`, une fois son terminal ouvert, comme la section d'une nouvelle conversation : avant, sans fichier ni terminal, il serait retiré du hub par `prune` au scan suivant. Premier message tapé par `sendWhenReady` (comme le hand off) : `executorFirstMessage(tâche, hub, coordinateur)` (`src/hubs.ts`) = la tâche, une ligne vide, puis « Tu es un exécutant du hub « *nom* ». Ton coordinateur est la conversation `<nom de messagerie>`. Quand tu as fini (ou si tu es bloqué), envoie-lui un compte rendu avec l'outil SendMessage. » — sans nom de messagerie, la conversation est citée par son titre entre « ». Terminal qui ne démarre pas : message d'erreur, rien n'est envoyé.
- Mode dev (`devMock.ts`) : `messaging_name` renvoie un nom seulement si la conversation a un terminal fictif ouvert (essayer avec le coordinateur fermé, puis « Ouvrir le coordinateur »).
