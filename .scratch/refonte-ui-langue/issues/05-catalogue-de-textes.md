# Catalogue de textes (refactoring)

Status: resolved

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

Fait (681 clés) :
- `src/i18n/index.ts` : `t(key, vars)`, sous-ensemble d'ICU (`{var}`, `plural`, `select`), `useLanguage()` (appelé en tête d'`App`), `locale()`, `setLanguage(code, dict)`, `hasKey`, `variablesOf` (pour contrôler les traductions du ticket 06). `src/i18n/rich.tsx` : `tRich` (variables remplacées par des éléments React) et `tSplit` (texte avant / après une variable).
- Catalogue `src/i18n/fr/<zone>.ts` (common, app, project, sidebar, hubs, conversation, settings, suggestions, slash, tools, handoff, errors), assemblé dans `src/i18n/fr.ts`. Contrôle : `npm run i18n:check` (préfixes, doublons, clés inutilisées).
- Dates et nombres via `Intl` dans la langue courante (`formatDate`, `relativeDate`, limites d'usage, pied de conversation).
- Rust : erreurs visibles codées (`ui_error.rs`, `ui_err(code, params)` → `{"uiError":…}`), affichées par `errorMessage()` avec la clé `error.<code>`. `SESSION_ACTIVE` devient le code `actions.sessionActive` (`isUiError`). Notices « compactée » / « interrompu » avec un champ `code`, détail TodoWrite et titre de repli « Session xxxx » traduits côté interface. Restent en français par choix : textes envoyés à Claude (hand off, premier message d'exécutant, contexte de hub), ligne d'état de Claude Code (`limits.rs`), erreur développeur d'`attachments.rs`.
- Commandes `/…` intégrées : descriptions et indications d'arguments copiées dans `slash.builtin.<nom>` (`.hint`), utilisées si la clé existe.

Écarts volontaires en français (accords corrigés par les pluriels ICU) : « 1 ligne ignorée » au lieu de « 1 ligne(s) ignorée(s) », « 1 ligne » au lieu de « 1 lignes », « 0 question en attente » au lieu de « 1 question », première lettre en majuscule dans « Cette conversation a été modifiée… ». Laissés tels quels (à reprendre si on veut) : « Ses {count} projet(s)… », « … et {count} autre(s) ».

Limite connue : le texte autour d'un champ numérique des réglages (« Seuil : » / « % du contexte ») est en deux clés ; un traducteur ne peut pas changer l'ordre autour du champ.
