//! Données propres à l'application, dans `%APPDATA%\claude-manager\config.json`.
//!
//! Claude Code reste la source de vérité pour les projets et conversations ; ce fichier
//! ne contient que l'organisation personnelle : catégories, couleurs, noms d'affichage,
//! sections, préférences par conversation, projets créés depuis l'appli, liste des archives,
//! réglages des suggestions, liens des hand off (parente → suite) et hubs.

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
/// - 3 : réglages des suggestions (`Config::suggestions`) et suggestions ignorées par
///   conversation (`ConversationPrefs::dismissed_suggestions`). Champs nouveaux avec valeur
///   par défaut : rien à convertir.
/// - 4 : hand off — liens parente → suite (`Config::handoff_links`) et consigne du résumé de
///   passation (`Config::handoff_prompt`). Champs nouveaux avec valeur par défaut : rien à
///   convertir.
/// - 5 : hubs (`Config::hubs`, voir hubs.rs). Champ nouveau avec valeur par défaut : rien à
///   convertir.
pub const CONFIG_VERSION: u32 = 5;

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
    /// les sections sont dans la section par défaut (entrée réservée `default` de
    /// cette liste, qui ne garde que son nom, sa couleur, son repli et sa position).
    pub sections: Vec<Section>,
    /// Projet archivé : masqué de la barre latérale, ses conversations sont dans les archives.
    pub archived: Option<ProjectArchive>,
    /// « Ne plus demander pour ce projet » : pas de fenêtre proposant un worktree à la
    /// création d'une conversation (règle « worktree » des suggestions).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub no_worktree_offer: bool,
}

/// Archivage d'un projet entier (propre à Claude Manager : le dossier n'est pas touché).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectArchive {
    /// Date d'archivage (ms depuis l'époque Unix).
    pub archived_at: u64,
    /// Conversations archivées avec le projet, restaurées avec lui.
    pub session_ids: Vec<String>,
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
    /// Suggestions ignorées, par clé de suggestion (voir suggestions.rs).
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub dismissed_suggestions: HashMap<String, Dismissal>,
}

/// « Ignorer » sur une suggestion : elle reste masquée tant que son palier ne dépasse pas
/// `level` (et, pour une règle qui a un début, tant que la situation n'a pas recommencé
/// après `at`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Dismissal {
    /// Palier ignoré.
    pub level: u32,
    /// Moment du clic (ms depuis l'époque Unix).
    pub at: u64,
}

/// Seuil par défaut de la règle « Contexte rempli », en pourcentage.
pub const DEFAULT_CONTEXT_THRESHOLD: u32 = 60;
/// Règle « Conversation ancienne » (détectée par l'interface, voir src/suggestions.ts) :
/// inactivité minimale en minutes et contexte minimal en pourcentage, par défaut.
pub const DEFAULT_STALE_MINUTES: u32 = 60;
pub const DEFAULT_STALE_PERCENT: u32 = 30;

/// Réglages des suggestions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct SuggestionSettings {
    /// Règles coupées (identifiants de règle).
    pub disabled: Vec<String>,
    /// Seuil de la règle « Contexte rempli », en pourcentage.
    pub context_threshold: u32,
    /// Règle « Conversation ancienne » : inactivité minimale, en minutes.
    pub stale_minutes: u32,
    /// Règle « Conversation ancienne » : contexte minimal, en pourcentage.
    pub stale_percent: u32,
}

impl Default for SuggestionSettings {
    fn default() -> Self {
        Self {
            disabled: Vec::new(),
            context_threshold: DEFAULT_CONTEXT_THRESHOLD,
            stale_minutes: DEFAULT_STALE_MINUTES,
            stale_percent: DEFAULT_STALE_PERCENT,
        }
    }
}

/// Lien d'un hand off, rangé sous l'identifiant de la parente (voir handoff.rs).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct HandoffLink {
    /// Conversation qui a pris le relais.
    pub successor_id: String,
    /// Moment du hand off (ms depuis l'époque Unix).
    pub at: u64,
}

/// Rôle d'une conversation dans un hub (voir GLOSSARY.md, « Hubs »).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HubRole {
    /// Répartit le travail et reçoit les comptes rendus ; au plus un par hub.
    Coordinateur,
    /// Réalise une tâche confiée par le coordinateur.
    Executant,
    /// Membre d'un hub sans hiérarchie.
    #[default]
    Pair,
}

/// Une conversation rangée dans un hub.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct HubMember {
    pub conversation_id: String,
    pub role: HubRole,
}

