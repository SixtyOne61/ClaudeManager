// Textes : handoff (voir src/i18n/index.ts pour le format).
// La consigne du résumé de passation (DEFAULT_HANDOFF_PROMPT) est envoyée à la conversation :
// elle reste dans src/handoff.ts, non traduite.

export default {
  "handoff.blocker.running": "Hand off en cours…",
  "handoff.blocker.unavailable": "Disponible quand l'agent a fini son tour",
  "handoff.failed.impossible": "Hand off impossible : {error}",
  "handoff.failed.terminalClosed": "Hand off annulé : le terminal de la conversation s'est fermé.",
  "handoff.failed.turnError": "Hand off annulé : une erreur a interrompu la rédaction du résumé de passation.",
  "handoff.failed.emptySummary": "Hand off annulé : la réponse de l'agent est vide, aucune conversation n'a été créée.",
} as const satisfies Record<string, string>;
