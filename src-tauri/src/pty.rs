//! Terminal intégré : pseudo-terminaux Windows (ConPTY, via `portable-pty`) qui font
//! tourner le binaire `claude` officiel, tel quel.
//!
//! # Utilisation (pour les tickets suivants)
//!
//! - [`PtyManager::launch`] démarre `claude <args…>` dans un dossier, sous une **clé**
//!   (l'identifiant de la conversation). Les arguments sont libres :
//!   [`resume_args`] (`--resume <id>`) pour reprendre, [`new_session_args`]
//!   (`--session-id <uuid>`) pour une nouvelle conversation. `launch` y ajoute toujours
//!   `--settings <fichier>` : les hooks de suivi d'état (voir `activity.rs`).
//!   Avec [`Program::Raw`], il lance une ligne de commande quelconque (commande proposée
//!   par l'agent, clé `run-<id>`, voir `run.rs`), sans suivi d'état.
//! - [`PtyManager::write`] envoie du texte au terminal (frappes, ou texte d'une zone
//!   de saisie) ; [`PtyManager::is_running`] dit si le terminal d'une conversation
//!   est ouvert et que `claude` y tourne encore ; [`PtyManager::list`] les énumère.
//! - Évènements émis vers l'interface : `pty-output` ([`PtyOutput`] : texte UTF-8
//!   à écrire tel quel dans xterm) et `pty-exit` ([`PtyExit`] : `claude` s'est
//!   terminé, après la dernière sortie).
//!
//! Le dossier est toujours normalisé par [`normalize_dir`] avant le lancement.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use crate::ui_error::ui_err;
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Évènement : sortie d'un terminal.
pub const EVT_OUTPUT: &str = "pty-output";
/// Évènement : `claude` s'est terminé dans un terminal.
pub const EVT_EXIT: &str = "pty-exit";

#[derive(Clone, Serialize)]
pub struct PtyOutput {
    pub key: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
pub struct PtyExit {
    pub key: String,
    /// Code de sortie, s'il est connu.
    pub code: Option<u32>,
}

/// État d'un terminal, renvoyé à l'interface.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub key: String,
    pub cwd: String,
    pub running: bool,
}

/// Programme lancé dans un terminal intégré.
pub enum Program {
    /// `claude <args…>` (une conversation), avec le suivi d'état par les hooks.
    Claude(Vec<String>),
    /// Ligne de commande quelconque (commande proposée par l'agent, voir `run.rs`) : pas de
    /// suivi d'état.
    Raw(Vec<String>),
}

/// Ce qu'il faut pour démarrer un terminal intégré.
pub struct LaunchSpec {
    /// Clé du terminal : l'identifiant de la conversation (ou `run-<id>`, voir `run.rs`).
    pub key: String,
    /// Dossier de travail (sera normalisé).
    pub cwd: String,
    pub program: Program,
    pub cols: u16,
    pub rows: u16,
}

/// Arguments pour reprendre une conversation existante.
pub fn resume_args(session_id: &str) -> Result<Vec<String>, String> {
    crate::actions::validate_session_id(session_id)?;
    Ok(vec!["--resume".into(), session_id.into()])
}

/// Arguments pour démarrer une nouvelle conversation dont on choisit l'identifiant.
pub fn new_session_args(session_id: &str) -> Result<Vec<String>, String> {
    crate::actions::validate_session_id(session_id)?;
    Ok(vec!["--session-id".into(), session_id.into()])
}

/// Arguments pour une conversation créée par l'app : `--session-id` tant que son fichier
/// n'existe pas, `--resume` ensuite (« Relancer » après un premier message ; Claude Code
/// refuse un `--session-id` déjà utilisé).
pub fn new_or_resume_args(session_id: &str, file_exists: bool) -> Result<Vec<String>, String> {
    if file_exists { resume_args(session_id) } else { new_session_args(session_id) }
}

