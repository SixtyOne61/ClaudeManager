# Hubs de conversations

Vocabulaire : voir [GLOSSARY.md](../../GLOSSARY.md) (*Hub*, *Coordinateur*, *Exécutant*, *Message entre conversations*, *Nom de messagerie*). Décision : [ADR 0002](../../docs/adr/0002-observer-la-messagerie-de-claude-code.md).

## Objectif

Faire travailler plusieurs conversations ensemble et le voir dans l'interface : un coordinateur confie des tâches longues à des exécutants qu'on peut suivre et piloter un par un, ou des pairs s'interrogent entre eux.

## Principes

- **L'app affiche, Claude Code transporte.** Les messages passent par la messagerie de Claude Code (`SendMessage`, `<cross-session-message>`). L'app les lit dans les `.jsonl` et relie les noms de messagerie aux conversations grâce à `~/.claude/sessions/<pid>.json`. Aucun token dépensé par l'app.
- **Une conversation reste dans son projet.** Le hub y renvoie ; une icône 🔗 signale l'appartenance à un hub.
- **Un hub peut mêler des projets différents.**
- **Au plus un coordinateur** par hub ; sans coordinateur, les membres sont des pairs.
- L'app n'agit que sur un clic (ADR 0002).

## Données (dans `config.json`)

Un hub : identifiant, nom, couleur facultative, membres (identifiant de conversation + rôle `coordinateur` | `executant` | `pair`), date de création, archivé ou non.

## Tickets

| Ticket | Sujet |
| --- | --- |
| 01 | Hub : modèle et barre latérale |
| 02 | Vue Hub et bulles de messages entre conversations |
| 03 | « + Exécutant » |
| 04 | Suggérer un hub quand deux conversations ont échangé |

Lien avec les suggestions : lors d'un hand off d'un membre (`.scratch/suggestions/issues/02-hand-off.md`), la suite prend la place et le rôle de la parente dans le hub, et l'app ajoute au résumé de passation la liste des membres du hub avec la consigne de les prévenir de son nouveau nom de messagerie.

## Hors périmètre

- Un serveur MCP pour que le coordinateur lance lui-même ses exécutants (à décider dans un ADR dédié).
- Envoyer un message d'une conversation à une autre depuis l'interface de l'app.
