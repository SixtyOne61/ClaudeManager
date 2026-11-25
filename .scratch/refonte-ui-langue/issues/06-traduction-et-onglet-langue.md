# Traduction via `claude -p` et onglet Langue

Status: ready-for-agent
Blocked by: 01, 05

## Ce qu'on veut

Choisir la langue de l'interface en la tapant. L'app la fait traduire par Claude, garde la traduction et la tient à jour.

## Comportement attendu

### Onglet Langue (réglages, ticket 01)
- Liste des langues disponibles : le français (intégré, impossible à supprimer) et les langues déjà traduites, sous leur nom natif. Un clic choisit la langue et l'interface change tout de suite. Un bouton supprime une langue traduite.
- Champ « Autre langue… » et bouton « Traduire », avec une progression pendant la traduction et la possibilité d'annuler.
- Si la langue est inconnue, un message d'erreur « Langue inconnue » s'affiche et rien n'est enregistré.

### Traduction
- Par `claude -p` lancé en local (abonnement de l'utilisateur, aucune clé à fournir), avec le modèle **Sonnet**.
- Première étape : ramener ce qu'a tapé l'utilisateur à un code standard (BCP 47) et à un nom natif, ou à une erreur si ce n'est pas une langue. « anglais », « English » et « en » donnent tous `en`. Si cette langue est déjà traduite, on la choisit sans rien relancer.
- Ensuite : traduire le catalogue (ticket 05) par lots, en sortie JSON. Le glossaire (`GLOSSARY.md`) est fourni : « Hub », « Hand off » et « Worktree » restent tels quels, les autres termes sont traduits de façon constante.
- Contrôle : chaque texte traduit doit garder exactement les mêmes variables. Sinon, ce texte s'affiche en français.

### Stockage et mise à jour
- Un fichier JSON par langue dans le dossier de données de l'app. Chaque texte garde une empreinte du texte français dont il est tiré.
- Au lancement, si la langue choisie a des textes manquants ou dont l'empreinte ne correspond plus (nouvelle version de l'app), seuls ceux-là sont retraduits, en arrière-plan. Ils s'affichent en français en attendant.
- Si `claude` est absent ou que l'utilisateur n'est pas connecté : message d'erreur clair, l'app reste dans la langue courante.

## Vérifications

- Tests : normalisation (réponse valide, langue inconnue), contrôle des variables, calcul des textes à retraduire via les empreintes.
- Essai réel : traduire en anglais, changer de langue, relancer l'app, modifier un texte du catalogue et vérifier que seul lui est retraduit.

## Comments
