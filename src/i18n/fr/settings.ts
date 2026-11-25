// Textes : settings (voir src/i18n/index.ts pour le format).

export default {
  "settings.title": "Réglages",
  "settings.tabsLabel": "Catégories de réglages",
  "settings.tab.display": "Affichage",
  "settings.tab.suggestions": "Suggestions",
  "settings.tab.handoff": "Hand off",
  "settings.display.showTempProjects": "Afficher les projets temporaires",
  "settings.display.showTempProjectsHelp": "Projets situés dans un dossier temporaire, masqués par défaut dans la barre latérale.",
  "settings.suggestions.help": "L'app propose une bonne pratique quand elle repère une situation (icône 💡). Elle n'agit jamais d'elle-même.",
  "settings.suggestions.thresholdBefore": "Seuil :",
  "settings.suggestions.thresholdAfter": "% du contexte",
  "settings.suggestions.staleMinutesBefore": "Inactive depuis plus de",
  "settings.suggestions.staleMinutesAfter": "minutes",
  "settings.suggestions.stalePercentBefore": "Contexte rempli à",
  "settings.suggestions.stalePercentAfter": "% ou plus",
  "settings.handoff.help": "Consigne tapée dans la conversation pour lui faire rédiger son résumé de passation. La réponse devient le premier message de la nouvelle conversation.",
  "settings.handoff.promptLabel": "Consigne du résumé de passation",
  "settings.handoff.resetDefault": "Rétablir le texte par défaut",
} as const satisfies Record<string, string>;
