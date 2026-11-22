# Couleur par conversation

Status: ready-for-agent

## Ce qu'on veut

Comme les catégories et les projets, chaque conversation peut avoir sa couleur, choisie avec le sélecteur existant.

## Comportement attendu

- La couleur se voit dans la liste des conversations et sur l'onglet de la conversation ouverte.
- Le texte reste lisible quelle que soit la couleur (le contraste automatique existe déjà dans `util.ts`).
- La couleur ne se confond pas avec la pastille d'activité (ticket 04) : la pastille garde ses propres couleurs, à un autre endroit.
- La couleur est conservée à l'archivage et à la restauration.

## Données

Dans `config.json`, une table « id de conversation → préférences » (couleur, et la place pour d'autres préférences plus tard).
