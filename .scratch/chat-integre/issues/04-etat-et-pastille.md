# État des conversations et pastille d'activité

Status: ready-for-agent
Blocked by: 01

## Ce qu'on veut

Chaque conversation affiche son **état** par une pastille colorée : *en cours* (l'agent travaille), *attend ta réponse* (l'agent a besoin de l'utilisateur : permission, question, fin de tour), *terminée* (pas de terminal ouvert). Le projet et la catégorie affichent un compteur des conversations en cours et de celles qui attendent une réponse.

## Comment

- L'app lance chaque conversation avec `--settings <fichier>` : un fichier de réglages généré par l'app, qui ajoute des hooks à cette conversation seulement. Ne jamais modifier les réglages de l'utilisateur.
- Les hooks appellent l'exécutable de Claude Manager lui-même avec une sous-commande (par exemple `claude-manager.exe hook`). Elle lit le JSON du hook sur son entrée et écrit l'état dans `%APPDATA%\claude-manager\state\<id>.json`. L'app surveille ce dossier, comme elle surveille déjà `.claude\projects`. Pas de réseau, pas de port local.
- Vérifier dans la doc officielle des hooks (code.claude.com/docs/en/hooks) quels événements utiliser. Candidats : `UserPromptSubmit` et `PreToolUse` (en cours), `Notification` et la demande de permission (attend ta réponse), `Stop` (fin de tour, attend ta réponse).
- Les hooks doivent rester très rapides et ne jamais bloquer Claude Code : toujours terminer avec succès, même si l'écriture échoue.
- Une conversation dont le terminal intégré est fermé est *terminée*, quoi que dise le dernier fichier d'état.

## Fait quand

- La pastille passe à *en cours* quand on envoie un message, à *attend ta réponse* quand l'agent demande une permission ou finit son tour, sans délai visible.
- Les compteurs du projet et de la catégorie suivent.
- Les hooks déjà configurés par l'utilisateur continuent de fonctionner.
