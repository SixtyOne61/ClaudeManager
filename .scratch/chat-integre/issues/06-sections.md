# Sections dans un projet

Status: ready-for-agent

## Ce qu'on veut

Dans un projet, l'utilisateur regroupe ses conversations en **sections**, propres à Claude Manager (voir GLOSSARY.md).

## Comportement attendu

- Créer, renommer, supprimer, réordonner des sections dans un projet.
- Glisser-déposer une conversation dans une section, ou vers « Sans section ».
- Les conversations sans section s'affichent en haut, sous « Sans section ».
- Pas de sections dans des sections.
- Chaque section a une couleur facultative, choisie avec le sélecteur existant.
- Supprimer une section ne supprime pas ses conversations : elles retournent dans « Sans section ».
- Une conversation archivée puis restaurée retrouve sa section si celle-ci existe encore.
- Une section peut être repliée.

## Données

Dans `config.json`, sous les préférences du projet : la liste ordonnée des sections (id, nom, couleur, ids des conversations). Monter `CONFIG_VERSION` et migrer l'ancien format sans perte.

## Fait quand

- Les sections survivent au redémarrage de l'app, et une conversation qui n'existe plus est retirée de sa section sans erreur.