/// Vérifie un nom de worktree choisi par l'utilisateur. Claude Code en fait un dossier
/// (`.claude\worktrees\<nom>`) et une branche (`worktree-<nom>`) : on n'accepte que des
/// caractères sûrs pour les deux (lettres, chiffres, `-`, `_`, `.`), commençant par une
/// lettre ou un chiffre, sans `..`, sans `.` final ni `.lock` final, 64 caractères au plus.
pub fn validate_worktree_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && !name.ends_with('.')
        && !name.contains("..")
        && !name.to_ascii_lowercase().ends_with(".lock");
    if ok {
        Ok(())
    } else {
        Err(ui_err("pty.invalidWorktreeName", json!({ "name": name })))
    }
}

/// Arguments pour démarrer une nouvelle conversation dans un nouveau worktree :
/// `--worktree [nom] --session-id <id>`. Sans nom (`None` ou vide), Claude Code en choisit un.
/// Le worktree est créé dans `<dépôt>\.claude\worktrees\<nom>` (branche `worktree-<nom>`) et
/// la conversation y tourne : son `cwd` enregistré est le worktree.
pub fn new_worktree_session_args(session_id: &str, name: Option<&str>) -> Result<Vec<String>, String> {
    let mut args = vec!["--worktree".to_string()];
    if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
        validate_worktree_name(n)?;
        args.push(n.to_string());
    }
    args.extend(new_session_args(session_id)?);
    Ok(args)
}

/// Comme [`new_or_resume_args`], avec l'option worktree : `worktree` vaut `None` pour une
/// conversation normale, `Some(nom)` (éventuellement vide) pour un nouveau worktree. Une fois
/// le fichier créé, `--resume` suffit : Claude Code retourne de lui-même dans le worktree.
pub fn new_or_resume_worktree_args(session_id: &str, file_exists: bool, worktree: Option<&str>) -> Result<Vec<String>, String> {
    match worktree {
        Some(name) if !file_exists => new_worktree_session_args(session_id, Some(name)),
        _ => new_or_resume_args(session_id, file_exists),
    }
}

/// Vrai si `<id>.jsonl` existe dans l'un des dossiers de projets de Claude Code.
pub fn session_file_exists(projects_root: &Path, session_id: &str) -> bool {
    let name = format!("{session_id}.jsonl");
    std::fs::read_dir(projects_root)
        .into_iter()
        .flatten()
        .flatten()
        .any(|d| d.path().join(&name).is_file())
}

/// Écrit un dossier sous une forme unique, pour que Claude Code ne redemande pas sa
/// confiance pour un même dossier écrit autrement. Voir [`normalize_windows_dir`] et
/// [`normalize_unix_dir`].
pub fn normalize_dir(path: &str) -> String {
    if cfg!(windows) { normalize_windows_dir(path) } else { normalize_unix_dir(path) }
}

/// Unix : séparateurs en double fusionnés, pas de `/` final (sauf la racine).
pub fn normalize_unix_dir(path: &str) -> String {
    let p = path.trim();
    let mut out = String::with_capacity(p.len());
    for c in p.chars() {
        if !(c == '/' && out.ends_with('/')) {
            out.push(c);
        }
    }
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    out
}

/// Windows : barres obliques inverses, lettre de lecteur en majuscule, séparateurs en
/// double fusionnés, pas de séparateur final (sauf `C:\`).
pub fn normalize_windows_dir(path: &str) -> String {
    let p = path.trim().replace('/', "\\");
    // Préfixe UNC (`\\serveur\partage`) conservé tel quel.
    let (prefix, rest) = match p.strip_prefix("\\\\") {
        Some(r) => ("\\\\", r.to_string()),
        None => ("", p.clone()),
    };
    let mut out = String::with_capacity(p.len());
    out.push_str(prefix);
    let mut prev_sep = false;
    for c in rest.chars() {
        if c == '\\' {
            if !prev_sep {
                out.push(c);
            }
            prev_sep = true;
        } else {
            out.push(c);
            prev_sep = false;
        }
    }
    // Lettre de lecteur en majuscule.
    if prefix.is_empty() {
        let mut chars = out.chars();
        if let (Some(d), Some(':')) = (chars.next(), chars.next()) {
            if d.is_ascii_alphabetic() {
                out.replace_range(0..1, &d.to_ascii_uppercase().to_string());
            }
        }
    }
    // Séparateur final retiré, sauf pour une racine de lecteur (`C:\`).
    while out.ends_with('\\') && out.len() > prefix.len() + 1 && !(out.len() == 3 && out.as_bytes()[1] == b':') {
        out.pop();
    }
    if out.len() == 2 && out.as_bytes()[1] == b':' {
        out.push('\\');
    }
    out
}

