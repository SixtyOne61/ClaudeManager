# Interface de conversation par-dessus le terminal

Status: ready-for-agent
Blocked by: 01, 04

## Ce qu'on veut

Le terminal intégré est caché derrière une interface dessinée par l'app, proche de celle de Desktop. Le terminal remonte uniquement quand Claude Code attend une interaction.

## Comportement attendu

- **Affichage.** La conversation est lue dans son `.jsonl`, mis à jour en direct : messages de l'utilisateur, réponses de l'agent (Markdown), et une carte par action de l'agent (commande lancée et sa sortie, fichier lu, fichier modifié avec la différence de code). Les résultats d'outils trop longs sont repliés.
- **Saisie.** Une zone de saisie en bas envoie le texte au terminal, puis Entrée. Les commandes `/…` sont envoyées telles quelles. Le texte sur plusieurs lignes doit arriver en un seul message dans Claude Code (utiliser le collage encadré du terminal, « bracketed paste », plutôt que des Entrée successives).
- **Interruption.** Un bouton **Arrêter** envoie Échap au terminal.
- **Le terminal remonte tout seul** quand l'état passe à *attend ta réponse* pour une permission ou une question (ticket 04), quand une commande `/…` ouvre un menu, et à la question de confiance d'un nouveau dossier. Il redescend dès que l'agent reprend son travail.
- **Bouton Voir le terminal**, toujours disponible.
- Ce que l'interface ne sait pas afficher (type de ligne inconnu) n'empêche rien : la ligne est ignorée à l'écran et reste visible dans le terminal.
- Le format des lignes `.jsonl` est interne à Claude Code et peut changer : lecture tolérante, comme dans `sessions.rs`.

## Risques à lever en premier

- Savoir quand un menu interactif est ouvert sans hook pour le signaler. Commencer simple : toute commande `/…` envoyée depuis la zone de saisie fait remonter le terminal.
- Les fichiers de conversation peuvent dépasser 10 Mo : relire seulement la fin du fichier à chaque changement.

## Fait quand

- On mène une conversation entière depuis la zone de saisie. Le terminal n'apparaît que pour valider une permission, puis redescend.
