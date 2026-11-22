# Chat intégré : Claude Manager remplace Claude Desktop

Vocabulaire : voir [GLOSSARY.md](../../GLOSSARY.md). Décision d'architecture : [ADR 0001](../../docs/adr/0001-terminal-integre-plutot-que-agent-sdk.md).

## Objectif

On discute avec l'agent directement dans Claude Manager, sur les mêmes conversations que Claude Desktop et le terminal. L'app apporte en plus son organisation : catégories, sections, couleurs, recherche dans le contenu, et l'état de chaque conversation d'un coup d'œil.

## Principes

- **Le vrai Claude Code, tel quel.** Chaque conversation tourne dans un terminal intégré qui lance le binaire `claude` officiel, connecté avec l'abonnement de l'utilisateur. L'app ne lit, ne stocke ni ne transmet jamais ses identifiants. Pas d'Agent SDK, pas de `claude -p`, pas de clé d'API.
- **Une interface par-dessus le terminal.** L'app dessine la conversation à partir de son `.jsonl` (messages, actions de l'agent, différences de code). Une zone de saisie envoie le texte au terminal, qui reste caché. Le terminal remonte dès que Claude Code attend une interaction : permission, menu, question de confiance. Un bouton **Voir le terminal** l'affiche à tout moment.
- **L'utilisateur valide toujours lui-même.** L'app ne répond jamais à une demande de permission ou de confiance à sa place.
- **Compatibilité totale.** Toute conversation se reprend dans Claude Desktop (bouton **Ouvrir dans Desktop**, `claude --desktop --resume <id>`) ou dans un terminal externe, et inversement. Les conversations restent dans `~/.claude/projects`, que l'app ne modifie que par l'archivage et la corbeille, comme aujourd'hui.
- **Les réglages de l'utilisateur ne sont jamais modifiés.** Ce que l'app ajoute à Claude Code (les hooks de suivi d'état) passe par `--settings`, pour la conversation lancée uniquement. L'app ne modifie ni `~/.claude.json` ni `settings.json`.
- **La fenêtre reste sans accès réseau.** Le terminal et l'interface sont locaux ; la politique de sécurité de la fenêtre ne change pas.

## Première version

| Ticket | Sujet |
| --- | --- |
| 01 | Terminal intégré pour reprendre une conversation |
| 02 | Nouvelle conversation dans le terminal intégré |
| 03 | Ouvrir dans Desktop |
| 04 | État des conversations et pastille d'activité |
| 05 | Interface de conversation par-dessus le terminal |
| 06 | Sections dans un projet |
| 07 | Couleur par conversation |
| 08 | Conversations de worktree sous leur projet parent |
| 09 | Avertissement « peut-être ouverte ailleurs » à la reprise |
| 10 | Recherche dans le contenu de toutes les conversations |
| 11 | Nouvelle conversation dans un nouveau worktree |
| 12 | Mettre à jour le README |

## Hors périmètre

- Répondre aux demandes de permission avec des boutons de l'app (option écartée, voir ADR 0001).
- Synchroniser l'organisation de Claude Desktop (ses groupes, épingles, titres) : l'organisation de Claude Manager lui est propre.
- Sections imbriquées.
- Recherche dans les résultats d'outils.
