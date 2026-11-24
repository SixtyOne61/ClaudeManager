//! Parcours de `~/.claude/projects` et regroupement des sessions par projet.
//!
//! Un cache (en mémoire + fichier `cache.json` dans le dossier de l'appli) mémorise
//! le résumé de chaque `.jsonl` avec sa date de modification et sa taille :
//! seuls les fichiers nouveaux ou modifiés sont relus. Il garde aussi les noms de messagerie
//! déjà vus (voir messages.rs), qui changent à chaque lancement de Claude Code.

use crate::messages::{merge_names, NameUse};
use crate::sessions::{encode_project_path, file_stamp, read_session, SessionInfo};
use crate::worktrees;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// Version du format du cache : l'incrémenter invalide les anciens caches.
const CACHE_VERSION: u32 = 2;

/// Un projet tel que vu par l'interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// Nom du dossier encodé dans `~/.claude/projects` (clé stable).
    pub key: String,
    /// Chemin réel du projet, s'il est connu.
    pub path: Option<String>,
    /// Le dossier du projet existe-t-il encore sur le disque ?
    pub exists: bool,
    /// Projet situé dans un dossier temporaire (masqué par défaut).
    pub is_temp: bool,
    pub last_activity: Option<String>,
    /// Conversations, de la plus récente à la plus ancienne.
    pub sessions: Vec<SessionInfo>,
}

#[derive(Serialize, Deserialize, Clone)]
struct CacheEntry {
    mtime: u64,
    size: u64,
    info: SessionInfo,
}

#[derive(Serialize, Deserialize, Default)]
struct CacheFile {
    version: u32,
    entries: HashMap<String, CacheEntry>,
    /// Noms de messagerie déjà vus (absent d'un ancien cache).
    #[serde(default)]
    names: Vec<NameUse>,
}

pub struct Scanner {
    root: PathBuf,
    cache_path: PathBuf,
    cache: Mutex<HashMap<String, CacheEntry>>,
    names: Mutex<Vec<NameUse>>,
}

