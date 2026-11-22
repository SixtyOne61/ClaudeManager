# Conversations de worktree sous leur projet parent

Status: ready-for-agent

## Ce qu'on veut

Une conversation dont le dossier est un worktree (par exemple `WorkAtHome\.claude\worktrees\amazing-chatelet-759adf`) est rangée sous son projet parent (`WorkAtHome`), avec un badge « worktree ». Aujourd'hui, chaque worktree apparaît comme un projet à part, parce qu'il a son propre dossier dans `.claude\projects`.

## Comportement attendu

- Le projet parent se déduit du `cwd` de la conversation : la partie avant `\.claude\worktrees\`. Les worktrees créés ailleurs (`git worktree list`) sont hors périmètre pour cette version.
- Le badge donne le nom du worktree. Si le dossier du worktree n'existe plus, le badge le signale (« worktree supprimé »).
- L'archivage, la corbeille, la recherche et les sections fonctionnent pour ces conversations comme pour les autres. Leur fichier reste là où Claude Code l'a mis.
- Les anciennes entrées de `config.json` qui rangeaient un worktree comme projet dans une catégorie sont nettoyées sans erreur.

## Fait quand

- Les worktrees de `WorkAtHome` n'apparaissent plus comme des projets, et leurs conversations sont sous `WorkAtHome` avec un badge.
