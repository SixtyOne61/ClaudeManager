//! Conversations de worktree : rattachement au projet parent.
//!
//! Claude Code crée ses worktrees dans `<parent>\.claude\worktrees\<nom>` et range leurs
//! conversations dans un dossier projet à part (`<parent encodé>--claude-worktrees-<nom>`).
//! Ici, on retrouve le projet parent à partir du `cwd` de la conversation, pour afficher
//! ces conversations sous le parent. Leur fichier `.jsonl` ne bouge pas : la session garde
//! sa vraie clé de stockage (`SessionInfo::project_key`).

use crate::config::Config;
use crate::sessions::encode_project_path;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

/// Marqueur, dans une clé de projet encodée, d'un dossier `\.claude\worktrees\`.
const KEY_MARKER: &str = "--claude-worktrees-";

/// Worktree dans lequel tourne une conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// Nom du worktree (dossier sous `.claude\worktrees`).
    pub name: String,
    /// Chemin complet du worktree : c'est là qu'il faut relancer `claude --resume`.
    pub path: String,
    /// Le dossier du worktree existe-t-il encore ?
    pub exists: bool,
}

/// Découpe un chemin `<parent>\.claude\worktrees\<nom>[\...]`.
/// Renvoie `(chemin du parent, nom du worktree)`. Séparateurs `\` et `/` acceptés,
/// casse ignorée pour `.claude\worktrees`.
pub fn split_worktree_path(path: &str) -> Option<(String, String)> {
    let lower = path.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let is_sep = |b: u8| b == b'\\' || b == b'/';
    // Cherche « <sep>.claude<sep>worktrees<sep> » (la dernière occurrence : worktree le plus proche).
    let mut found = None;
    let mut i = 0;
    while let Some(pos) = lower[i..].find(".claude") {
        let start = i + pos;
        let ok = start > 0
            && is_sep(bytes[start - 1])
            && bytes.get(start + 7).copied().is_some_and(is_sep)
            && lower[start + 8..].starts_with("worktrees")
            && bytes.get(start + 17).copied().is_some_and(is_sep);
        if ok {
            found = Some(start);
        }
        i = start + 7;
    }
    let start = found?;
    let parent = path[..start - 1].to_string();
    let rest = &path[start + 18..];
    let name = rest.split(['\\', '/']).next().unwrap_or("").to_string();
    if parent.is_empty() || name.is_empty() {
        return None;
    }
    Some((parent, name))
}

/// Si `cwd` est dans un worktree : `(chemin du parent, infos du worktree)`.
pub fn detect(cwd: &str) -> Option<(String, WorktreeInfo)> {
    let (parent, name) = split_worktree_path(cwd)?;
    let sep = if cwd[parent.len()..].starts_with('/') { '/' } else { '\\' };
    let path = format!("{parent}{sep}.claude{sep}worktrees{sep}{name}");
    let exists = Path::new(&path).is_dir();
    Some((parent, WorktreeInfo { name, path, exists }))
}

/// Clé encodée du projet parent. Si une clé existante ne diffère que par la casse
/// (lettre de lecteur `c:` / `C:`), c'est elle qui est retenue.
pub fn parent_key<'a>(parent_path: &str, existing: impl IntoIterator<Item = &'a String>) -> String {
    let key = encode_project_path(parent_path);
    let mut fallback = None;
    for k in existing {
        if *k == key {
            return key;
        }
        if fallback.is_none() && k.eq_ignore_ascii_case(&key) {
            fallback = Some(k.clone());
        }
    }
    fallback.unwrap_or_else(|| uppercase_drive(&key))
}

/// `c--Users-...` → `C--Users-...` (forme habituelle sous Windows).
fn uppercase_drive(key: &str) -> String {
    let mut chars = key.chars();
    match (chars.next(), key.get(1..3)) {
        (Some(d), Some("--")) if d.is_ascii_alphabetic() => format!("{}{}", d.to_ascii_uppercase(), &key[1..]),
        _ => key.to_string(),
    }
}

