# Les conversations tournent dans un terminal intégré qui lance le vrai `claude`, pas via l'Agent SDK

Claude Manager remplace Claude Desktop, et l'app est diffusée à d'autres personnes. Les règles d'Anthropic interdisent à une app tierce de se connecter avec un abonnement Claude.ai ou de faire passer ses requêtes par ce compte, ce qui exclut l'Agent SDK et `claude -p` sans clé d'API. Une clé d'API payée à l'usage n'est pas envisageable. Chaque conversation s'ouvre donc dans un terminal intégré à l'app, qui lance le binaire `claude` officiel tel quel (`claude --resume <id>`). L'utilisateur s'y connecte avec son propre abonnement, et l'app ne lit ni ne transmet jamais ses identifiants.

## Options écartées

- **Agent SDK ou `claude -p` avec l'abonnement** : aurait permis une interface graphique façon Desktop, mais interdit pour une app diffusée.
- **Agent SDK avec une clé d'API** : conforme, mais coût à l'usage refusé.
- **Organiseur seul, discussion dans Desktop** : conforme, mais l'app ne remplace plus Desktop. Un bouton « Ouvrir dans Desktop » a été essayé puis retiré : une fois la conversation affichée dans l'app, il ne servait plus. Les conversations restent compatibles : Desktop peut les reprendre de lui-même.

## Conséquences

- Le terminal est caché derrière une interface propre à l'app : la conversation est affichée à partir de son `.jsonl`, et une zone de saisie envoie le texte au terminal. Le terminal remonte dès que Claude Code attend une interaction (permission, menu, question de confiance). L'app ne répond jamais elle-même à une demande de permission : c'est l'utilisateur qui valide, dans le terminal.
- Claude Manager lance chaque conversation avec `--settings`, qui ajoute des hooks pour cette conversation seulement, sans toucher aux réglages de l'utilisateur. Ces hooks signalent l'état de l'agent à l'app. Une nouvelle conversation est lancée avec `--session-id`, pour que l'app connaisse son identifiant dès le départ.
- La question de confiance de Claude Code s'affiche dans le terminal intégré, une fois par dossier.
