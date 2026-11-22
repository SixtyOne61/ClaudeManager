# Recherche dans le contenu de toutes les conversations

Status: ready-for-agent

## Ce qu'on veut

Une recherche globale qui trouve une conversation à partir d'un mot de son contenu, dans tous les projets. Aujourd'hui, `search_sessions` ne cherche que dans un projet, et dans tout le texte brut du fichier.

## Comportement attendu

- Cherche dans les messages de l'utilisateur et dans les réponses de l'agent, pas dans les résultats d'outils ni dans les lignes techniques.
- Les résultats sont groupés par projet, avec le titre de la conversation et un extrait autour du mot trouvé, mis en évidence.
- Cliquer sur un résultat ouvre la conversation (ticket 05 : faire défiler jusqu'au message trouvé, quand ce ticket est fait).
- Inclut les conversations archivées, signalées comme telles.
- Reste rapide sur de gros historiques : les fichiers peuvent dépasser 10 Mo. Lecture en parallèle comme aujourd'hui, et un index en cache si la lecture directe prend plus d'une seconde sur l'historique réel (`cargo test --release real_scan -- --ignored --nocapture` pour mesurer).
- Insensible à la casse et aux accents.