/// Le dossier est-il la racine d'un dépôt git ? Repéré par une entrée `.git` (dossier, ou
/// fichier pour un worktree git), sans lancer `git` (donc sans fenêtre). Seule la racine
/// compte : `claude --worktree` crée le worktree à la racine du dépôt, et la conversation
/// doit se ranger sous ce projet-ci (ticket 08).
pub fn is_git_repo(path: &str) -> bool {
    !path.trim().is_empty() && Path::new(path.trim()).join(".git").exists()
}

/// Terminal intégré ouvert, tel que l'interface le connaît (règle « worktree » des suggestions).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OpenConversation {
    /// Dossier du terminal.
    pub cwd: String,
    /// La conversation tourne dans un worktree (existant, ou nouveau : son terminal est alors
    /// lancé dans le dossier du projet avec `claude --worktree`).
    pub in_worktree: bool,
    /// `claude` tourne dans le terminal.
    pub running: bool,
}

/// Nombre de conversations déjà ouvertes à partir duquel on propose un worktree pour la
/// suivante (« troisième conversation dans le même dossier »).
pub const WORKTREE_OFFER_MIN: usize = 2;

/// Deux dossiers sont-ils le même ? Comparés sous leur forme normalisée (voir
/// [`crate::pty::normalize_dir`]) ; casse ignorée sous Windows.
fn same_dir(a: &str, b: &str) -> bool {
    let (a, b) = (crate::pty::normalize_dir(a), crate::pty::normalize_dir(b));
    if cfg!(windows) { a.to_lowercase() == b.to_lowercase() } else { a == b }
}

/// Conversations dont le terminal intégré est ouvert (avec `claude` lancé) et qui tournent
/// exactement dans `dir` : celles d'un worktree ne comptent pas.
pub fn conversations_in_dir(dir: &str, open: &[OpenConversation]) -> usize {
    if dir.trim().is_empty() {
        return 0;
    }
    open.iter()
        .filter(|c| c.running && !c.in_worktree && split_worktree_path(&c.cwd).is_none() && same_dir(&c.cwd, dir))
        .count()
}

/// Proposer de démarrer une nouvelle conversation dans un worktree ? `Some(n)` (nombre de
/// conversations qui tournent déjà dans le dossier) si le dossier est un dépôt git et que
/// `n` atteint [`WORKTREE_OFFER_MIN`].
pub fn worktree_offer(dir: &str, open: &[OpenConversation], is_git: impl FnOnce(&str) -> bool) -> Option<usize> {
    let n = conversations_in_dir(dir, open);
    (n >= WORKTREE_OFFER_MIN && is_git(dir)).then_some(n)
}

pub mod commands {
    use super::OpenConversation;

    /// Propose-t-on « Dans un nouveau worktree » pour ce projet ?
    #[tauri::command]
    pub fn is_git_repo(path: String) -> bool {
        super::is_git_repo(&path)
    }

    /// Création d'une conversation dans `path` : faut-il proposer un worktree ? Voir
    /// [`super::worktree_offer`].
    #[tauri::command]
    pub fn worktree_offer(path: String, open: Vec<OpenConversation>) -> Option<usize> {
        super::worktree_offer(&path, &open, super::is_git_repo)
    }
}

/// La clé de projet désigne-t-elle un dossier de worktree ?
pub fn is_worktree_key(key: &str) -> bool {
    key.to_ascii_lowercase().contains(KEY_MARKER)
}

/// La clé `key` est-elle celle d'un worktree du projet `parent` ?
pub fn is_worktree_of(key: &str, parent: &str) -> bool {
    let (k, p) = (key.to_ascii_lowercase(), parent.to_ascii_lowercase());
    k.strip_prefix(&p).is_some_and(|rest| rest.starts_with(KEY_MARKER))
}