/// Archivage d'un hub : ses conversations archivées avec lui, restaurées avec lui.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct HubArchive {
    /// Date d'archivage (ms depuis l'époque Unix).
    pub archived_at: u64,
    pub session_ids: Vec<String>,
}

/// Un hub : regroupement de conversations, éventuellement de projets différents, qui
/// travaillent ensemble. Géré uniquement par le backend (voir hubs.rs).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Hub {
    pub id: String,
    pub name: String,
    /// Couleur de fond (`#rrggbb`), ou `None` pour la couleur par défaut.
    pub color: Option<String>,
    /// Membres, dans l'ordre d'ajout. Une conversation est dans un hub au plus.
    pub members: Vec<HubMember>,
    /// Date de création (ms depuis l'époque Unix).
    pub created_at: u64,
    /// Hub archivé : masqué de la barre latérale, ses conversations sont dans les archives.
    pub archived: Option<HubArchive>,
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
    /// Réglages des suggestions (voir suggestions.rs).
    pub suggestions: SuggestionSettings,
    /// Hand off : suite de chaque parente, par identifiant de la parente. Gérée uniquement
    /// par le backend (voir handoff.rs) ; conservée tant que l'une des deux conversations existe.
    pub handoff_links: HashMap<String, HandoffLink>,
    /// Consigne du résumé de passation choisie dans les réglages (`None` : texte par défaut,
    /// défini côté interface dans `src/handoff.ts`).
    pub handoff_prompt: Option<String>,
    /// Hubs, dans l'ordre d'affichage. Gérés uniquement par le backend (voir hubs.rs) ; un
    /// membre est gardé tant que sa conversation existe (sur le disque ou dans les archives).
    pub hubs: Vec<Hub>,
    /// Langue de l'interface (code BCP 47) ; `None` : français, la langue intégrée. Les textes
    /// traduits sont dans `languages\<code>.json` (voir languages.rs).
    pub language: Option<String>,
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
            suggestions: SuggestionSettings::default(),
            handoff_links: HashMap::new(),
            handoff_prompt: None,
            hubs: Vec::new(),
            language: None,
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
/// 1 → 2 → 3 → 4 → 5 : rien à convertir, les nouveaux champs prennent leur valeur par défaut.
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
/// n'est gardée que dans la première. Un lien de hand off est gardé tant que la parente ou
/// la suite existe. Une conversation qui n'existe plus quitte son hub. Renvoie `true` si
/// quelque chose a changé.
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
    changed |= cfg.conversations.len() != before;
    let before = cfg.handoff_links.len();
    cfg.handoff_links.retain(|parent, link| keep(parent) || keep(&link.successor_id));
    changed |= cfg.handoff_links.len() != before;
    crate::hubs::prune(cfg, keep) || changed
}

/// Clé du projet archivé auquel appartient une conversation archivée avec lui.
pub fn archived_project_of(cfg: &Config, session_id: &str) -> Option<String> {
    cfg.projects
        .iter()
        .find(|(_, p)| p.archived.as_ref().is_some_and(|a| a.session_ids.iter().any(|id| id == session_id)))
        .map(|(k, _)| k.clone())
}

