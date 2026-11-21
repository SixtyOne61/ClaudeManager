//! Données propres à l'application, dans `%APPDATA%\claude-manager\config.json`.
//!
//! Claude Code reste la source de vérité pour les projets et conversations ; ce fichier
//! ne contient que l'organisation personnelle : catégories, couleurs, noms d'affichage,
//! sections, préférences par conversation, projets créés depuis l'appli et liste des archives.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Historique :
/// - 1 : catégories, préférences de projet, archives.
/// - 2 : sections dans les projets (`ProjectPrefs::sections`) et préférences par
///   conversation (`Config::conversations`). Champs nouveaux avec valeur par défaut :
///   un fichier en version 1 se lit tel quel, sans perte.
pub const CONFIG_VERSION: u32 = 2;

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
    /// Sections du projet, dans l'ordre d'affichage. Les conversations absentes de toutes
    /// les sections sont affichées sous « Sans section ».
    pub sections: Vec<Section>,
}

/// Une section : regroupement de conversations à l'intérieur d'un projet (pas d'imbrication).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Section {
    pub id: String,
    pub name: String,
    /// Couleur de fond (`#rrggbb`), ou `None` pour la couleur par défaut.
    pub color: Option<String>,
    /// Identifiants des conversations de la section. Une conversation archivée y reste,
    /// pour retrouver sa section à la restauration.
    pub conversation_ids: Vec<String>,
    pub collapsed: bool,
}

/// Préférences d'une conversation (conservées à l'archivage et à la restauration).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ConversationPrefs {
    /// Couleur de fond (`#rrggbb`), ou `None` pour la couleur par défaut.
    pub color: Option<String>,
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
    /// Préférences par identifiant de conversation.
    pub conversations: HashMap<String, ConversationPrefs>,
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
            conversations: HashMap::new(),
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
        Ok(cfg) => migrate(cfg),
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

/// Met une configuration lue sur disque au format courant.
/// 1 → 2 : rien à convertir, les nouveaux champs prennent leur valeur par défaut.
pub fn migrate(mut cfg: Config) -> Config {
    if cfg.version < CONFIG_VERSION {
        cfg.version = CONFIG_VERSION;
    }
    cfg
}

