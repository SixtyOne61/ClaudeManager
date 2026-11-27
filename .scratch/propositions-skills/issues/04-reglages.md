# Onglet « Skills » des réglages

Status: resolved
Blocked by: 01

## Ce qu'on veut

L'utilisateur règle l'analyse et le rappel.

## Comportement attendu

- Un nouvel onglet « Skills » dans les réglages, avec :
  - une case « Analyser la conversation quand je clique sur Terminer » ;
  - X, en jours, de 1 à 60 ;
  - Y, en occurrences, de 2 à 20.
- Chaque changement est enregistré tout de suite.

## Vérifications

- `npm run build` et `npm run i18n:check`.

## Comments

Fait : onglet « Skills » dans `Settings.tsx`.
