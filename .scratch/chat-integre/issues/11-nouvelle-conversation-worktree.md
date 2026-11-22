# Nouvelle conversation dans un nouveau worktree

Status: ready-for-agent
Blocked by: 02, 08

## Ce qu'on veut

Quand on crée une conversation, une case **Dans un nouveau worktree** la démarre dans une copie de travail séparée du projet, avec `claude -w [nom]` (combiné à `--session-id`, comme au ticket 02).

## Comportement attendu

- La case n'est proposée que si le dossier du projet est un dépôt git.
- Nom du worktree facultatif ; sans nom, Claude Code en choisit un.
- La conversation apparaît sous son projet parent avec le badge « worktree » (ticket 08).
- Vérifier dans la doc officielle (code.claude.com/docs/en/worktrees) comment `-w` se combine avec `--session-id`, et où le worktree est créé.
