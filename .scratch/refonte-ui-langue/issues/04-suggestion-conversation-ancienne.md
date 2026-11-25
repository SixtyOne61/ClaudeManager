# Suggestion « conversation ancienne »

Status: resolved

## Ce qu'on veut

Prévenir l'utilisateur, quand il reprend une conversation ancienne au contexte chargé, que son prochain message fera relire tout le contexte au prix fort (cache expiré, contexte peut-être périmé), et lui proposer un hand off.

Système existant : règles dans `src-tauri/src/suggestions.rs` (`RULES`) et `src/suggestions.ts` (`SUGGESTION_RULES`), bandeau avec bouton d'action et « Ignorer », hand off dans `src/handoff.ts`.

## Comportement attendu

- Nouvelle règle « Conversation ancienne ».
- Déclencheur : la **première touche tapée** dans le terminal intégré d'une conversation, si sa dernière activité date de plus de **X** (1 h par défaut) et que son contexte dépasse **Y %** (30 % par défaut). Rien à la simple ouverture.
- Ne bloque pas la frappe : la touche part normalement et le bandeau apparaît.
- Texte franc, par exemple : « Cette conversation date de 3 h : ton prochain message fera relire tout son contexte (45 %). Un hand off la relit une seule fois et repart léger. »
- Bouton d'action « Hand off » (même parcours que le hand off existant), et « Ignorer » : le bandeau ne revient plus pour cette conversation tant qu'elle reste ouverte.
- Onglet Suggestions des réglages : la règle peut être désactivée, X (durée) et Y (%) sont réglables, avec des bornes raisonnables.
- La détection d'activité tient compte de l'activité dans l'app (une conversation dont on vient de recevoir une réponse n'est pas ancienne).

## Vérifications

- Tests de la règle : seuils, désactivation, « Ignorer ».
- Ouvrir une vieille conversation sans taper : pas de bandeau. Taper : bandeau. Ignorer puis retaper : pas de bandeau.

## Comments

Fait :
- Règle `RULE_STALE = "stale"` détectée côté interface (`src/suggestions.ts`) : `noteTyping(id, cfg)` à chaque frappe (xterm hors séquences d'échappement, zone de saisie). Ancienneté = `ContextInfo.at` (dernière réponse relevée par la ligne d'état). Les suggestions locales sont fusionnées avec celles du backend (`rebuild`), donc 💡 et bandeau sans changement.
- Bandeau : texte franc avec ancienneté et pourcentage, action « Hand off » (retire le bandeau), « Ignorer » non enregistré (`isLocalSuggestion` → `dismissStale`) : plus de bandeau tant que la conversation reste ouverte ; `forgetStale` au démontage du terminal.
- Réglages : `staleMinutes` (60, 5 à 10 080) et `stalePercent` (30, 5 à 95) dans `config.suggestions`, ajoutés aussi à `SuggestionSettings` côté Rust (sinon perdus à l'enregistrement) ; champs `NumberSetting` dans l'onglet Suggestions.
- Test Rust : valeurs par défaut quand les champs manquent. Pas de test côté interface : le projet n'a pas d'outil de test JS.
