//! « Ouvrir dans Desktop » : rouvre une conversation dans Claude Desktop avec
//! `claude --desktop --resume <id>`, lancé sans fenêtre visible.
//!
//! Claude Code se charge lui-même du transfert vers Desktop. En cas d'échec (Desktop
//! absent, Claude Code trop ancien, connexion autre qu'un abonnement…), son message
//! d'erreur est renvoyé tel quel à l'interface.

use crate::actions::validate_session_id;
use std::io::Read;
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Préfixe d'erreur reconnu par l'interface : le worktree de la conversation n'existe plus.
pub const ERR_WORKTREE_MISSING: &str = "WORKTREE_MISSING";

/// Délai au-delà duquel on considère que Claude Code ne répondra plus.
const TIMEOUT: Duration = Duration::from_secs(60);

/// Dossier depuis lequel lancer la commande.
#[derive(Debug, PartialEq, Eq)]
pub struct DesktopDir {
    pub dir: String,
    /// Le dossier de la conversation (un worktree supprimé, en général) n'existe plus :
    /// Desktop affichera « Failed to load session ».
    pub worktree_missing: bool,
}

/// Choisit le dossier de lancement : celui de la conversation s'il existe encore,
/// sinon celui du projet. `exists` est injecté pour les tests.
pub fn choose_dir(
    session_cwd: Option<&str>,
    project_path: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> Result<DesktopDir, String> {
    let cwd = session_cwd.filter(|c| !c.is_empty());
    let project = project_path.filter(|p| !p.is_empty());
    if let Some(c) = cwd.filter(|c| exists(c)) {
        return Ok(DesktopDir { dir: c.to_string(), worktree_missing: false });
    }
    match project.filter(|p| exists(p)) {
        Some(p) => Ok(DesktopDir {
            dir: p.to_string(),
            // Dossier de la conversation disparu et différent du projet : worktree supprimé.
            worktree_missing: cwd.is_some_and(|c| !same_path(c, p)),
        }),
        None => Err(match cwd.or(project) {
            Some(d) => format!("Le dossier de la conversation n'existe plus : {d}"),
            None => "Dossier de la conversation inconnu.".to_string(),
        }),
    }
}

/// Compare deux chemins Windows sans tenir compte de la casse ni du séparateur final.
fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase();
    norm(a) == norm(b)
}

/// Arguments passés à `claude`.
pub fn desktop_args(session_id: &str) -> Result<Vec<String>, String> {
    validate_session_id(session_id)?;
    Ok(vec!["--desktop".into(), "--resume".into(), session_id.into()])
}

/// Message d'erreur à afficher quand la commande a échoué : la sortie d'erreur de
/// Claude Code telle quelle, sinon sa sortie standard, sinon le code de sortie.
pub fn failure_message(code: Option<i32>, stdout: &str, stderr: &str) -> String {
    if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        match code {
            Some(c) => format!("Claude Code s'est arrêté avec le code {c}."),
            None => "Claude Code s'est arrêté de façon inattendue.".to_string(),
        }
    }
}

/// Lance `claude --desktop --resume <id>` dans `dir`, sans fenêtre, et attend sa fin.
pub fn open_in_desktop(dir: &str, session_id: &str) -> Result<(), String> {
    let args = desktop_args(session_id)?;
    if !Path::new(dir).is_dir() {
        return Err(format!("Dossier introuvable : {dir}"));
    }
    let build = |program: &str, prefix: &[&str]| {
        let mut cmd = Command::new(program);
        cmd.args(prefix)
            .args(&args)
            .current_dir(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    // `claude.exe` d'abord ; sinon via cmd.exe pour une installation npm (`claude.cmd`).
    // L'identifiant est validé (lettres, chiffres, tirets) : rien à interpréter par cmd.
    let child = match build("claude", &[]).spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => build("cmd.exe", &["/D", "/C", "claude"])
            .spawn()
            .map_err(|e| format!("Impossible de lancer Claude Code : {e}"))?,
        Err(e) => return Err(format!("Impossible de lancer Claude Code : {e}")),
    };
    let (status, stdout, stderr) = wait_with_timeout(child, TIMEOUT)?;
    if status.success() {
        Ok(())
    } else {
        Err(failure_message(status.code(), &stdout, &stderr))
    }
}

/// Attend la fin du processus en lisant ses sorties (dans des threads, pour ne pas
/// bloquer sur un tampon plein). Au-delà de `timeout`, le processus est arrêté.
fn wait_with_timeout(mut child: std::process::Child, timeout: Duration) -> Result<(ExitStatus, String, String), String> {
    let read_all = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).to_string()
        })
    };
    let out = read_all(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = read_all(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Claude Code n'a pas répondu en {} s.", timeout.as_secs()));
            }
            Err(e) => return Err(format!("Claude Code : {e}")),
        }
    };
    Ok((status, out.join().unwrap_or_default(), err.join().unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exists_in<'a>(list: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |p| list.contains(&p)
    }

    #[test]
    fn prefers_conversation_folder() {
        let d = choose_dir(Some(r"C:\p\.claude\worktrees\w"), Some(r"C:\p"), exists_in(&[r"C:\p\.claude\worktrees\w", r"C:\p"])).unwrap();
        assert_eq!(d, DesktopDir { dir: r"C:\p\.claude\worktrees\w".into(), worktree_missing: false });
    }

    #[test]
    fn falls_back_to_project_and_flags_missing_worktree() {
        let d = choose_dir(Some(r"C:\p\.claude\worktrees\w"), Some(r"C:\p"), exists_in(&[r"C:\p"])).unwrap();
        assert_eq!(d, DesktopDir { dir: r"C:\p".into(), worktree_missing: true });
    }

    #[test]
    fn same_folder_is_not_a_missing_worktree() {
        // cwd inconnu, ou identique au projet à la casse près : pas d'avertissement.
        let d = choose_dir(None, Some(r"C:\p"), exists_in(&[r"C:\p"])).unwrap();
        assert!(!d.worktree_missing);
        let d = choose_dir(Some(r"c:\P\"), Some(r"C:\p"), exists_in(&[r"C:\p"])).unwrap();
        assert!(!d.worktree_missing);
    }

    #[test]
    fn errors_when_no_folder_exists() {
        assert!(choose_dir(Some(r"C:\w"), Some(r"C:\p"), exists_in(&[])).unwrap_err().contains(r"C:\w"));
        assert!(choose_dir(None, None, exists_in(&[])).is_err());
    }

    #[test]
    fn builds_args_and_rejects_bad_ids() {
        assert_eq!(desktop_args("28cde7fb-e61a").unwrap(), vec!["--desktop", "--resume", "28cde7fb-e61a"]);
        assert!(desktop_args("x & calc").is_err());
    }

    #[test]
    fn failure_message_keeps_stderr_as_is() {
        assert_eq!(failure_message(Some(1), "out", "  Error: Desktop not installed\n"), "Error: Desktop not installed");
        assert_eq!(failure_message(Some(1), "only stdout\n", ""), "only stdout");
        assert!(failure_message(Some(3), "", " ").contains('3'));
    }
}
