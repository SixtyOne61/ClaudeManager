# Proposer un worktree à la troisième conversation

Status: resolved

## Ce qu'on veut

Quand on crée une conversation alors que deux conversations ou plus du même dossier ont déjà leur terminal intégré ouvert, l'app propose de la démarrer dans un worktree.

## Comportement attendu

- On compte les conversations dont le terminal intégré est ouvert et dont le dossier est exactement celui du projet (les conversations d'un worktree ne comptent pas).
- Seulement à la création d'une **nouvelle** conversation, et seulement si le dossier est un dépôt git.
- Fenêtre : « Deux conversations tournent déjà dans ce dossier. Démarrer celle-ci dans un worktree pour éviter qu'elles se marchent dessus ? » Boutons **Dans un worktree** (champ de nom facultatif, comme l'option existante `startInNewWorktree`) et **Ici quand même**, case « Ne plus demander pour ce projet » (mémorisée dans `config.json`).
- Si l'utilisateur avait déjà coché « Dans un nouveau worktree » à la création, pas de fenêtre.
- Réglages : case pour couper la règle.

## Vérifications

- Test de la fonction de comptage (dossier principal vs worktree, terminaux fermés).

## Comments

Fait :

- **Comptage** (Rust, `src-tauri/src/worktrees.rs`, testé) : `conversations_in_dir(dir, open)` compte les terminaux intégrés ouverts avec `claude` lancé dont le dossier est exactement `dir` (comparé après `pty::normalize_dir`, casse ignorée sous Windows), hors worktree (conversation marquée `inWorktree`, ou dossier `.claude\worktrees\…`). `worktree_offer(dir, open, is_git)` renvoie `Some(n)` si `n ≥ WORKTREE_OFFER_MIN` (2) et que le dossier est la racine d'un dépôt git. Commande `worktree_offer(path, open) -> Option<usize>`.
- **Terminaux ouverts** : fournis par l'interface (`terminals` de `App.tsx`), car le backend ne sait pas qu'une nouvelle conversation lancée avec `claude --worktree` tourne dans un worktree (son terminal est dans le dossier du projet) : `inWorktree` vient du `worktree` de la conversation (provisoire ou lue), `running` de `isTerminalRunning`.
- **Création** : `newConversation` (`App.tsx`) remplace `startNewConversation` pour les créations de l'utilisateur (barre latérale, vue du projet, nouveau projet). Pas de fenêtre si « Dans un nouveau worktree » a été choisi, si la règle est coupée (`isRuleEnabled(config, "worktree")`) ou si le projet a « Ne plus demander ». Le hand off appelle toujours `startNewConversation` directement : pas de fenêtre.
- **Fenêtre** `WorktreeOfferDialog` (`Dialogs.tsx`) : texte du ticket (« Deux conversations… », ou le nombre au-delà), nom de worktree facultatif vérifié par `worktreeNameError`, boutons **Dans un worktree** / **Ici quand même**, case « Ne plus demander pour ce projet ». Échap ou clic à côté : rien n'est créé.
- **« Ne plus demander »** : `ProjectPrefs.noWorktreeOffer` dans `config.json` (champ facultatif, écrit seulement s'il est vrai ; pas de changement de version).
- **Réglages** : règle `worktree` (`RULE_WORKTREE`) déclarée dans `SUGGESTION_RULES` sans bandeau, d'où sa case « Troisième conversation dans le même dossier ».
- Mode dev (`devMock.ts`) : `worktree_offer` simulé avec la même règle (dépôts git fictifs : site et jeu).