/// Ligne de commande complète : programme puis arguments. Un `.cmd`/`.bat` (installation
/// npm de Claude Code) passe par `cmd.exe /d /c`.
pub fn build_argv(claude: &Path, args: &[String]) -> Vec<String> {
    let exe = claude.to_string_lossy().to_string();
    let is_script = claude
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    let mut argv = if is_script { vec!["cmd.exe".into(), "/d".into(), "/c".into(), exe] } else { vec![exe] };
    argv.extend(args.iter().cloned());
    argv
}

/// Cherche l'exécutable `claude` : dans le PATH (`claude.exe`, puis `claude.cmd` sous
/// Windows ; `claude` ailleurs), puis aux emplacements d'installation habituels.
pub fn find_claude() -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
    for name in names {
        for d in &dirs {
            let c = d.join(name);
            if c.is_file() {
                return Some(c);
            }
        }
    }
    let home = dirs::home_dir()?;
    let fallbacks: Vec<PathBuf> = if cfg!(windows) {
        vec![home.join(r".local\bin\claude.exe"), dirs::data_dir().map(|d| d.join(r"npm\claude.cmd")).unwrap_or_default()]
    } else {
        vec![
            home.join(".local/bin/claude"),
            home.join(".claude/local/claude"),
            home.join(".npm-global/bin/claude"),
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
        ]
    };
    fallbacks.into_iter().find(|p| p.is_file())
}

/// Erreur affichée quand `claude` est introuvable : la commande d'installation dépend du
/// système (`platform` : `windows` ou `other`).
fn claude_missing() -> String {
    ui_err("pty.claudeMissing", json!({ "platform": if cfg!(windows) { "windows" } else { "other" } }))
}

/// Erreur « Le dossier de la conversation n'existe plus » (terminal intégré, blocs exécutés).
pub fn folder_missing(path: &str) -> String {
    ui_err("pty.folderMissing", json!({ "path": path }))
}

/// Décodeur UTF-8 incrémental : une lecture peut couper un caractère en deux, les
/// octets incomplets sont gardés pour la lecture suivante.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    return out;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap());
                    match e.error_len() {
                        // Séquence invalide : remplacée, et on continue après.
                        Some(n) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + n);
                        }
                        // Séquence incomplète en fin de tampon : attendue à la lecture suivante.
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                    }
                }
            }
        }
    }
}

struct PtySession {
    /// Numéro de lancement : distingue un terminal relancé de l'ancien.
    generation: u64,
    cwd: String,
    /// `None` une fois `claude` terminé (le pseudo-terminal est alors fermé).
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl PtySession {
    fn running(&self) -> bool {
        self.master.is_some()
    }
}

/// Tous les terminaux intégrés de l'app, indexés par clé (identifiant de conversation).
#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    next_gen: AtomicU64,
}

