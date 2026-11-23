//! Actions qui touchent au disque : lancer Claude, archiver, restaurer, mettre à la Corbeille.
//!
//! Ce sont les SEULES opérations qui modifient les fichiers de Claude Code, et uniquement
//! à la demande de l'utilisateur. Rien n'est jamais supprimé définitivement.

use crate::config::ArchiveEntry;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Une session modifiée il y a moins de ce délai est peut-être encore ouverte dans Claude.
const ACTIVE_WINDOW_MS: u64 = 120_000;

/// Préfixe d'erreur reconnu par l'interface pour proposer de forcer l'action.
pub const ERR_ACTIVE: &str = "SESSION_ACTIVE";

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Un identifiant de session ne contient que des lettres, chiffres et tirets (UUID).
/// Vérifié avant de le passer à une ligne de commande ou de construire un chemin.
pub fn validate_session_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err(format!("Identifiant de session invalide : {id}"))
    }
}

/// Une clé de projet est un nom de dossier simple (pas de séparateur, pas de `..`).
pub fn validate_project_key(key: &str) -> Result<(), String> {
    if !key.is_empty() && !key.contains(['/', '\\', ':']) && key != "." && key != ".." {
        Ok(())
    } else {
        Err(format!("Clé de projet invalide : {key}"))
    }
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

/// Terminal utilisé pour lancer Claude.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Terminal {
    WindowsTerminal,
    PowerShell,
    /// Terminal de macOS (`Terminal.app`).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    MacTerminal,
    /// iTerm2, sous macOS.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    ITerm,
}

impl Terminal {
    pub fn label(self) -> &'static str {
        match self {
            Terminal::WindowsTerminal => "Windows Terminal",
            Terminal::PowerShell => "PowerShell",
            Terminal::MacTerminal => "Terminal",
            Terminal::ITerm => "iTerm",
        }
    }
}

/// macOS : iTerm2 s'il est installé, sinon le Terminal du système.
#[cfg(target_os = "macos")]
pub fn detect_terminal() -> Terminal {
    let home_apps = dirs::home_dir().map(|h| h.join("Applications/iTerm.app"));
    if Path::new("/Applications/iTerm.app").is_dir() || home_apps.is_some_and(|p| p.is_dir()) {
        Terminal::ITerm
    } else {
        Terminal::MacTerminal
    }
}

/// Windows Terminal est présent si `wt.exe` est trouvable (alias d'exécution dans WindowsApps).
#[cfg(not(target_os = "macos"))]
pub fn detect_terminal() -> Terminal {
    let alias = dirs::data_local_dir().map(|d| d.join(r"Microsoft\WindowsApps\wt.exe"));
    if alias.is_some_and(|p| p.exists()) {
        return Terminal::WindowsTerminal;
    }
    let mut where_cmd = Command::new("where");
    where_cmd.arg("wt.exe");
    #[cfg(windows)]
    where_cmd.creation_flags(CREATE_NO_WINDOW);
    match where_cmd.output() {
        Ok(out) if out.status.success() => Terminal::WindowsTerminal,
        _ => Terminal::PowerShell,
    }
}

/// Ouvre un terminal dans `dir` et y lance `claude` (ou `claude --resume <id>`).
/// La fenêtre reste ouverte après la fin de Claude (`-NoExit`).
pub fn launch_claude(terminal: Terminal, dir: &str, session_id: Option<&str>) -> Result<(), String> {
    if !Path::new(dir).is_dir() {
        return Err(format!("Le dossier du projet n'existe plus : {dir}"));
    }
    let claude_cmd = match session_id {
        Some(id) => {
            validate_session_id(id)?;
            format!("claude --resume {id}")
        }
        None => "claude".to_string(),
    };

    if matches!(terminal, Terminal::MacTerminal | Terminal::ITerm) {
        return open_mac_terminal(terminal, &format!("cd {} && {claude_cmd}", shell_quote(dir)));
    }

    let spawn = |t: Terminal| -> std::io::Result<std::process::Child> {
        match t {
            Terminal::MacTerminal | Terminal::ITerm => unreachable!(),
            Terminal::WindowsTerminal => {
                // Les arguments sont passés séparément : pas d'interprétation par un shell.
                Command::new("wt.exe")
                    .args(["-d", dir, "powershell.exe", "-NoExit", "-Command", &claude_cmd])
                    .current_dir(dir)
                    .spawn()
            }
            Terminal::PowerShell => {
                let mut cmd = Command::new("powershell.exe");
                cmd.args(["-NoExit", "-Command", &claude_cmd]).current_dir(dir);
                #[cfg(windows)]
                cmd.creation_flags(CREATE_NEW_CONSOLE);
                cmd.spawn()
            }
        }
    };

    match spawn(terminal) {
        Ok(_) => Ok(()),
        // Si Windows Terminal échoue, on se rabat sur PowerShell.
        Err(_) if terminal == Terminal::WindowsTerminal => {
            spawn(Terminal::PowerShell).map(|_| ()).map_err(|e| format!("Impossible d'ouvrir un terminal : {e}"))
        }
        Err(e) => Err(format!("Impossible d'ouvrir un terminal : {e}")),
    }
}

