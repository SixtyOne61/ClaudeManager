# Nouvelle conversation dans le terminal intégré

Status: ready-for-agent
Blocked by: 01

## Ce qu'on veut

**Nouvelle conversation** lance `claude --session-id <uuid>` dans le terminal intégré, dans le dossier du projet. L'app génère l'identifiant elle-même : elle connaît la conversation dès le départ, sans attendre que son fichier `.jsonl` apparaisse.

## Comportement attendu

- La conversation apparaît tout de suite dans la liste du projet, avec un titre provisoire (« Nouvelle conversation »), remplacé par le vrai titre dès que le fichier l'indique.
- Si une section est sélectionnée, la nouvelle conversation y est rangée ; sinon dans « Sans section » (dépend du ticket 06 : tant qu'il n'est pas fait, ignorer les sections).
- Fonctionne aussi pour un projet créé depuis l'app qui n'a encore aucune conversation.
- Si l'utilisateur ferme le terminal avant d'avoir envoyé un message, aucun fichier n'existe : la conversation provisoire disparaît de la liste.

## Fait quand

- Créer une conversation, envoyer un message, la fermer, la rouvrir : c'est la même conversation, au même endroit dans la liste.
