# L'analyse de fin de conversation tourne dans le terminal intégré de la conversation, pas dans un `claude -p` à part

Pour repérer les demandes qui méritent un skill, l'app pose une dernière question à la conversation quand l'utilisateur clique sur **Terminer**. Cette question pourrait partir dans un `claude -p --resume <id> --fork-session` lancé en arrière-plan, sur une copie de la conversation. Ce serait contraire à l'ADR 0001, qui interdit `claude -p` avec l'abonnement.

L'app suit donc le modèle du résumé de passation :

1. L'onglet disparaît, mais le terminal intégré reste vivant sans être affiché.
2. L'app y tape la question comme l'utilisateur l'aurait fait, ce qui reste dans l'esprit de l'ADR 0002 puisque tout part de son clic.
3. Elle attend la fin du tour, lit la réponse dans le `.jsonl`, puis arrête le terminal.

La question utilise le modèle de la conversation. Son contexte vient d'être utilisé, donc il est encore dans le cache de prompt, et aucun `/model` n'est tapé, ce qui pourrait changer le modèle par défaut de l'utilisateur.

## Options écartées

- **`claude -p --resume <id> --fork-session`** : la conversation reste propre, mais c'est interdit par l'ADR 0001, et la copie créée sur le disque devrait être cachée puis supprimée.
- **Changer de modèle pour l'analyse** (Haiku) : le contexte serait relu sans cache, donc pour un coût voisin et un jugement moins sûr. Il faudrait aussi taper `/model`, avec un effet de bord sur la session.

## Conséquences

- La question `[Analyse de fin de conversation]` et sa réponse restent dans la conversation. On les revoit si on la reprend.
- Le processus `claude` survit quelques secondes à quelques dizaines de secondes après la fermeture de l'onglet. Rouvrir la conversation pendant l'analyse l'annule.
- La question demande de ne lancer aucun outil. Si une permission est quand même demandée, le terminal n'est pas affiché pour y répondre : l'analyse est abandonnée au bout de 3 minutes.