/// Retire les conversations qui n'existent plus des sections et des préférences par
/// conversation. `existing` : identifiants des conversations présentes sur le disque ;
/// les conversations archivées sont conservées (elles retrouvent ainsi leur section et
/// leur couleur à la restauration). Une conversation présente dans plusieurs sections
/// n'est gardée que dans la première. Renvoie `true` si quelque chose a changé.
pub fn prune_conversations(cfg: &mut Config, existing: &HashSet<String>) -> bool {
    let archived: HashSet<String> = cfg.archives.iter().map(|a| a.session_id.clone()).collect();
    let keep = |id: &str| existing.contains(id) || archived.contains(id);
    let mut changed = false;
    let mut seen = HashSet::new();
    // Ordre stable des projets, pour que le choix entre doublons soit reproductible.
    let mut keys: Vec<String> = cfg.projects.keys().cloned().collect();
    keys.sort();
    for key in keys {
        let prefs = cfg.projects.get_mut(&key).expect("clé lue juste avant");
        for section in &mut prefs.sections {
            let before = section.conversation_ids.len();
            section.conversation_ids.retain(|id| keep(id) && seen.insert(id.clone()));
            changed |= section.conversation_ids.len() != before;
        }
    }
    let before = cfg.conversations.len();
    cfg.conversations.retain(|id, p| keep(id) && *p != ConversationPrefs::default());
    changed || cfg.conversations.len() != before
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

    #[test]
    fn migrates_v1_without_loss() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        let v1 = r##"{
          "version": 1,
          "categories": [{"id":"c1","name":"Perso","color":"#7c3aed","projectKeys":["C--p"]}],
          "projects": {"C--p": {"displayName":"Mon projet","color":"#fde68a","path":"C:\\p"}},
          "archives": [{"sessionId":"s1","projectKey":"C--p","title":"T","archivedAt":5,"originalFile":"o","archivedFile":"a"}],
          "showTempProjects": true
        }"##;
        fs::write(&p, v1).unwrap();
        let cfg = load(&p);
        assert_eq!(cfg.version, CONFIG_VERSION);
        assert_eq!(cfg.categories[0].project_keys, vec!["C--p"]);
        assert_eq!(cfg.categories[0].color.as_deref(), Some("#7c3aed"));
        let prefs = &cfg.projects["C--p"];
        assert_eq!(prefs.display_name.as_deref(), Some("Mon projet"));
        assert_eq!(prefs.color.as_deref(), Some("#fde68a"));
        assert_eq!(prefs.path.as_deref(), Some("C:\\p"));
        assert!(prefs.sections.is_empty());
        assert!(cfg.conversations.is_empty());
        assert_eq!(cfg.archives[0].session_id, "s1");
        assert_eq!(cfg.archives[0].archived_at, 5);
        assert!(cfg.show_temp_projects);

        // Enregistrée puis relue au nouveau format : identique.
        save(&p, &cfg).unwrap();
        let again = load(&p);
        assert_eq!(serde_json::to_value(&again).unwrap(), serde_json::to_value(&cfg).unwrap());
        assert!(fs::read_to_string(&p).unwrap().contains("\"version\": 2"));
    }

    #[test]
    fn sections_and_conversation_prefs_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        let mut cfg = Config::default();
        cfg.projects.entry("C--p".into()).or_default().sections.push(Section {
            id: "sec".into(),
            name: "Backend".into(),
            color: Some("#2563eb".into()),
            conversation_ids: vec!["a".into(), "b".into()],
            collapsed: true,
        });
        cfg.conversations.insert("a".into(), ConversationPrefs { color: Some("#dc2626".into()) });
        save(&p, &cfg).unwrap();
        let text = fs::read_to_string(&p).unwrap();
        assert!(text.contains("\"conversationIds\"") && text.contains("\"conversations\""));
        let back = load(&p);
        let s = &back.projects["C--p"].sections[0];
        assert_eq!((s.name.as_str(), s.collapsed, s.conversation_ids.len()), ("Backend", true, 2));
        assert_eq!(back.conversations["a"].color.as_deref(), Some("#dc2626"));
    }

    #[test]
    fn prune_removes_missing_conversations_but_keeps_archived() {
        let mut cfg = Config::default();
        let prefs = cfg.projects.entry("C--p".into()).or_default();
        prefs.sections.push(Section {
            id: "s1".into(),
            conversation_ids: vec!["vivante".into(), "disparue".into(), "archivee".into()],
            ..Default::default()
        });
        // Doublon dans une deuxième section : gardé seulement dans la première.
        prefs.sections.push(Section { id: "s2".into(), conversation_ids: vec!["vivante".into()], ..Default::default() });
        cfg.archives.push(ArchiveEntry { session_id: "archivee".into(), ..Default::default() });
        cfg.conversations.insert("vivante".into(), ConversationPrefs { color: Some("#000000".into()) });
        cfg.conversations.insert("archivee".into(), ConversationPrefs { color: Some("#ffffff".into()) });
        cfg.conversations.insert("disparue".into(), ConversationPrefs { color: Some("#123456".into()) });
        cfg.conversations.insert("sans-pref".into(), ConversationPrefs::default());

        let existing: HashSet<String> = ["vivante".to_string(), "sans-pref".to_string()].into();
        assert!(prune_conversations(&mut cfg, &existing));
        let sections = &cfg.projects["C--p"].sections;
        assert_eq!(sections[0].conversation_ids, vec!["vivante", "archivee"]);
        assert!(sections[1].conversation_ids.is_empty());
        let mut ids: Vec<_> = cfg.conversations.keys().cloned().collect();
        ids.sort();
        assert_eq!(ids, vec!["archivee", "vivante"]);

        // Rien à retirer la deuxième fois.
        assert!(!prune_conversations(&mut cfg, &existing));
    }
}
