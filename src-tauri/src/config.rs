//! Données propres à l'application, dans `%APPDATA%\claude-manager\config.json`.
//!
//! Claude Code reste la source de vérité pour les projets et conversations ; ce fichier
//! ne contient que l'organisation personnelle : catégories, couleurs, noms d'affichage,
//! projets créés depuis l'appli et liste des archives.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const CONFIG_VERSION: u32 = 1;

/// Une catégorie, avec la liste ordonnée des projets qu'elle contient.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Category {
    pub id: String,
    pub name: String,
    /// Couleur de fond (`#rrggbb`), ou `None` pour la couleur par défaut.
    pub color: Option<String>,
    /// Clés des projets (nom de dossier encodé), dans l'ordre d'affichage.
    pub project_keys: Vec<String>,
}

/// Préférences d'un projet.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectPrefs {
    pub display_name: Option<String>,
    pub color: Option<String>,
    /// Chemin du dossier, renseigné pour les projets créés depuis l'appli
    /// (ils n'ont pas encore de conversation, donc pas de `cwd` à lire).
    pub path: Option<String>,
}

/// Une conversation archivée, avec tout ce qu'il faut pour la restaurer.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ArchiveEntry {
    pub session_id: String,
    pub project_key: String,
    pub project_path: Option<String>,
    pub title: String,
    pub message_count: u32,
    pub updated_at: Option<String>,
    /// Date d'archivage (ms depuis l'époque Unix).
    pub archived_at: u64,
    /// Emplacements d'origine, pour la restauration.
    pub original_file: String,
    pub original_dir: Option<String>,
    /// Emplacements dans le dossier d'archive.
    pub archived_file: String,
    pub archived_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub version: u32,
    /// Catégories, dans l'ordre d'affichage.
    pub categories: Vec<Category>,
    /// Préférences par clé de projet.
    pub projects: HashMap<String, ProjectPrefs>,
    /// Gérée uniquement par le backend (archiver / restaurer).
    pub archives: Vec<ArchiveEntry>,
    pub show_temp_projects: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            categories: Vec::new(),
            projects: HashMap::new(),
            archives: Vec::new(),
            show_temp_projects: false,
        }
    }
}

/// Emplacements des fichiers de l'appli.
#[derive(Debug, Clone)]
pub struct AppPaths {
    /// `%APPDATA%\claude-manager`
    pub app_dir: PathBuf,
    pub config_file: PathBuf,
    pub cache_file: PathBuf,
    pub archive_dir: PathBuf,
    /// `~/.claude/projects` (ou `$CLAUDE_CONFIG_DIR/projects`).
    pub claude_projects: PathBuf,
}

impl AppPaths {
    pub fn detect() -> Self {
        let app_dir = dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("claude-manager");
        let claude_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"));
        Self {
            config_file: app_dir.join("config.json"),
            cache_file: app_dir.join("cache.json"),
            archive_dir: app_dir.join("archive"),
            claude_projects: claude_dir.join("projects"),
            app_dir,
        }
    }
}

/// Charge la configuration. Un fichier absent donne une configuration vide ;
/// un fichier illisible est sauvegardé à part (`config.json.bad-<date>`) au lieu d'être écrasé.
pub fn load(path: &Path) -> Config {
    let Ok(text) = fs::read_to_string(path) else { return Config::default() };
    match serde_json::from_str::<Config>(&text) {
        Ok(cfg) => cfg,
        Err(_) => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = fs::copy(path, path.with_extension(format!("json.bad-{stamp}")));
            Config::default()
        }
    }
}

pub fn save(path: &Path, cfg: &Config) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(cfg).map_err(std::io::Error::other)?;
    write_atomic(path, text.as_bytes())
}

/// Écrit dans un fichier temporaire puis le renomme : jamais de fichier à moitié écrit.
pub fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        assert!(load(&p).categories.is_empty());

        let mut cfg = Config::default();
        cfg.categories.push(Category { id: "c1".into(), name: "Perso".into(), ..Default::default() });
        save(&p, &cfg).unwrap();
        assert_eq!(load(&p).categories[0].name, "Perso");

        // Champs inconnus / manquants tolérés.
        fs::write(&p, r#"{"categories":[{"name":"X","futur":1}]}"#).unwrap();
        assert_eq!(load(&p).categories[0].name, "X");

        // Fichier corrompu : configuration vide, original conservé à part.
        fs::write(&p, "{oups").unwrap();
        assert!(load(&p).categories.is_empty());
        assert!(fs::read_dir(dir.path()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains("bad-")));
    }
}
