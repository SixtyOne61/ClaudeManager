//! macOS : une app lancée depuis le Finder ou le Dock ne reçoit pas le `PATH` du shell de
//! l'utilisateur, seulement `/usr/bin:/bin:/usr/sbin:/sbin`. `claude` (souvent dans
//! `~/.local/bin` ou `/opt/homebrew/bin`), et les outils qu'il lance (git, node…), seraient
//! introuvables. Au démarrage, [`import_login_path`] demande son `PATH` au shell de
//! connexion de l'utilisateur et l'adopte pour l'app et tout ce qu'elle lance.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::PathBuf;

/// Balise qui encadre le `PATH` dans la sortie du shell (les fichiers de démarrage de
/// l'utilisateur peuvent afficher autre chose).
const MARK: &str = "__CLAUDE_MANAGER_PATH__";

/// Texte entre les deux premières balises.
pub fn extract_marked(output: &str) -> Option<&str> {
    let start = output.find(MARK)? + MARK.len();
    let len = output[start..].find(MARK)?;
    Some(&output[start..start + len]).filter(|s| !s.trim().is_empty())
}

/// `PATH` final : celui du shell, puis l'actuel, puis les emplacements habituels, sans
/// doublon ni dossier vide.
pub fn merge_paths(parts: &[&str]) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for dir in parts.iter().flat_map(|p| p.split(':')) {
        if !dir.is_empty() && !seen.contains(&dir) {
            seen.push(dir);
        }
    }
    seen.join(":")
}

/// Emplacements d'installation habituels de `claude` et des outils de développement.
fn usual_dirs() -> Vec<String> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".claude/local"));
    }
    dirs.extend(["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"].map(PathBuf::from));
    dirs.into_iter().map(|d| d.to_string_lossy().into_owned()).collect()
}

/// Lance le shell de connexion de l'utilisateur (interactif, pour lire aussi `.zshrc`) et
/// renvoie son `PATH`. Abandonne au bout de 5 secondes (fichier de démarrage qui attend une
/// saisie, par exemple).
#[cfg(target_os = "macos")]
fn login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
    let script = format!("printf '%s%s%s' '{MARK}' \"$PATH\" '{MARK}'");
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        out
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = reader.join().ok()?;
    extract_marked(&out).map(str::to_string)
}

/// Adopte le `PATH` du shell de connexion (voir le module). Sans effet en cas d'échec,
/// hormis l'ajout des emplacements habituels.
#[cfg(target_os = "macos")]
pub fn import_login_path() {
    let shell = login_shell_path().unwrap_or_default();
    let current = std::env::var("PATH").unwrap_or_default();
    let usual = usual_dirs().join(":");
    let path = merge_paths(&[&shell, &current, &usual]);
    // SAFETY : appelé au tout début de `run`, avant le démarrage du moindre autre thread.
    unsafe { std::env::set_var("PATH", path) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_path_between_marks() {
        let out = format!("Bienvenue !\n{MARK}/opt/homebrew/bin:/usr/bin{MARK}\nau revoir");
        assert_eq!(extract_marked(&out), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(extract_marked("rien"), None);
        assert_eq!(extract_marked(&format!("{MARK}/usr/bin")), None);
        assert_eq!(extract_marked(&format!("{MARK}  {MARK}")), None);
    }

    #[test]
    fn merges_without_duplicates() {
        assert_eq!(
            merge_paths(&["/a:/b", "/usr/bin:/a::/bin", "/b:/c"]),
            "/a:/b:/usr/bin:/bin:/c"
        );
        assert_eq!(merge_paths(&["", "/usr/bin"]), "/usr/bin");
    }
}
