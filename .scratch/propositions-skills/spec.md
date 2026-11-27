# Propositions de skills

Vocabulaire : voir [GLOSSARY.md](../../GLOSSARY.md) (*Terminer*, *Analyse de fin de conversation*, *Proposition de skill*). Décisions : [ADR 0001](../../docs/adr/0001-terminal-integre-plutot-que-agent-sdk.md), [ADR 0002](../../docs/adr/0002-observer-la-messagerie-de-claude-code.md), [ADR 0003](../../docs/adr/0003-analyse-de-fin-dans-le-terminal-integre.md).

## Objectif

Repérer les demandes que l'utilisateur fait souvent à Claude, et lui proposer d'en faire des skills. La récolte se fait en fin de conversation, quand l'utilisateur la ferme avec **Terminer**. La revue est groupée et espacée : au plus une fois tous les X jours, et seulement quand une demande est revenue au moins Y fois.

## Principes

- **Terminer est facultatif.** La croix de l'onglet garde son rôle de fermeture simple, sans analyse.
- **L'analyse tourne dans la conversation elle-même** (ADR 0003). Elle suit le modèle du résumé de passation : l'app tape la question, attend la fin du tour, puis lit la réponse dans le `.jsonl`. Elle utilise le modèle de la conversation, sans `/model`, pour profiter du cache de prompt.
- **Le rattachement se fait au fil de l'eau.** La question envoie à Claude les propositions déjà connues, et Claude rattache la demande à l'une d'elles ou en crée une nouvelle. Le comptage ne coûte donc aucun appel au modèle.
- **L'app n'agit jamais d'elle-même** (ADR 0002). Le rappel est une icône 💡, et la création d'un skill part d'un clic.

## Bouton Terminer

- Il se place dans la barre d'outils de la conversation, à côté de Hand off.
- Il n'est actif que dans l'état *à toi*, et grisé sinon, avec la même explication que Hand off.
- Si l'analyse est coupée dans les réglages, il ferme simplement l'onglet.

## Analyse de fin de conversation

1. L'onglet disparaît tout de suite. Le terminal intégré reste vivant, sans être affiché.
2. L'app tape la question. Elle commence par `[Analyse de fin de conversation]` et contient :
   - la liste des skills et commandes déjà disponibles pour ce dossier ;
   - les propositions en attente, refusées ou déjà créées (id, nom, description) ;
   - le contrat de réponse ci-dessous.
3. L'app attend la fin du tour, lit la réponse dans le `.jsonl`, l'enregistre, puis arrête le terminal.
4. Pendant l'analyse, la conversation affiche un indicateur « analyse… » dans la barre latérale.
5. L'analyse est abandonnée, puis le terminal arrêté, dans quatre cas :
   - l'utilisateur rouvre la conversation (elle se relance alors normalement) ;
   - 3 minutes passent sans réponse ;
   - le tour se termine en erreur ;
   - l'app est quittée.
   Un échec est ignoré en silence.

Contrat de réponse : un seul objet JSON, de l'une de ces formes.

```json
{"verdict":"aucun"}
{"verdict":"existant","proposition":"<id>","resume":"…"}
{"verdict":"nouveau","nom":"…","description":"…","resume":"…"}
```

- **Critère donné à Claude :** une tâche répétable, avec des étapes, des conventions ou un savoir qui ne se devinent pas. Une simple question ponctuelle ne compte pas, ni une demande déjà couverte par un skill existant.
- **Taille :** il n'y a pas de minimum de taille de conversation.
- **Réponse invalide** (pas de JSON, id inconnu) : elle est ignorée.

## Stockage

Le fichier séparé `%APPDATA%\claude-manager\skill-proposals.json`, écrit de façon atomique, contient :

- **Proposition** : id, nom, description, statut (`pending`, `refused` ou `created`), date de création et occurrences.
- **Occurrence** : date, projet, id de la conversation et résumé de la demande. Pour une conversation en worktree, le projet est celui du dossier parent.
- **Dernière revue** : la date du dernier passage dans la fenêtre « Skills proposés ».

Règles :

- Les occurrences de plus de X jours sont purgées, et une proposition en attente sans occurrence disparaît.
- Une demande rattachée à une proposition refusée ou déjà créée n'est pas comptée. Ces propositions sont gardées pour ne jamais être reproposées.

## Rappel

- **Vérification :** au démarrage, toutes les heures, et après chaque analyse.
- **Condition :** la dernière revue date d'au moins X jours (ou n'a jamais eu lieu), **et** au moins une proposition en attente compte Y occurrences ou plus.
- **Affichage :** une icône 💡 « Skills proposés » dans la barre des onglets. Elle ne s'ouvre jamais d'elle-même.
- **La fenêtre « Skills proposés »** liste les propositions qui atteignent le seuil, avec trois boutons : **Créer**, **Refuser** et **Plus tard**. Elle est aussi accessible à tout moment depuis le menu « … » de la barre latérale. Elle montre alors en plus les propositions sous le seuil.
- **Ouvrir la fenêtre** enregistre la date de la revue.

## Création d'un skill

- **Portée proposée :** le projet (`.claude/skills/`) si toutes les occurrences viennent du même projet, sinon l'utilisateur (`~/.claude/skills/`). L'utilisateur peut la changer dans la fenêtre.
- **Créer** ouvre une nouvelle conversation, avec un premier message tapé pour l'utilisateur :
  - le dossier est celui du projet visé, ou celui de l'occurrence la plus récente pour un skill utilisateur ;
  - le message contient l'invocation de `/skill-creator`, la description, la portée et les résumés des occurrences.
- La proposition passe alors en `created`.

## Réglages (onglet « Skills »)

| Réglage | Défaut | Bornes |
| --- | --- | --- |
| Analyse à la fermeture via Terminer | activée | — |
| X : fenêtre et intervalle de rappel, en jours | 7 | 1 à 60 |
| Y : occurrences pour proposer un skill | 3 | 2 à 20 |

## Tickets

| Ticket | Sujet |
| --- | --- |
| 01 | Propositions : stockage, rattachement, seuil, question et réglages (backend) |
| 02 | Bouton Terminer et analyse de fin de conversation |
| 03 | Rappel, fenêtre « Skills proposés » et création d'un skill |
| 04 | Onglet « Skills » des réglages |

## Hors périmètre

- Écrire le skill sans conversation (la relecture par l'utilisateur est voulue).
- Analyser les conversations fermées par la croix, ou les anciennes conversations.
- Changer de modèle pour l'analyse.
