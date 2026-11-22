# Ouvrir dans Desktop

Status: ready-for-agent

## Ce qu'on veut

Un bouton **Ouvrir dans Desktop** sur chaque conversation, qui la rouvre dans Claude Desktop avec tout son contexte, via `claude --desktop --resume <id>`.

## Comportement attendu

- La commande est lancée sans fenêtre visible, depuis le dossier de la conversation s'il existe encore, sinon depuis le dossier du projet.
- Si la conversation est ouverte dans un terminal intégré, prévenir : Claude Code refuse de transférer une conversation ouverte ailleurs. Proposer de fermer le terminal intégré d'abord.
- Si la commande échoue (Desktop absent, version de Claude Code trop ancienne : il faut 2.1.285 ou plus, connexion autre qu'un abonnement), afficher le message d'erreur de Claude Code tel quel, et proposer « Ouvrir dans un terminal externe » à la place.
- Si le worktree de la conversation a été supprimé, prévenir que Desktop affichera « Failed to load session ».

## Fait quand

- Depuis l'app, une conversation existante s'ouvre dans Desktop, avec son historique.