/// Entoure un texte d'apostrophes pour un shell POSIX (`'` devient `'\''`).
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Script AppleScript qui ouvre une fenêtre du Terminal et y tape la ligne de commande
/// passée en argument (`item 1 of argv`) : aucun texte à échapper pour AppleScript.
const OSA_TERMINAL: &str = r#"on run argv
    tell application "Terminal"
        activate
        do script (item 1 of argv)
    end tell
end run"#;

/// Même chose dans une nouvelle fenêtre d'iTerm2.
const OSA_ITERM: &str = r#"on run argv
    tell application "iTerm"
        activate
        set w to (create window with default profile)
        tell current session of w to write text (item 1 of argv)
    end tell
end run"#;

/// macOS : ouvre une fenêtre de terminal qui exécute `command_line` dans le shell de
/// l'utilisateur. La fenêtre reste ouverte après la commande. Si iTerm échoue, le Terminal
/// du système prend le relais.
pub fn open_mac_terminal(terminal: Terminal, command_line: &str) -> Result<(), String> {
    let run = |script: &str| -> Result<(), String> {
        let out = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .arg(command_line)
            .output()
            .map_err(|e| format!("Impossible d'ouvrir un terminal : {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("Impossible d'ouvrir un terminal : {}", String::from_utf8_lossy(&out.stderr).trim()))
        }
    };
    match terminal {
        Terminal::ITerm => run(OSA_ITERM).or_else(|_| run(OSA_TERMINAL)),
        _ => run(OSA_TERMINAL),
    }
}

/// Ouvre un dossier dans le gestionnaire de fichiers (Explorateur, Finder…).
pub fn open_folder(dir: &str) -> Result<(), String> {
    if !Path::new(dir).is_dir() {
        return Err(format!("Dossier introuvable : {dir}"));
    }
    let opener = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Command::new(opener).arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Déplacements de fichiers
// ---------------------------------------------------------------------------

/// Déplace un fichier ou un dossier. `rename` d'abord ; si la destination est sur un
/// autre volume, copie puis suppression de la source (la source n'est retirée qu'une
/// fois la copie terminée sans erreur).
fn move_path(from: &Path, to: &Path) -> std::io::Result<()> {
    if to.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("La destination existe déjà : {}", to.display()),
        ));
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_recursive(from, to)?;
    if from.is_dir() { fs::remove_dir_all(from) } else { fs::remove_file(from) }
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}

/// Fichier `.jsonl` d'une session et son dossier compagnon (`<id>/`), s'il existe.
pub struct SessionFiles {
    pub file: PathBuf,
    pub dir: Option<PathBuf>,
}

impl SessionFiles {
    pub fn locate(projects_root: &Path, project_key: &str, session_id: &str) -> Result<Self, String> {
        validate_project_key(project_key)?;
        validate_session_id(session_id)?;
        let base = projects_root.join(project_key);
        let file = base.join(format!("{session_id}.jsonl"));
        if !file.is_file() {
            return Err(format!("Conversation introuvable : {}", file.display()));
        }
        let dir = Some(base.join(session_id)).filter(|d| d.is_dir());
        Ok(Self { file, dir })
    }

    /// Refuse si le fichier vient d'être modifié (Claude l'utilise peut-être encore).
    pub fn check_not_active(&self) -> Result<(), String> {
        let recent = crate::sessions::file_stamp(&self.file)
            .is_some_and(|(mtime, _)| now_ms().saturating_sub(mtime) < ACTIVE_WINDOW_MS);
        if recent {
            Err(format!("{ERR_ACTIVE}: cette conversation a été modifiée il y a moins de 2 minutes, elle est peut-être encore ouverte."))
        } else {
            Ok(())
        }
    }