/// Dossiers de stockage à parcourir pour un projet : le sien et ceux de ses worktrees.
pub fn storage_keys(projects_root: &Path, key: &str) -> Vec<String> {
    let mut keys = vec![key.to_string()];
    if let Ok(dirs) = std::fs::read_dir(projects_root) {
        for d in dirs.flatten() {
            let name = d.file_name().to_string_lossy().to_string();
            if is_worktree_of(&name, key) && d.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                keys.push(name);
            }
        }
    }
    keys
}

/// Retire de la configuration les anciennes entrées qui traitaient un worktree comme un
/// projet (rangement dans une catégorie, préférences). `absorbed` : clés de stockage dont
/// les conversations ont été rattachées à un parent. Renvoie `true` si quelque chose a changé.
pub fn clean_config(cfg: &mut Config, absorbed: &HashSet<String>) -> bool {
    let is_wt = |key: &str, path: Option<&str>| {
        absorbed.contains(key) || is_worktree_key(key) || path.is_some_and(|p| split_worktree_path(p).is_some())
    };
    let before: usize =
        cfg.projects.len() + cfg.categories.iter().map(|c| c.project_keys.len()).sum::<usize>();
    let prefs_paths: Vec<(String, Option<String>)> =
        cfg.projects.iter().map(|(k, p)| (k.clone(), p.path.clone())).collect();
    let bad: HashSet<String> =
        prefs_paths.into_iter().filter(|(k, p)| is_wt(k, p.as_deref())).map(|(k, _)| k).collect();
    cfg.projects.retain(|k, _| !bad.contains(k));
    for c in &mut cfg.categories {
        c.project_keys.retain(|k| !bad.contains(k) && !is_wt(k, None));
    }
    let after: usize = cfg.projects.len() + cfg.categories.iter().map(|c| c.project_keys.len()).sum::<usize>();
    before != after
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Category, ProjectPrefs};

    #[test]
    fn detects_worktree_paths() {
        let p = r"C:\Users\olivi\OneDrive\Desktop\Projects\WorkAtHome\.claude\worktrees\amazing-chatelet-759adf";
        assert_eq!(
            split_worktree_path(p),
            Some((r"C:\Users\olivi\OneDrive\Desktop\Projects\WorkAtHome".into(), "amazing-chatelet-759adf".into()))
        );
        // Sous-dossier du worktree, séparateurs `/`, casse différente.
        assert_eq!(
            split_worktree_path("c:/Work/Foo/.Claude/Worktrees/bar/src/x"),
            Some(("c:/Work/Foo".into(), "bar".into()))
        );
        assert_eq!(split_worktree_path(r"C:\Work\Foo\.claude\worktrees\"), None);
        assert_eq!(split_worktree_path(r"C:\Work\Foo\.claude\projects\bar"), None);
        assert_eq!(split_worktree_path(r"C:\Work\my.claude\worktrees\bar"), None);
        assert_eq!(split_worktree_path(r"C:\Work\Foo"), None);

        let (parent, wt) = detect(r"C:\nulle-part\Foo\.claude\worktrees\bar\src").unwrap();
        assert_eq!(parent, r"C:\nulle-part\Foo");
        assert_eq!(wt.name, "bar");
        assert_eq!(wt.path, r"C:\nulle-part\Foo\.claude\worktrees\bar");
        assert!(!wt.exists);
    }

    #[test]
    fn encodes_parent_key() {
        let parent = r"C:\Users\olivi\OneDrive\Desktop\Projects\WorkAtHome";
        let expected = "C--Users-olivi-OneDrive-Desktop-Projects-WorkAtHome".to_string();
        assert_eq!(parent_key(parent, &[]), expected);
        assert_eq!(parent_key(&parent.replace('\\', "/"), &[]), expected);
        // Lettre de lecteur en minuscule : on retrouve la clé existante, sinon majuscule.
        let lower = parent.replacen('C', "c", 1);
        assert_eq!(parent_key(&lower, &[]), expected);
        let existing = vec!["c--Users-olivi-OneDrive-Desktop-Projects-WorkAtHome".to_string()];
        assert_eq!(parent_key(parent, &existing), existing[0]);

        let wt_key = encode_project_path(&format!(r"{parent}\.claude\worktrees\amazing-chatelet-759adf"));
        assert!(is_worktree_key(&wt_key));
        assert!(is_worktree_of(&wt_key, &expected));
        assert!(is_worktree_of(&wt_key.to_lowercase(), &expected));
        assert!(!is_worktree_of(&expected, &expected));
        assert!(!is_worktree_key(&expected));
    }

    #[test]
    fn detects_git_repos() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        assert!(!is_git_repo(&root));
        assert!(!is_git_repo(""));
        // Dépôt classique : dossier `.git`.
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        assert!(is_git_repo(&root));
        // Sous-dossier d'un dépôt : pas proposé (le worktree irait à la racine du dépôt).
        std::fs::create_dir(tmp.path().join("sous")).unwrap();
        assert!(!is_git_repo(&tmp.path().join("sous").to_string_lossy()));
        // Worktree git : fichier `.git`.
        let wt = tmp.path().join("wt");
        std::fs::create_dir(&wt).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: ailleurs\n").unwrap();
        assert!(is_git_repo(&wt.to_string_lossy()));
        assert!(!is_git_repo(&tmp.path().join("absent").to_string_lossy()));
    }

    #[test]
    fn counts_conversations_in_dir() {
        let dir = r"C:\Work\Foo";
        let conv = |cwd: &str, in_worktree: bool, running: bool| OpenConversation { cwd: cwd.into(), in_worktree, running };
        assert_eq!(conversations_in_dir(dir, &[]), 0);
        let open = [
            conv(r"C:\Work\Foo", false, true),
            // Même dossier écrit autrement : séparateurs, casse, séparateur final.
            conv(if cfg!(windows) { "c:/work/foo/" } else { r"C:\Work\Foo/" }, false, true),
            // Terminal fermé (`claude` arrêté) : ne compte pas.
            conv(r"C:\Work\Foo", false, false),
            // Worktree existant (dossier du worktree) ou nouveau (dossier du projet) : ne comptent pas.
            conv(r"C:\Work\Foo\.claude\worktrees\bar", false, true),
            conv(r"C:\Work\Foo", true, true),
            // Autre dossier, sous-dossier.
            conv(r"C:\Work\Baz", false, true),
            conv(r"C:\Work\Foo\src", false, true),
        ];
        assert_eq!(conversations_in_dir(dir, &open), 2);
        assert_eq!(conversations_in_dir("", &open), 0);

        // Proposé à partir de deux conversations, et seulement dans un dépôt git.
        assert_eq!(worktree_offer(dir, &open, |_| true), Some(2));
        assert_eq!(worktree_offer(dir, &open, |_| false), None);
        assert_eq!(worktree_offer(dir, &open[..1], |_| true), None);
        assert_eq!(worktree_offer(dir, &open[2..], |_| true), None);
    }

    #[test]
    fn cleans_old_config_entries() {
        let mut cfg = Config::default();
        let wt = "C--Work-Foo--claude-worktrees-bar".to_string();
        let other = "C--Work-Baz".to_string();
        cfg.categories.push(Category {
            id: "c".into(),
            name: "C".into(),
            color: None,
            project_keys: vec![wt.clone(), other.clone()],
        });
        cfg.projects.insert(wt.clone(), ProjectPrefs { color: Some("#fff".into()), ..Default::default() });
        cfg.projects.insert(
            "x".into(),
            ProjectPrefs { path: Some(r"C:\Work\Foo\.claude\worktrees\autre".into()), ..Default::default() },
        );
        cfg.projects.insert(other.clone(), ProjectPrefs::default());
        assert!(clean_config(&mut cfg, &HashSet::new()));
        assert_eq!(cfg.categories[0].project_keys, vec![other.clone()]);
        assert_eq!(cfg.projects.keys().collect::<Vec<_>>(), vec![&other]);
        assert!(!clean_config(&mut cfg, &HashSet::new()));
    }
}
