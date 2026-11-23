---
name: release
description: Publie une nouvelle version de Claude Manager (notes de version depuis le dernier tag, numéro de version, tag, release GitHub). À utiliser quand l'utilisateur demande une release, une nouvelle version, ou accepte la release proposée.
---

# Publier une version

Chaque étape se termine sur son critère ; ne passe à la suivante qu'une fois celui-ci atteint.

## 1. Inventaire depuis la dernière version

```powershell
git describe --tags --abbrev=0          # dernier tag, ex. v0.3.1
git log <tag>..HEAD --format='--- %h %s%n%b'
```

Lis chaque commit ; quand le message ne dit pas ce que l'utilisateur verra, lis son diff (`git show <hash> --stat`, puis les fichiers utiles). Les commits « Version x.y.z » et de pure maintenance (tests, refactorisation, docs internes) ne vont pas dans les notes.

Terminé quand : chaque commit depuis le tag est classé « visible » (avec ce que l'utilisateur constate) ou « interne ». Si l'arbre de travail a des modifications non commitées, demande d'abord quoi en faire.

## 2. Numéro de version

Celui donné par l'utilisateur, sinon : nouvelle fonctionnalité → mineure (`0.3.1` → `0.4.0`), seulement des corrections ou retouches → correctif (`0.3.1` → `0.3.2`). Propose-le s'il n'a pas été donné.

## 3. Notes de version

Écris `docs/releases/v<version>.md`. Le workflow le lit : il devient le texte de la release **et** le champ `notes` de `latest.json`, affiché dans la boîte de dialogue native « Mise à jour disponible » de l'app, en **texte brut**. Donc :

- une phrase d'accroche, puis des groupes : un titre seul sur sa ligne (`Conversation`, `Projets`, `Barre latérale`…), puis des puces `- ` ;
- sans `**`, `#`, liens ni code : rien qui s'afficherait en symboles bruts ;
- en français, au vouvoiement, du point de vue de l'utilisateur (ce qu'il voit ou peut faire), une idée par puce, aucun nom de fichier ni détail d'implémentation ;
- court : une dizaine de puces au plus, les changements majeurs d'abord.

Modèle : `docs/releases/` contient les notes des versions précédentes.

Terminé quand : chaque commit « visible » est couvert par une puce, et aucune puce ne décrit un commit « interne ».

## 4. Commit de version

Mets la version dans `src-tauri/Cargo.toml` (source unique ; `tauri.conf.json` n'en a pas) et dans `package.json` :

```powershell
npm version <version> --no-git-tag-version      # package.json + package-lock.json
# éditer `version = "..."` dans src-tauri/Cargo.toml, puis :
cargo check --manifest-path src-tauri/Cargo.toml  # met Cargo.lock à jour
```

Commite ces quatre fichiers et les notes, message `Version <version>` (plus la ligne Co-Authored-By habituelle).

Puis `npm ci` en local : le workflow le lance, et il échoue si le lock n'est pas synchronisé (npm retire parfois des dépendances optionnelles comme `@emnapi/*` lors d'un `npm install`). En cas d'échec, repars du `package-lock.json` du dernier tag et rajoute à la main les seules entrées des dépendances ajoutées depuis.

Terminé quand : `npm ci` réussit, `git status` est propre et `git diff HEAD~1 --stat` montre exactement `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` et `docs/releases/v<version>.md`.

## 5. Tag et workflow

```powershell
git push origin master
git tag v<version>; git push origin v<version>
gh run list --workflow release.yml --limit 1      # récupérer l'id du run
gh run watch <id> --exit-status                   # ~10 min, à lancer en arrière-plan
```

Le workflow vérifie que le tag égale la version de `Cargo.toml` et que le fichier de notes existe, compile, signe et crée une release **en brouillon**.

Terminé quand : le run est vert et `gh release view v<version> --json isDraft,assets` montre un brouillon avec `latest.json`, l'installateur `.exe` et sa signature `.sig`, le `.dmg` universel, et l'archive `.app.tar.gz` de macOS avec sa `.sig`. `latest.json` doit lister les plateformes `windows-x86_64`, `darwin-aarch64` et `darwin-x86_64`. Vérifie que les notes sont arrivées : `gh release download v<version> -p latest.json -O -` doit contenir tes notes dans `notes`.

Si le run échoue : lis le journal (`gh run view <id> --log-failed`), corrige, supprime le tag (`git push origin :refs/tags/v<version>; git tag -d v<version>`) et la release brouillon éventuelle, puis reprends l'étape.

## 6. Publication

Publier rend la mise à jour visible à tous les utilisateurs : montre les notes à l'utilisateur et attends son accord explicite, puis :

```powershell
gh release edit v<version> --draft=false --latest
```

Terminé quand : `gh release view v<version> --json isDraft` renvoie `false`, ou l'utilisateur a choisi de garder le brouillon (donne-lui alors le lien de la release).