    /// Avant d'ouvrir la conversation dans le terminal intégré : refuse (erreur préfixée
    /// `SESSION_ACTIVE`, que l'interface propose de forcer) si le fichier vient d'être
    /// modifié par un autre programme. `released_at` : moment où l'app a elle-même fermé
    /// son terminal pour cette conversation, s'il y en a eu un.
    pub fn check_not_open_elsewhere(&self, released_at: Option<u64>) -> Result<(), String> {
        let open = crate::sessions::file_stamp(&self.file)
            .is_some_and(|(mtime, _)| may_be_open_elsewhere(mtime, now_ms(), released_at));
        if open {
            Err(format!(
                "{ERR_ACTIVE}: cette conversation a été modifiée il y a moins de 2 minutes, elle est peut-être ouverte dans Claude Desktop ou dans un autre terminal."
            ))
        } else {
            Ok(())
        }
    }
}

/// Marge pour les dernières écritures de `claude` juste après la fermeture de son terminal.
const RELEASE_MARGIN_MS: u64 = 5_000;

/// Vrai si un fichier modifié à `mtime` est peut-être encore ouvert ailleurs : modifié il
/// y a moins de 2 minutes, et pas par un terminal de l'app fermé depuis (`released_at`).
pub fn may_be_open_elsewhere(mtime: u64, now: u64, released_at: Option<u64>) -> bool {
    let recent = now.saturating_sub(mtime) < ACTIVE_WINDOW_MS;
    let written_by_app = released_at.is_some_and(|r| mtime <= r.saturating_add(RELEASE_MARGIN_MS));
    recent && !written_by_app
}

/// Archive une session : déplace le `.jsonl` (et son dossier) vers
/// `<archive_dir>/<projet>/` et écrit un manifeste `<id>.archive.json` à côté,
/// qui permet la restauration même sans `config.json`.
pub fn archive(
    files: &SessionFiles,
    archive_dir: &Path,
    mut entry: ArchiveEntry,
) -> Result<ArchiveEntry, String> {
    let dest_base = archive_dir.join(&entry.project_key);
    let dest_file = dest_base.join(format!("{}.jsonl", entry.session_id));
    let dest_dir = files.dir.as_ref().map(|_| dest_base.join(&entry.session_id));

    entry.original_file = files.file.to_string_lossy().to_string();
    entry.original_dir = files.dir.as_ref().map(|d| d.to_string_lossy().to_string());
    entry.archived_file = dest_file.to_string_lossy().to_string();
    entry.archived_dir = dest_dir.as_ref().map(|d| d.to_string_lossy().to_string());
    entry.archived_at = now_ms();

    if dest_file.exists() || dest_dir.as_ref().is_some_and(|d| d.exists()) {
        return Err("Une archive de cette conversation existe déjà.".into());
    }
    move_path(&files.file, &dest_file).map_err(|e| format!("Archivage impossible : {e}"))?;
    if let (Some(src), Some(dst)) = (&files.dir, &dest_dir) {
        if let Err(e) = move_path(src, dst) {
            // On remet le .jsonl en place pour ne pas laisser une session à moitié archivée.
            let _ = move_path(&dest_file, &files.file);
            return Err(format!("Archivage impossible : {e}"));
        }
    }
    let manifest = serde_json::to_string_pretty(&entry).unwrap_or_default();
    let _ = crate::config::write_atomic(&dest_base.join(format!("{}.archive.json", entry.session_id)), manifest.as_bytes());
    Ok(entry)
}

/// Remet une session archivée à son emplacement d'origine.
pub fn restore(entry: &ArchiveEntry) -> Result<(), String> {
    let archived_file = PathBuf::from(&entry.archived_file);
    let original_file = PathBuf::from(&entry.original_file);
    if !archived_file.is_file() {
        return Err(format!("Fichier d'archive introuvable : {}", archived_file.display()));
    }
    if original_file.exists() {
        return Err("Une conversation avec le même identifiant existe déjà à l'emplacement d'origine.".into());
    }
    move_path(&archived_file, &original_file).map_err(|e| format!("Restauration impossible : {e}"))?;
    if let (Some(a), Some(o)) = (&entry.archived_dir, &entry.original_dir) {
        let (a, o) = (PathBuf::from(a), PathBuf::from(o));
        if a.is_dir() && !o.exists() {
            move_path(&a, &o).map_err(|e| format!("Dossier de la session non restauré : {e}"))?;
        }
    }
    let _ = fs::remove_file(manifest_path(entry));
    Ok(())
}

fn manifest_path(entry: &ArchiveEntry) -> PathBuf {
    PathBuf::from(&entry.archived_file).with_extension("archive.json")
}

/// Envoie des fichiers / dossiers dans la Corbeille Windows (récupérables).
pub fn to_trash(paths: &[PathBuf]) -> Result<(), String> {
    let existing: Vec<&PathBuf> = paths.iter().filter(|p| p.exists()).collect();
    if existing.is_empty() {
        return Ok(());
    }
    trash::delete_all(existing).map_err(|e| format!("Envoi à la Corbeille impossible : {e}"))
}

