# Suggestions de bonnes pratiques

Vocabulaire : voir [GLOSSARY.md](../../GLOSSARY.md) (*Suggestion*, *Hand off*, *Résumé de passation*). Décisions : [ADR 0001](../../docs/adr/0001-terminal-integre-plutot-que-agent-sdk.md), [ADR 0002](../../docs/adr/0002-observer-la-messagerie-de-claude-code.md).

## Objectif

L'app repère des situations où une bonne pratique s'impose et la propose, sans jamais agir seule. La détection est faite entièrement par l'app, sans dépenser de token.

## Principes

- **Suggérer, ne pas agir.** Une suggestion s'affiche (icône 💡 dans la barre latérale, bandeau dans l'onglet) ; l'action ne part que sur un clic.
- **Ignorer** une suggestion la masque pour cette conversation jusqu'au palier suivant de la règle.
- Chaque règle peut être coupée dans les réglages.
- Aucun appel à un modèle pour détecter : seulement les données déjà disponibles (ligne d'état, hooks, `.jsonl`, terminaux ouverts).

## Règles de la première version

| Règle | Déclencheur | Action proposée |
| --- | --- | --- |
| Contexte rempli | ≥ 60 % du contexte (réglable), paliers suivants 80 % et 90 % | Hand off |
| Troisième conversation dans le même dossier | Création d'une conversation alors que ≥ 2 conversations du même dossier (hors worktree) ont leur terminal intégré ouvert | Démarrer dans un worktree |

L'encart des limites d'utilisation passe en plus du vert à l'orange puis au rouge (ce n'est pas une suggestion, seulement une couleur).

## Tickets

| Ticket | Sujet |
| --- | --- |
| 01 | Contexte de chaque conversation et suggestion de hand off |
| 02 | Hand off |
| 03 | Couleurs de l'encart des limites |
| 04 | Proposer un worktree à la troisième conversation |

## Hors périmètre

- Détecter qu'une tâche sera « grosse » avant de l'envoyer (demanderait un modèle).
- Règles « conversation compactée plusieurs fois » et « conversation inactive depuis X jours » : le moteur doit permettre de les ajouter plus tard.
- Lancer un hand off automatiquement.