impl Scanner {
    /// `root` : dossier `projects` de Claude Code. `cache_path` : fichier cache de l'appli.
    pub fn new(root: PathBuf, cache_path: PathBuf) -> Self {
        let file = fs::read_to_string(&cache_path)
            .ok()
            .and_then(|t| serde_json::from_str::<CacheFile>(&t).ok())
            .filter(|c| c.version == CACHE_VERSION)
            .unwrap_or_default();
        Self { root, cache_path, cache: Mutex::new(file.entries), names: Mutex::new(file.names) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Parcourt tous les projets. Les erreurs d'accès sont ignorées (dossier ou fichier sauté).
    pub fn scan(&self) -> Vec<ProjectInfo> {
        // 1. Liste des fichiers .jsonl, regroupés par dossier projet.
        let mut files: Vec<(String, PathBuf)> = Vec::new();
        if let Ok(dirs) = fs::read_dir(&self.root) {
            for dir in dirs.flatten() {
                if !dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let key = dir.file_name().to_string_lossy().to_string();
                let Ok(entries) = fs::read_dir(dir.path()) else { continue };
                for e in entries.flatten() {
                    let p = e.path();
                    let is_file = e.file_type().map(|t| t.is_file()).unwrap_or(false);
                    if is_file && p.extension().is_some_and(|x| x == "jsonl") {
                        files.push((key.clone(), p));
                    }
                }
            }
        }

        // 2. Résumés : depuis le cache si le fichier n'a pas changé, sinon relecture.
        let mut infos: Vec<Option<SessionInfo>> = vec![None; files.len()];
        let mut todo: Vec<usize> = Vec::new();
        {
            let cache = self.cache.lock().unwrap();
            for (i, (_, path)) in files.iter().enumerate() {
                let hit = file_stamp(path).and_then(|(mtime, size)| {
                    cache
                        .get(&path.to_string_lossy().to_string())
                        .filter(|c| c.mtime == mtime && c.size == size)
                        .map(|c| c.info.clone())
                });
                match hit {
                    Some(info) => infos[i] = Some(info),
                    None => todo.push(i),
                }
            }
        }
        let fresh = self.read_parallel(&files, &todo);

        // 3. Mise à jour du cache (on retire les fichiers disparus).
        {
            let mut cache = self.cache.lock().unwrap();
            for (i, info) in fresh {
                if let Some(info) = info {
                    cache.insert(
                        files[i].1.to_string_lossy().to_string(),
                        CacheEntry { mtime: info.modified_ms, size: info.file_size, info: info.clone() },
                    );
                    infos[i] = Some(info);
                }
            }
            let alive: std::collections::HashSet<String> =
                files.iter().map(|(_, p)| p.to_string_lossy().to_string()).collect();
            let before = cache.len();
            cache.retain(|k, _| alive.contains(k));
            if !todo.is_empty() || cache.len() != before {
                self.save_cache(&cache);
            }
        }

        // 4. Regroupement par projet.
        let mut by_key: HashMap<String, Vec<SessionInfo>> = HashMap::new();
        for ((key, _), info) in files.iter().zip(infos) {
            if let Some(info) = info {
                by_key.entry(key.clone()).or_default().push(info);
            }
        }
        group_worktrees(by_key)
            .into_iter()
            .map(|(key, (path, mut sessions))| {
                sessions.sort_by(|a, b| sort_key(b).cmp(&sort_key(a)));
                Self::make_project(key, path, sessions)
            })
            .collect()
    }

    /// Construit un [`ProjectInfo`] (utilisé aussi pour les projets sans conversation).
    pub fn make_project(key: String, path: Option<String>, sessions: Vec<SessionInfo>) -> ProjectInfo {
        let exists = path.as_deref().is_some_and(|p| Path::new(p).is_dir());
        let lower = path.as_deref().unwrap_or(&key).to_lowercase();
        let is_temp = lower.contains(r"\appdata\local\temp") || lower.contains("-appdata-local-temp");
        let last_activity = sessions.first().and_then(|s| s.updated_at.clone());
        ProjectInfo { key, path, exists, is_temp, last_activity, sessions }
    }

    /// Lit les fichiers demandés sur plusieurs threads (les gros fichiers dominent le temps).
    fn read_parallel(&self, files: &[(String, PathBuf)], todo: &[usize]) -> Vec<(usize, Option<SessionInfo>)> {
        if todo.is_empty() {
            return Vec::new();
        }
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(todo.len());
        let next = AtomicUsize::new(0);
        let results = Mutex::new(Vec::with_capacity(todo.len()));
        std::thread::scope(|s| {
            for _ in 0..threads {
                s.spawn(|| loop {
                    let n = next.fetch_add(1, Ordering::Relaxed);
                    let Some(&i) = todo.get(n) else { break };
                    let (key, path) = &files[i];
                    let info = read_session(path, key);
                    results.lock().unwrap().push((i, info));
                });
            }
        });
        results.into_inner().unwrap()
    }

    /// Ajoute des noms de messagerie à ceux déjà vus (gardés dans le cache) et les renvoie tous.
    pub fn remember_names(&self, fresh: &[NameUse]) -> Vec<NameUse> {
        let (changed, all) = {
            let mut names = self.names.lock().unwrap();
            (merge_names(&mut names, fresh), names.clone())
        };
        if changed {
            // Verrous pris l'un après l'autre (scan : cache puis noms) : pas d'interblocage.
            let cache = self.cache.lock().unwrap();
            self.save_cache(&cache);
        }
        all
    }

    fn save_cache(&self, cache: &HashMap<String, CacheEntry>) {
        let names = self.names.lock().unwrap().clone();
        let file = CacheFile { version: CACHE_VERSION, entries: cache.clone(), names };
        if let Ok(text) = serde_json::to_string(&file) {
            // Le cache n'est qu'une optimisation : une erreur d'écriture est sans conséquence.
            let _ = crate::config::write_atomic(&self.cache_path, text.as_bytes());
        }
    }

    /// Oublie une entrée du cache (après archivage / suppression).
    pub fn forget(&self, file: &Path) {
        self.cache.lock().unwrap().remove(&file.to_string_lossy().to_string());
    }
}

/// Clé de tri : dernière activité, puis date de modification du fichier.
fn sort_key(s: &SessionInfo) -> (String, u64) {
    (s.updated_at.clone().unwrap_or_default(), s.modified_ms)
}

/// Chemin réel du projet : le `cwd` d'une session dont l'encodage correspond au dossier.
fn project_path(key: &str, sessions: &[SessionInfo]) -> Option<String> {
    let cwds = || sessions.iter().filter_map(|s| s.cwd.clone());
    cwds().find(|c| encode_project_path(c) == key).or_else(|| cwds().next())
}

/// Range les conversations de worktree sous leur projet parent (déduit du `cwd`).
/// Entrée : sessions par clé de stockage. Sortie : (chemin, sessions) par clé de projet affiché.
/// Chaque session garde sa clé de stockage dans `project_key`.
fn group_worktrees(by_key: HashMap<String, Vec<SessionInfo>>) -> HashMap<String, (Option<String>, Vec<SessionInfo>)> {
    let keys: Vec<String> = by_key.keys().cloned().collect();
    let mut out: HashMap<String, (Option<String>, Vec<SessionInfo>)> = HashMap::new();
    for (key, sessions) in by_key {
        let path = project_path(&key, &sessions);
        for mut s in sessions {
            match s.cwd.as_deref().or(path.as_deref()).and_then(worktrees::detect) {
                Some((parent, wt)) => {
                    let pk = worktrees::parent_key(&parent, &keys);
                    s.worktree = Some(wt);
                    let e = out.entry(pk).or_default();
                    e.0.get_or_insert(parent);
                    e.1.push(s);
                }
                None => {
                    let e = out.entry(key.clone()).or_default();
                    // Le chemin lu dans les conversations du projet lui-même fait foi.
                    if path.is_some() {
                        e.0 = path.clone();
                    }
                    e.1.push(s);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_messaging_names_in_the_cache_file() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache.json");
        let scanner = Scanner::new(dir.path().join("projects"), cache.clone());
        let n = |name: &str, id: &str, since| NameUse { name: name.into(), session_id: id.into(), since };
        assert_eq!(scanner.remember_names(&[n("projet-bf", "s1", 10)]), vec![n("projet-bf", "s1", 10)]);
        // Relu au démarrage suivant, et complété.
        let again = Scanner::new(dir.path().join("projects"), cache.clone());
        assert_eq!(again.remember_names(&[n("local_x", "s2", 0)]), vec![n("projet-bf", "s1", 10), n("local_x", "s2", 0)]);
        // Un ancien cache sans noms reste lisible.
        fs::write(&cache, format!(r#"{{"version":{CACHE_VERSION},"entries":{{}}}}"#)).unwrap();
        assert!(Scanner::new(dir.path().join("projects"), cache).remember_names(&[]).is_empty());
    }

    /// Parcourt les vraies données de la machine : `cargo test real_scan -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_scan() {
        let root = dirs::home_dir().unwrap().join(".claude").join("projects");
        let cache = std::env::temp_dir().join("claude-manager-test-cache.json");
        let _ = fs::remove_file(&cache);
        let scanner = Scanner::new(root, cache.clone());

        let t = std::time::Instant::now();
        let projects = scanner.scan();
        let cold = t.elapsed();
        let t = std::time::Instant::now();
        let again = Scanner::new(scanner.root.clone(), cache).scan();
        let warm = t.elapsed();

        let sessions: usize = projects.iter().map(|p| p.sessions.len()).sum();
        let skipped: u32 = projects.iter().flat_map(|p| &p.sessions).map(|s| s.skipped_lines).sum();
        let no_path = projects.iter().filter(|p| p.path.is_none()).count();
        println!("{} projets, {sessions} sessions, {skipped} lignes ignorées, {no_path} projets sans chemin", projects.len());
        println!("lecture à froid {cold:?}, avec cache {warm:?}");
        assert_eq!(sessions, again.iter().map(|p| p.sessions.len()).sum::<usize>());
        let wt_projects = projects.iter().filter(|p| worktrees::is_worktree_key(&p.key)).count();
        println!("{wt_projects} projets de worktree restants (attendu : 0)");
        for p in projects.iter().filter(|p| p.sessions.iter().any(|s| s.worktree.is_some())) {
            let names: std::collections::BTreeSet<String> = p
                .sessions
                .iter()
                .filter_map(|s| s.worktree.as_ref().map(|w| format!("{} (existe={})", w.name, w.exists)))
                .collect();
            println!("  {} <- worktrees {:?}", p.key, names);
        }
        let mut sorted = projects.clone();
        sorted.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
        for p in sorted.iter().take(4) {
            println!("\n{} (temp={}, existe={})", p.path.as_deref().unwrap_or(&p.key), p.is_temp, p.exists);
            for s in p.sessions.iter().take(3) {
                println!(
                    "  {} | {:?} | {} msg | {} | {}",
                    &s.id[..8],
                    s.title_source,
                    s.message_count,
                    s.updated_at.as_deref().unwrap_or("?"),
                    s.title
                );
            }
        }
    }

    fn session(id: &str, key: &str, cwd: Option<&str>) -> SessionInfo {
        SessionInfo {
            id: id.into(),
            project_key: key.into(),
            cwd: cwd.map(Into::into),
            title: id.into(),
            title_source: crate::sessions::TitleSource::None,
            first_prompt: None,
            created_at: None,
            updated_at: None,
            message_count: 0,
            file_size: 0,
            modified_ms: 0,
            skipped_lines: 0,
            worktree: None,
        }
    }

    #[test]
    fn groups_worktree_sessions_under_parent() {
        let parent = "C--Work-Foo";
        let wt = "C--Work-Foo--claude-worktrees-bar";
        let mut by_key = HashMap::new();
        by_key.insert(parent.to_string(), vec![session("a", parent, Some(r"C:\Work\Foo"))]);
        by_key.insert(wt.to_string(), vec![session("b", wt, Some(r"c:\Work\Foo\.claude\worktrees\bar"))]);
        // Worktree d'un projet sans conversation propre.
        let solo = "C--Work-Solo--claude-worktrees-x";
        by_key.insert(solo.to_string(), vec![session("c", solo, Some("C:/Work/Solo/.claude/worktrees/x/sub"))]);

        let out = group_worktrees(by_key);
        assert_eq!(out.len(), 2);
        let (path, sessions) = &out[parent];
        assert_eq!(path.as_deref(), Some(r"C:\Work\Foo"));
        let b = sessions.iter().find(|s| s.id == "b").unwrap();
        assert_eq!(b.project_key, wt, "la clé de stockage est conservée");
        assert_eq!(b.worktree.as_ref().unwrap().name, "bar");
        assert!(!b.worktree.as_ref().unwrap().exists);
        assert!(sessions.iter().find(|s| s.id == "a").unwrap().worktree.is_none());
        let (path, sessions) = &out["C--Work-Solo"];
        assert_eq!(path.as_deref(), Some("C:/Work/Solo"));
        assert_eq!(sessions[0].worktree.as_ref().unwrap().path, "C:/Work/Solo/.claude/worktrees/x");
    }
}
