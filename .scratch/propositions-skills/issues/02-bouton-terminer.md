# Bouton Terminer et analyse de fin de conversation

Status: resolved
Blocked by: 01

## Ce qu'on veut

Un bouton **Terminer** ferme la conversation et lance l'analyse de fin de conversation.

## Comportement attendu

- **Bouton :** il est dans la barre d'outils de la conversation. Il n'est actif que dans l'état *à toi*, sinon grisé avec une explication.
- **Analyse coupée :** le bouton ferme simplement l'onglet, comme la croix.
- **Analyse active :**
  - l'onglet disparaît sans arrêter le terminal ;
  - `src/skills.ts` tape la question (`skills_analysis_prompt`), attend la fin du tour, puis appelle `skills_record` avec quelques relectures ;
  - le terminal est ensuite arrêté.
- **Abandon :** au bout de 3 minutes, si le tour finit en erreur, ou si l'utilisateur rouvre la conversation. Dans ce dernier cas, le terminal est arrêté puis relancé normalement.
- **Indicateur :** « analyse… » sur la conversation dans la barre latérale.

## Vérifications

- `npm run build` et `npm run i18n:check`.

## Comments

Fait : `src/skills.ts` (runAnalysis, cancelAnalysis, useAnalysing). Le bouton est dans la barre d'outils de `TerminalView`, avec la même règle d'activation que Hand off. Pendant l'analyse, `setActivityHidden` (`src/activity.ts`) fait apparaître la conversation comme fermée : pas de pastille, pas de confirmation en quittant l'app. Le badge « analyse… » est dans la barre latérale. La réouverture passe par `openInTerminal`, qui annule l'analyse puis relance la conversation.