/// Met à la Corbeille une session archivée (fichier, dossier et manifeste).
pub fn trash_archive(entry: &ArchiveEntry) -> Result<(), String> {
    let mut paths = vec![PathBuf::from(&entry.archived_file), manifest_path(entry)];
    if let Some(d) = &entry.archived_dir {
        paths.push(PathBuf::from(d));
    }
    to_trash(&paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, id: &str) -> ArchiveEntry {
        ArchiveEntry { session_id: id.into(), project_key: key.into(), ..Default::default() }
    }

    #[test]
    fn rejects_bad_ids() {
        assert!(validate_session_id("28cde7fb-e61a-4bd9-a66f-10ba27d395a5").is_ok());
        assert!(validate_session_id("x; rm -rf").is_err());
        assert!(validate_session_id("..\\..").is_err());
        assert!(validate_project_key("C--Users-x").is_ok());
        assert!(validate_project_key("..").is_err());
        assert!(validate_project_key("a\\b").is_err());
    }

    #[test]
    fn quotes_for_posix_shell() {
        assert_eq!(shell_quote("/Users/moi/Mon projet"), "'/Users/moi/Mon projet'");
        assert_eq!(shell_quote("/a/l'été"), r"'/a/l'\''été'");
        assert_eq!(shell_quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
    }

    #[test]
    fn archive_then_restore_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        let archive_dir = tmp.path().join("archive");
        let proj = projects.join("C--p");
        fs::create_dir_all(proj.join("s1").join("subagents")).unwrap();
        fs::write(proj.join("s1.jsonl"), "{}\n").unwrap();
        fs::write(proj.join("s1").join("subagents").join("a.jsonl"), "x").unwrap();

        let files = SessionFiles::locate(&projects, "C--p", "s1").unwrap();
        // Fichier tout juste écrit : considéré comme actif.
        assert!(files.check_not_active().unwrap_err().starts_with(ERR_ACTIVE));

        let e = archive(&files, &archive_dir, entry("C--p", "s1")).unwrap();
        assert!(!proj.join("s1.jsonl").exists() && !proj.join("s1").exists());
        assert!(archive_dir.join("C--p").join("s1.jsonl").exists());
        assert!(archive_dir.join("C--p").join("s1").join("subagents").join("a.jsonl").exists());
        assert!(archive_dir.join("C--p").join("s1.archive.json").exists());

        restore(&e).unwrap();
        assert!(proj.join("s1.jsonl").exists());
        assert!(proj.join("s1").join("subagents").join("a.jsonl").exists());
        assert!(!archive_dir.join("C--p").join("s1.jsonl").exists());
        assert!(!archive_dir.join("C--p").join("s1.archive.json").exists());
    }

    #[test]
    fn open_elsewhere_window() {
        let now = 10_000_000;
        // Modifiée il y a 30 s, par un autre programme.
        assert!(may_be_open_elsewhere(now - 30_000, now, None));
        // Modifiée il y a 3 min : plus d'avertissement.
        assert!(!may_be_open_elsewhere(now - 180_000, now, None));
        // Dernière écriture faite par le terminal de l'app, fermé il y a 20 s.
        assert!(!may_be_open_elsewhere(now - 21_000, now, Some(now - 20_000)));
        // Écriture juste après la fermeture (fin de `claude`) : toujours l'app.
        assert!(!may_be_open_elsewhere(now - 18_000, now, Some(now - 20_000)));
        // Modifiée bien après la fermeture du terminal de l'app : un autre programme.
        assert!(may_be_open_elsewhere(now - 5_000, now, Some(now - 60_000)));

        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("k")).unwrap();
        fs::write(tmp.path().join("k").join("s.jsonl"), "{}\n").unwrap();
        let files = SessionFiles::locate(tmp.path(), "k", "s").unwrap();
        assert!(files.check_not_open_elsewhere(None).unwrap_err().starts_with(ERR_ACTIVE));
        assert!(files.check_not_open_elsewhere(Some(now_ms())).is_ok());
    }

    #[test]
    fn restore_refuses_to_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        let proj = projects.join("k");
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join("s.jsonl"), "a").unwrap();
        let files = SessionFiles::locate(&projects, "k", "s").unwrap();
        let e = archive(&files, &tmp.path().join("arch"), entry("k", "s")).unwrap();
        fs::write(proj.join("s.jsonl"), "nouveau").unwrap();
        assert!(restore(&e).is_err());
        assert_eq!(fs::read_to_string(proj.join("s.jsonl")).unwrap(), "nouveau");
    }
}