impl PtyManager {
    /// Démarre `claude <args>` dans `spec.cwd`. Si un terminal tourne déjà sous cette clé,
    /// ne fait rien (on se rattache à lui) ; s'il est terminé, il est remplacé.
    pub fn launch(&self, app: &AppHandle, spec: LaunchSpec) -> Result<PtyInfo, String> {
        let cwd = normalize_dir(&spec.cwd);
        if !Path::new(&cwd).is_dir() {
            return Err(folder_missing(&cwd));
        }
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(s) = sessions.get(&spec.key).filter(|s| s.running()) {
            return Ok(PtyInfo { key: spec.key.clone(), cwd: s.cwd.clone(), running: true });
        }
        // Suivi de l'état de la conversation (hooks), pour tout lancement de `claude` : reprise ou nouvelle.
        let (argv, is_claude) = match &spec.program {
            Program::Claude(args) => {
                let claude = find_claude().ok_or_else(claude_missing)?;
                let mut args = args.clone();
                args.extend(crate::activity::settings_args());
                (build_argv(&claude, &args), true)
            }
            Program::Raw(argv) if !argv.is_empty() => (argv.clone(), false),
            Program::Raw(_) => return Err(ui_err("pty.emptyCommand", json!({}))),
        };

        let pair = native_pty_system()
            .openpty(PtySize { rows: spec.rows.max(2), cols: spec.cols.max(10), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| ui_err("pty.openFailed", json!({ "detail": e.to_string() })))?;
        let mut cmd = CommandBuilder::from_argv(argv.iter().map(Into::into).collect());
        cmd.cwd(&cwd);
        // Si l'app a elle-même été lancée depuis Claude Code (développement), ces variables
        // empêcheraient `claude` de démarrer comme une session normale.
        cmd.env_remove("CLAUDECODE");
        cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Une app lancée depuis le Finder n'a pas de locale : sans elle, les accents et
        // les symboles de Claude Code s'afficheraient mal.
        #[cfg(unix)]
        {
            if std::env::var_os("LANG").is_none_or(|l| l.is_empty()) {
                cmd.env("LANG", "en_US.UTF-8");
            }
        }
        // Dossier de l'app en tête du PATH : la ligne d'état (`claude-manager.exe statusline`,
        // voir limits.rs) passe par un shell et trouve l'exécutable par son nom.
        if let Some(path) = std::env::current_exe().ok().and_then(|exe| crate::limits::path_with_exe_dir(&exe, std::env::var_os("PATH"))) {
            cmd.env("PATH", path);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
            let code = if is_claude { "pty.claudeLaunchFailed" } else { "pty.commandLaunchFailed" };
            ui_err(code, json!({ "detail": e.to_string() }))
        })?;
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let generation = self.next_gen.fetch_add(1, Ordering::Relaxed);
        let exit_code: Arc<Mutex<Option<u32>>> = Arc::default();

        sessions.insert(
            spec.key.clone(),
            PtySession { generation, cwd: cwd.clone(), master: Some(pair.master), writer: Some(writer), killer: child.clone_killer() },
        );
        drop(sessions);
        if is_claude {
            crate::activity::on_launched(&spec.key);
        }

        // Lecture de la sortie → évènements. À la fin du flux (pseudo-terminal fermé),
        // annonce la fin de `claude`.
        {
            let (app, key, exit_code) = (app.clone(), spec.key.clone(), exit_code.clone());
            std::thread::spawn(move || read_loop(app, key, reader, exit_code, is_claude));
        }
        // Attente de la fin du processus, puis fermeture du pseudo-terminal (ConPTY ne
        // termine le flux de sortie qu'à ce moment-là).
        {
            let (sessions, key) = (self.sessions.clone(), spec.key.clone());
            std::thread::spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code());
                *exit_code.lock().unwrap() = code;
                let closed = {
                    let mut map = sessions.lock().unwrap();
                    map.get_mut(&key).filter(|s| s.generation == generation).map(|s| (s.writer.take(), s.master.take()))
                };
                drop(closed); // ClosePseudoConsole, hors du verrou.
            });
        }
        Ok(PtyInfo { key: spec.key, cwd, running: true })
    }

    /// Envoie du texte (frappes, collage, message) au terminal.
    pub fn write(&self, key: &str, data: &str) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        let w = map.get_mut(key).and_then(|s| s.writer.as_mut()).ok_or_else(|| ui_err("pty.notOpen", json!({})))?;
        w.write_all(data.as_bytes()).and_then(|_| w.flush()).map_err(|e| e.to_string())
    }

    pub fn resize(&self, key: &str, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.sessions.lock().unwrap();
        if let Some(m) = map.get(key).and_then(|s| s.master.as_ref()) {
            m.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Arrête `claude` dans ce terminal et l'oublie.
    pub fn kill(&self, key: &str) {
        let removed = self.sessions.lock().unwrap().remove(key);
        if let Some(mut s) = removed {
            let _ = s.killer.kill();
        }
    }

    /// Arrête tous les terminaux (fermeture de l'app).
    pub fn kill_all(&self) {
        let all: Vec<PtySession> = self.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
        for mut s in all {
            let _ = s.killer.kill();
        }
    }

    /// Vrai si le terminal de cette conversation est ouvert et que `claude` y tourne.
    pub fn is_running(&self, key: &str) -> bool {
        self.sessions.lock().unwrap().get(key).is_some_and(|s| s.running())
    }

    pub fn any_running(&self) -> bool {
        self.sessions.lock().unwrap().values().any(|s| s.running())
    }

    pub fn list(&self) -> Vec<PtyInfo> {
        let map = self.sessions.lock().unwrap();
        map.iter().map(|(k, s)| PtyInfo { key: k.clone(), cwd: s.cwd.clone(), running: s.running() }).collect()
    }
}

fn read_loop(app: AppHandle, key: String, mut reader: Box<dyn Read + Send>, exit_code: Arc<Mutex<Option<u32>>>, is_claude: bool) {
    let mut buf = [0u8; 16 * 1024];
    let mut utf8 = Utf8Stream::default();
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let data = utf8.push(&buf[..n]);
                if !data.is_empty() {
                    let _ = app.emit(EVT_OUTPUT, PtyOutput { key: key.clone(), data });
                }
            }
        }
    }
    let code = *exit_code.lock().unwrap();
    let _ = app.emit(EVT_EXIT, PtyExit { key: key.clone(), code });
    // Conversation terminée (sauf si un nouveau terminal a déjà pris le relais).
    if is_claude {
        use tauri::Manager;
        if !app.state::<PtyManager>().is_running(&key) {
            crate::activity::emit(&app, &key, None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_windows_dirs() {
        let n = normalize_windows_dir;
        assert_eq!(n("c:/Users/moi/Projet"), r"C:\Users\moi\Projet");
        assert_eq!(n(r"C:\Users\moi\Projet\"), r"C:\Users\moi\Projet");
        assert_eq!(n(r"d:\a//b\\c/"), r"D:\a\b\c");
        assert_eq!(n("c:/"), r"C:\");
        assert_eq!(n("c:"), r"C:\");
        assert_eq!(n(r"C:\"), r"C:\");
        assert_eq!(n(r"\\serveur\partage\dossier\"), r"\\serveur\partage\dossier");
        assert_eq!(n("  C:\\x  "), r"C:\x");
        // Déjà normalisé : inchangé.
        let p = r"C:\Users\olivi\OneDrive\Desktop\Projets";
        assert_eq!(n(p), p);
    }

    #[test]
    fn normalizes_unix_dirs() {
        let n = normalize_unix_dir;
        assert_eq!(n("/Users/moi/Projet/"), "/Users/moi/Projet");
        assert_eq!(n("//Users//moi///Projet"), "/Users/moi/Projet");
        assert_eq!(n("  /Users/moi/Mon projet  "), "/Users/moi/Mon projet");
        assert_eq!(n("/"), "/");
        assert_eq!(n("///"), "/");
        // Une barre oblique inverse est un caractère comme un autre sous Unix.
        assert_eq!(n(r"/a/b\c"), r"/a/b\c");
    }

    #[test]
    fn builds_args() {
        let id = "28cde7fb-e61a-4bd9-a66f-10ba27d395a5";
        assert_eq!(resume_args(id).unwrap(), ["--resume", id]);
        assert_eq!(new_session_args(id).unwrap(), ["--session-id", id]);
        assert!(resume_args("x; calc").is_err());
        assert_eq!(new_or_resume_args(id, false).unwrap(), ["--session-id", id]);
        assert_eq!(new_or_resume_args(id, true).unwrap(), ["--resume", id]);
        assert!(new_or_resume_args("x y", false).is_err());

        let mut args = resume_args(id).unwrap();
        args.extend(["--settings".to_string(), r"C:\t\s.json".to_string()]);
        let exe = build_argv(Path::new(r"C:\bin\claude.exe"), &args);
        assert_eq!(exe, [r"C:\bin\claude.exe", "--resume", id, "--settings", r"C:\t\s.json"]);
        let cmd = build_argv(Path::new(r"C:\npm\claude.CMD"), &resume_args(id).unwrap());
        assert_eq!(cmd, ["cmd.exe", "/d", "/c", r"C:\npm\claude.CMD", "--resume", id]);
    }

    #[test]
    fn builds_worktree_args() {
        let id = "28cde7fb-e61a-4bd9-a66f-10ba27d395a5";
        assert_eq!(new_worktree_session_args(id, Some("ma-branche")).unwrap(), ["--worktree", "ma-branche", "--session-id", id]);
        assert_eq!(new_worktree_session_args(id, None).unwrap(), ["--worktree", "--session-id", id]);
        assert_eq!(new_worktree_session_args(id, Some("  ")).unwrap(), ["--worktree", "--session-id", id]);
        assert!(new_worktree_session_args(id, Some("a b")).is_err());
        assert!(new_worktree_session_args("x;y", Some("ok")).is_err());
        // Sans fichier : worktree ; avec fichier : simple reprise ; sans option : comme avant.
        assert_eq!(new_or_resume_worktree_args(id, false, Some("w1")).unwrap(), ["--worktree", "w1", "--session-id", id]);
        assert_eq!(new_or_resume_worktree_args(id, false, Some("")).unwrap(), ["--worktree", "--session-id", id]);
        assert_eq!(new_or_resume_worktree_args(id, true, Some("w1")).unwrap(), ["--resume", id]);
        assert_eq!(new_or_resume_worktree_args(id, false, None).unwrap(), ["--session-id", id]);
    }

    #[test]
    fn validates_worktree_names() {
        for ok in ["feature-auth", "fix_42", "v1.2", "A", "abc.def-ghi_jkl"] {
            assert!(validate_worktree_name(ok).is_ok(), "{ok}");
        }
        let long = "a".repeat(65);
        let bad = ["", "a b", "-x", ".x", "_x", "x.", "a..b", "x.lock", "a/b", r"a\b", "#12", "é", "a:b", "a~b", "a^b", "a*b", "a\"b", &long];
        for b in bad {
            assert!(validate_worktree_name(b).is_err(), "{b}");
        }
    }

    #[test]
    fn finds_session_file_in_any_project() {
        let tmp = tempfile::tempdir().unwrap();
        let id = "28cde7fb-e61a-4bd9-a66f-10ba27d395a5";
        std::fs::create_dir_all(tmp.path().join("C--a")).unwrap();
        std::fs::create_dir_all(tmp.path().join("C--b")).unwrap();
        assert!(!session_file_exists(tmp.path(), id));
        std::fs::write(tmp.path().join("C--b").join(format!("{id}.jsonl")), "{}\n").unwrap();
        assert!(session_file_exists(tmp.path(), id));
        assert!(!session_file_exists(&tmp.path().join("absent"), id));
    }

    #[test]
    fn utf8_stream_handles_split_chars() {
        let mut s = Utf8Stream::default();
        let bytes = "é→ok".as_bytes();
        assert_eq!(s.push(&bytes[..1]), "");
        assert_eq!(s.push(&bytes[1..3]), "é");
        assert_eq!(s.push(&bytes[3..]), "→ok");
        assert_eq!(s.push(&[0xff, b'a']), "\u{FFFD}a");
    }

    /// Vérifie le cycle ConPTY utilisé par `launch` (sortie lue, fin du flux après
    /// fermeture du pseudo-terminal) avec `cmd.exe`. Lancer avec `cargo test -- --ignored`.
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn conpty_roundtrip() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut cmd = CommandBuilder::from_argv(vec!["cmd.exe".into(), "/d".into(), "/c".into(), "echo bonjour".into()]);
        cmd.cwd(normalize_dir(&std::env::temp_dir().to_string_lossy()));
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        // ConPTY demande la position du curseur (`ESC[6n`) au démarrage et attend la
        // réponse ; xterm.js la donne tout seul, ici on la fournit d'avance.
        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"\x1b[1;1R").unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let reading = std::thread::spawn(move || {
            let mut out = Vec::new();
            let _ = reader.read_to_end(&mut out);
            String::from_utf8_lossy(&out).to_string()
        });
        assert!(child.wait().unwrap().success());
        drop(pair.master);
        assert!(reading.join().unwrap().contains("bonjour"));
    }
}

/// Commandes Tauri du terminal intégré (voir `src/pty.ts` côté interface).
pub mod commands {
    use super::{new_or_resume_worktree_args, resume_args, session_file_exists, LaunchSpec, Program, PtyInfo, PtyManager};
    use tauri::{AppHandle, State};

    /// Ouvre (ou retrouve) le terminal d'une conversation et y lance `claude --resume <id>`.
    #[tauri::command]
    pub fn pty_resume(app: AppHandle, ptys: State<PtyManager>, session_id: String, cwd: String, cols: u16, rows: u16) -> Result<PtyInfo, String> {
        let args = resume_args(&session_id)?;
        ptys.launch(&app, LaunchSpec { key: session_id, cwd, program: Program::Claude(args), cols, rows })
    }

    /// Nouvelle conversation créée par l'app : lance `claude --session-id <id>` (identifiant
    /// choisi par l'interface) dans le dossier du projet, ou `--resume` si son fichier existe
    /// déjà (relance après un premier message). `worktree` : absent pour une conversation
    /// normale, sinon nom du nouveau worktree (vide : nom choisi par Claude Code), lancé avec
    /// `claude --worktree [nom] --session-id <id>` (ticket 11).
    #[tauri::command]
    pub fn pty_new_session(
        app: AppHandle,
        state: State<crate::AppState>,
        ptys: State<PtyManager>,
        session_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
        worktree: Option<String>,
    ) -> Result<PtyInfo, String> {
        let exists = session_file_exists(state.scanner.root(), &session_id);
        let args = new_or_resume_worktree_args(&session_id, exists, worktree.as_deref())?;
        ptys.launch(&app, LaunchSpec { key: session_id, cwd, program: Program::Claude(args), cols, rows })
    }

    #[tauri::command]
    pub fn pty_write(ptys: State<PtyManager>, key: String, data: String) -> Result<(), String> {
        ptys.write(&key, &data)
    }

    #[tauri::command]
    pub fn pty_resize(ptys: State<PtyManager>, key: String, cols: u16, rows: u16) -> Result<(), String> {
        ptys.resize(&key, cols, rows)
    }

    #[tauri::command]
    pub fn pty_kill(ptys: State<PtyManager>, key: String) {
        ptys.kill(&key)
    }

    #[tauri::command]
    pub fn pty_list(ptys: State<PtyManager>) -> Vec<PtyInfo> {
        ptys.list()
    }

    /// Fermeture confirmée par l'utilisateur : arrête tous les terminaux puis quitte.
    #[tauri::command]
    pub fn pty_quit(app: AppHandle, ptys: State<PtyManager>) {
        ptys.kill_all();
        app.exit(0);
    }
}

/// À brancher sur `on_window_event` : si un terminal tourne encore, la fermeture de la
/// fenêtre est suspendue et l'interface reçoit `pty-close-requested` pour demander
/// confirmation (puis appelle `pty_quit`).
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    use tauri::Manager;
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.state::<PtyManager>().any_running() {
            api.prevent_close();
            let _ = window.emit("pty-close-requested", ());
        }
    }
}
