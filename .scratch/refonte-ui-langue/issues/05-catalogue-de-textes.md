# Catalogue de textes (refactoring)

Status: ready-for-agent

## Ce qu'on veut

Sortir tous les textes de l'interface du code pour pouvoir les traduire (ticket 06). Aujourd'hui ils sont tous en dur, en français, et il n'existe aucun système de traduction.

## Comportement attendu

- Un catalogue de référence en français : clé → texte, avec des variables nommées (`{count}`, `{name}`) et la gestion du pluriel.
- Une fonction de traduction simple à utiliser dans les composants (et hors React pour les modules comme `suggestions.ts` et `hubs.ts`), qui retourne le texte de la langue courante, ou le français s'il manque.
- Tous les textes visibles des composants et modules passent par le catalogue : libellés, info-bulles, fenêtres, bandeaux de suggestion, messages d'erreur.
- Messages du cœur Rust visibles par l'utilisateur : le cœur renvoie un code et ses paramètres, l'interface en fait le texte. Les journaux internes et les sorties techniques brutes (git, etc.) restent tels quels.
- **Ne pas traduire** les textes envoyés aux conversations (consigne de hand off, premier message de la suite, consignes de hub…).
- Dates relatives (`relativeDate`, `formatDate`) et nombres via `Intl`, avec la langue courante.
- Le catalogue doit pouvoir être exporté facilement (liste de clés et de textes) pour la traduction du ticket 06.

## Vérifications

- Pur refactoring : l'app en français ne change pas visuellement.
- Un test (ou un script) signale les clés utilisées dans le code mais absentes du catalogue, et l'inverse.
- Les variables d'un texte sont toutes fournies à l'appel.

## Comments