/// Une conversation archivée avec son projet n'est plus dans les archives (restaurée seule
/// ou mise à la Corbeille) : elle est retirée de la liste du projet. Restaurée seule
/// (`restored`), elle fait aussi revenir le projet. Renvoie `true` si quelque chose a changé.
pub fn detach_from_archived_project(cfg: &mut Config, session_id: &str, restored: bool) -> bool {
    let Some(key) = archived_project_of(cfg, session_id) else { return false };
    let prefs = cfg.projects.get_mut(&key).expect("clé trouvée juste avant");
    if restored {
        prefs.archived = None;
    } else if let Some(a) = prefs.archived.as_mut() {
        a.session_ids.retain(|id| id != session_id);
    }
    true
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
        assert!(fs::read_to_string(&p).unwrap().contains(&format!("\"version\": {CONFIG_VERSION}")));
        // Réglages des suggestions absents : valeurs par défaut.
        assert_eq!(cfg.suggestions, SuggestionSettings::default());
        assert_eq!(cfg.suggestions.context_threshold, 60);
    }

    #[test]
    fn stale_settings_default_when_missing() {
        let s: SuggestionSettings = serde_json::from_str(r#"{"disabled":["hub"],"contextThreshold":70}"#).unwrap();
        assert_eq!(s.context_threshold, 70);
        assert_eq!((s.stale_minutes, s.stale_percent), (DEFAULT_STALE_MINUTES, DEFAULT_STALE_PERCENT));
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back["staleMinutes"], 60);
        assert_eq!(back["stalePercent"], 30);
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
        cfg.conversations.insert("a".into(), ConversationPrefs { color: Some("#dc2626".into()), ..Default::default() });
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
        cfg.conversations.insert("vivante".into(), ConversationPrefs { color: Some("#000000".into()), ..Default::default() });
        cfg.conversations.insert("archivee".into(), ConversationPrefs { color: Some("#ffffff".into()), ..Default::default() });
        cfg.conversations.insert("disparue".into(), ConversationPrefs { color: Some("#123456".into()), ..Default::default() });
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

    #[test]
    fn suggestion_settings_and_dismissals_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        let mut cfg = Config {
            suggestions: SuggestionSettings { disabled: vec!["context".into()], context_threshold: 70, ..Default::default() },
            ..Default::default()
        };
        cfg.conversations.entry("a".into()).or_default().dismissed_suggestions.insert("context".into(), Dismissal { level: 80, at: 5 });
        cfg.conversations.insert("b".into(), ConversationPrefs { color: Some("#000000".into()), ..Default::default() });
        save(&p, &cfg).unwrap();
        let text = fs::read_to_string(&p).unwrap();
        assert!(text.contains("\"contextThreshold\": 70") && text.contains("\"dismissedSuggestions\""));
        // Aucune suggestion ignorée : le champ n'est pas écrit.
        assert_eq!(text.matches("dismissedSuggestions").count(), 1);
        let back = load(&p);
        assert_eq!(back.suggestions, cfg.suggestions);
        assert_eq!(back.conversations["a"].dismissed_suggestions["context"], Dismissal { level: 80, at: 5 });
        // Une conversation qui n'a qu'une suggestion ignorée garde ses préférences.
        let mut back = back;
        let existing: HashSet<String> = ["a".to_string(), "b".to_string()].into();
        assert!(!prune_conversations(&mut back, &existing));
        assert!(back.conversations.contains_key("a"));
    }

    #[test]
    fn handoff_links_and_prompt_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        // Fichier en version 3 : pas de lien, consigne par défaut.
        fs::write(&p, r#"{"version":3,"categories":[]}"#).unwrap();
        let cfg = load(&p);
        assert_eq!(cfg.version, CONFIG_VERSION);
        assert!(cfg.handoff_links.is_empty() && cfg.handoff_prompt.is_none());

        let mut cfg = Config { handoff_prompt: Some("Résume.".into()), ..Default::default() };
        cfg.handoff_links.insert("parente".into(), HandoffLink { successor_id: "suite".into(), at: 9 });
        save(&p, &cfg).unwrap();
        let text = fs::read_to_string(&p).unwrap();
        assert!(text.contains("\"handoffLinks\"") && text.contains("\"successorId\": \"suite\"") && text.contains("\"handoffPrompt\": \"Résume.\""));
        let back = load(&p);
        assert_eq!(back.handoff_links["parente"], HandoffLink { successor_id: "suite".into(), at: 9 });
        assert_eq!(back.handoff_prompt.as_deref(), Some("Résume."));
    }

    #[test]
    fn project_archive_roundtrip_and_detach() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        let mut cfg = Config::default();
        cfg.projects.entry("C--p".into()).or_default().archived =
            Some(ProjectArchive { archived_at: 7, session_ids: vec!["a".into(), "b".into()] });
        save(&p, &cfg).unwrap();
        let mut cfg = load(&p);
        assert_eq!(cfg.projects["C--p"].archived.as_ref().unwrap().session_ids, vec!["a", "b"]);
        assert_eq!(archived_project_of(&cfg, "b").as_deref(), Some("C--p"));
        assert_eq!(archived_project_of(&cfg, "z"), None);

        // Mise à la Corbeille : retirée de la liste, le projet reste archivé.
        assert!(detach_from_archived_project(&mut cfg, "a", false));
        assert_eq!(cfg.projects["C--p"].archived.as_ref().unwrap().session_ids, vec!["b"]);
        // Restaurée seule : le projet revient.
        assert!(detach_from_archived_project(&mut cfg, "b", true));
        assert!(cfg.projects["C--p"].archived.is_none());
        assert!(!detach_from_archived_project(&mut cfg, "b", true));

        // Ancien fichier sans le champ : projet non archivé.
        fs::write(&p, r#"{"projects":{"C--p":{"displayName":"X"}}}"#).unwrap();
        assert!(load(&p).projects["C--p"].archived.is_none());
    }
}
