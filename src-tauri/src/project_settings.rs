// Réglages Claude Code propres à un projet, écrits dans `<projet>/.claude/settings.local.json`
// (réglages personnels du projet, non partagés avec l'équipe).

use crate::ui_error::ui_err;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::Path;

/// Fixe la langue dans laquelle Claude répond dans ce projet (réglage `language` de
/// Claude Code). Les autres réglages déjà présents dans le fichier sont conservés.
pub fn set_language(project_dir: &Path, language: &str) -> Result<(), String> {
    let dir = project_dir.join(".claude");
    let file = dir.join("settings.local.json");
    let mut settings: Map<String, Value> = match fs::read_to_string(&file) {
        Ok(text) if !text.trim().is_empty() => serde_json::from_str(&text)
            .map_err(|e| failed("projectSettings.invalidJson", &file, e))?,
        _ => Map::new(),
    };
    settings.insert("language".into(), Value::String(language.to_string()));
    fs::create_dir_all(&dir).map_err(|e| failed("projectSettings.createDirFailed", &dir, e))?;
    let text = serde_json::to_string_pretty(&Value::Object(settings)).unwrap();
    fs::write(&file, text + "\n").map_err(|e| failed("projectSettings.writeFailed", &file, e))
}

/// Erreur codée avec le chemin concerné et le détail technique.
fn failed(code: &str, path: &Path, e: impl std::fmt::Display) -> String {
    ui_err(code, json!({ "path": path.display().to_string(), "detail": e.to_string() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(dir: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(dir.join(".claude/settings.local.json")).unwrap()).unwrap()
    }

    #[test]
    fn cree_le_fichier_si_absent() {
        let tmp = tempfile::tempdir().unwrap();
        set_language(tmp.path(), "french").unwrap();
        assert_eq!(read(tmp.path()), serde_json::json!({ "language": "french" }));
    }

    #[test]
    fn conserve_les_autres_reglages() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join(".claude")).unwrap();
        fs::write(
            tmp.path().join(".claude/settings.local.json"),
            r#"{ "permissions": { "allow": ["Bash(ls)"] }, "language": "english" }"#,
        )
        .unwrap();
        set_language(tmp.path(), "spanish").unwrap();
        assert_eq!(
            read(tmp.path()),
            serde_json::json!({ "permissions": { "allow": ["Bash(ls)"] }, "language": "spanish" })
        );
    }

    #[test]
    fn refuse_un_fichier_invalide_sans_l_ecraser() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join(".claude")).unwrap();
        let file = tmp.path().join(".claude/settings.local.json");
        fs::write(&file, "{ pas du json").unwrap();
        assert!(set_language(tmp.path(), "french").is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "{ pas du json");
    }
}
