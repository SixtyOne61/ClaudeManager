# Terminal intégré pour reprendre une conversation

Status: ready-for-agent

## Ce qu'on veut

Cliquer sur une conversation l'ouvre dans un terminal intégré à Claude Manager, qui lance `claude --resume <id>` dans le dossier de la conversation. Aujourd'hui, **Reprendre** ouvre Windows Terminal à l'extérieur de l'app (`actions.rs`, `launch_claude`).

## Comportement attendu

- Le terminal est un vrai terminal : couleurs, curseur, raccourcis clavier, copier-coller, redimensionnement qui suit la fenêtre.
- Chaque conversation ouverte garde son terminal. On passe d'une conversation à l'autre sans arrêter celle d'avant : les conversations ouvertes apparaissent comme des onglets.
- Si `claude` se termine (l'utilisateur tape `/exit`, ou erreur), l'onglet l'indique et propose de relancer.
- Fermer l'app : si un terminal tourne encore, demander confirmation, puis arrêter tous les terminaux proprement.
- Le dossier passé au terminal est écrit sous une forme unique (barres obliques inverses, lettre de lecteur constante), pour que la question de confiance de Claude Code ne revienne pas à cause d'une simple différence d'écriture du chemin.
- Si `claude` est introuvable, un message clair explique comment l'installer.
- L'action actuelle qui ouvre un terminal externe reste disponible dans le menu de la conversation (« Ouvrir dans un terminal externe »).

## Pistes

- Côté Rust : un pseudo-terminal Windows (ConPTY), par exemple avec la crate `portable-pty`. Lire la sortie dans un thread et l'envoyer à l'interface par des événements Tauri ; recevoir les frappes et les changements de taille par des commandes.
- Côté interface : `@xterm/xterm` avec l'extension d'ajustement de taille. Tout est empaqueté localement : la politique de sécurité de la fenêtre ne change pas.
- Garder les terminaux dans l'état de l'app, indexés par identifiant de conversation.

## Fait quand

- On reprend une vraie conversation dans l'app, on discute, on passe à une autre conversation et on revient : rien n'est perdu.
- Fermer l'app avec un agent en cours demande confirmation.
- `npm run dev` (navigateur, données fictives) affiche un faux terminal, pour pouvoir travailler l'interface sans Claude.
