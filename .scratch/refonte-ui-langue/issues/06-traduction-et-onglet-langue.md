# Traduction via `claude -p` et onglet Langue

Status: resolved
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

Fait :
- Rust `languages.rs` : fichiers `%APPDATA%\claude-manager\languages\<code>.json` (code BCP 47 vérifié, sert de nom de fichier), commandes `languages_list`, `language_read`, `language_write` (écriture atomique), `language_delete`, `claude_ask` (async, annulable par `claude_cancel`). `claude -p --model sonnet --output-format json --no-session-persistence --tools "" --strict-mcp-config --disable-slash-commands --system-prompt-file …`, lancé depuis `%TEMP%\claude-manager-translate` : aucune session enregistrée (vérifié), pas de CLAUDE.md lu. `--bare` écarté : il n'accepte qu'une clé d'API, pas l'abonnement. Champ `language` dans `Config`.
- `src/i18n/translate.ts` : `identifyLanguage` (refuse les langues de fiction et le charabia : « azerty », « klingon » ; accepte « espéranto »), `startTranslation` (textes manquants ou dont l'empreinte FNV du français a changé, lots de 70, 3 en parallèle, enregistrement après chaque lot donc reprise possible, langue affichée rafraîchie au fil des lots), `cancelTranslation`, `applyLanguage`, `pendingCount`. Contrôle `validTranslation` : mêmes variables que le français (parcours ICU réel : le texte d'une branche n'est pas une variable) et texte lisible, sinon le texte reste en français. Consigne avec le glossaire (`GLOSSARY.md?raw`).
- Onglet « Langue » (`LanguageSettings.tsx`) : français intégré + langues traduites (choix, suppression), textes en attente avec « Traduire maintenant », champ « Autre langue… » + « Traduire », progression et « Annuler » ; la langue est choisie automatiquement à la fin si tout s'est bien passé. La traduction continue si la fenêtre est fermée.
- Démarrage (`App.tsx`) : langue appliquée, puis complétée en arrière-plan une fois par lancement si des textes manquent.
- Tests Rust : codes de langue, liste des langues, lecture de la réponse de `claude -p`.

Essais réels : 66 textes parmi les plus délicats (pluriels, choix) traduits en anglais en 18 s, tous valides après correction de `variablesOf` ; identification « anglais » → `en` English, « pt-BR » → Português (Brasil), « chinois traditionnel » → `zh-Hant`. Pas encore fait : une traduction complète depuis l'app.
