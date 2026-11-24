//! Remplissage du contexte de chaque conversation, relevé par la ligne d'état.
//!
//! # Fonctionnement
//!
//! - La sous-commande `statusline` (voir limits.rs) reçoit de Claude Code, après chaque
//!   réponse, le `session_id` de la conversation et `context_window.used_percentage` (de 0
//!   à 100, absent ou `null` avant le premier appel à l'API). [`record`] l'écrit dans
//!   `%APPDATA%\claude-manager\context\<session_id>.json` ([`ContextInfo`]), seulement si
//!   la valeur a changé. Un fichier par conversation : deux conversations qui répondent en
//!   même temps ne se gênent pas.
//! - Le fichier reste quand le terminal intégré est fermé : c'est la dernière valeur connue.
//! - [`ContextInfo::since`] marque le début du remplissage en cours : il est remis à l'heure
//!   de la mise à jour quand le contexte baisse nettement (`/compact`). Une suggestion
//!   ignorée avant cette baisse peut ainsi reparaître (voir suggestions.rs).
//! - L'app garde toutes les valeurs en mémoire ([`ContextStore`]), surveille le dossier
//!   ([`start_watcher`]) et prévient à chaque changement : les suggestions sont alors
//!   recalculées et émises vers l'interface (voir lib.rs).
//!
//! Pas de réseau, aucun appel à un modèle.

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;

const CONTEXT_DIR: &str = "context";
/// Baisse (en points) à partir de laquelle le remplissage est considéré comme reparti de
/// zéro (`/compact`).
const DROP_RESTART: f64 = 5.0;

/// Contenu d'un fichier `context\<session_id>.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub session_id: String,
    /// Part du contexte utilisée, de 0 à 100.
    pub used_percentage: f64,
    /// Dernière mise à jour, en millisecondes depuis 1970.
    pub at: u64,
    /// Début du remplissage en cours (dernière baisse nette du contexte), en millisecondes.
    pub since: u64,
}

/// Lit la conversation et le remplissage de son contexte dans l'entrée de la ligne d'état.
/// `None` : identifiant absent ou invalide, ou pourcentage absent (pas encore d'appel à l'API).
pub fn parse_input(input: &Value) -> Option<(String, f64)> {
    let id = input.get("session_id")?.as_str()?;
    crate::actions::validate_session_id(id).ok()?;
    let pct = input.pointer("/context_window/used_percentage")?.as_f64().filter(|p| p.is_finite() && *p >= 0.0)?;
    // Au dixième près : de petites variations d'arrondi ne réécrivent pas le fichier.
    Some((id.to_string(), ((pct.min(100.0)) * 10.0).round() / 10.0))
}

/// Nouvelle valeur, à partir de la précédente : `since` est gardé, sauf après une baisse nette.
pub fn merge(prev: Option<&ContextInfo>, session_id: &str, pct: f64, at: u64) -> ContextInfo {
    let since = match prev {
        Some(p) if pct > p.used_percentage - DROP_RESTART => p.since,
        _ => at,
    };
    ContextInfo { session_id: session_id.into(), used_percentage: pct, at, since }
}

pub fn context_dir(app_dir: &Path) -> PathBuf {
    app_dir.join(CONTEXT_DIR)
}

pub fn read(dir: &Path, session_id: &str) -> Option<ContextInfo> {
    crate::actions::validate_session_id(session_id).ok()?;
    let text = std::fs::read_to_string(dir.join(format!("{session_id}.json"))).ok()?;
    serde_json::from_str::<ContextInfo>(&text).ok().filter(|c| c.session_id == session_id)
}

/// Toutes les valeurs connues (fichiers illisibles ignorés).
pub fn read_all(dir: &Path) -> HashMap<String, ContextInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else { return HashMap::new() };
    entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension()? != "json" {
                return None;
            }
            read(dir, &p.file_stem()?.to_string_lossy())
        })
        .map(|c| (c.session_id.clone(), c))
        .collect()
}

/// Enregistre le remplissage d'une conversation, d'un coup (fichier temporaire puis
/// renommage). `None` : valeur inchangée, rien n'est écrit.
pub fn record(dir: &Path, session_id: &str, pct: f64, at: u64) -> std::io::Result<Option<ContextInfo>> {
    let prev = read(dir, session_id);
    if prev.as_ref().is_some_and(|p| p.used_percentage == pct) {
        return Ok(None);
    }
    let info = merge(prev.as_ref(), session_id, pct, at);
    std::fs::create_dir_all(dir)?;
    let data = serde_json::to_vec(&info).map_err(std::io::Error::other)?;
    crate::activity::write_atomic(&dir.join(format!("{session_id}.json")), &data)?;
    Ok(Some(info))
}

/// Appelé par la sous-commande `statusline` avec son entrée. Toute erreur est ignorée.
pub fn record_from_statusline(app_dir: &Path, input: &Value) {
    if let Some((id, pct)) = parse_input(input) {
        let _ = record(&context_dir(app_dir), &id, pct, crate::activity::now_ms());
    }
}

// ---------------------------------------------------------------------------
// Côté app
// ---------------------------------------------------------------------------

/// Dernier remplissage connu de chaque conversation, gardé en mémoire par l'app.
#[derive(Default)]
pub struct ContextStore(Mutex<HashMap<String, ContextInfo>>);

impl ContextStore {
    pub fn load(app_dir: &Path) -> Self {
        Self(Mutex::new(read_all(&context_dir(app_dir))))
    }

    pub fn all(&self) -> HashMap<String, ContextInfo> {
        self.0.lock().unwrap().clone()
    }

    fn set(&self, info: ContextInfo) {
        self.0.lock().unwrap().insert(info.session_id.clone(), info);
    }
}

/// Observe le dossier `context` : chaque fichier modifié est relu dans `store`, puis
/// `on_change` est appelé (une fois par rafale d'écritures).
pub fn start_watcher(app: AppHandle, app_dir: &Path, on_change: fn(&AppHandle)) {
    use tauri::Manager;
    let dir = context_dir(app_dir);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        for p in &event.paths {
            if let Some(stem) = p.file_stem().filter(|_| p.extension().is_some_and(|x| x == "json")) {
                let _ = tx.send(stem.to_string_lossy().to_string());
            }
        }
    });
    let Ok(mut watcher) = watcher else { return };
    if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
        return;
    }
    std::thread::spawn(move || {
        let _watcher = watcher;
        while let Ok(first) = rx.recv() {
            // Regroupe les évènements d'une même écriture (et de conversations voisines).
            let mut ids = HashSet::from([first]);
            while let Ok(id) = rx.recv_timeout(Duration::from_millis(100)) {
                ids.insert(id);
            }
            let store = app.state::<ContextStore>();
            let mut changed = false;
            for id in ids {
                if let Some(info) = read(&dir, &id) {
                    store.set(info);
                    changed = true;
                }
            }
            if changed {
                on_change(&app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "28cde7fb-e61a-4bd9-a66f-10ba27d395a5";
    const ID2: &str = "0f2c1a9e-1111-4222-8333-444455556666";

    #[test]
    fn parses_statusline_input() {
        let input = json!({"session_id": ID, "context_window": {"used_percentage": 42.36, "context_window_size": 200000}});
        assert_eq!(parse_input(&input), Some((ID.to_string(), 42.4)));
        assert_eq!(parse_input(&json!({"session_id": ID, "context_window": {"used_percentage": 130}})), Some((ID.to_string(), 100.0)));
        // Pas encore d'appel à l'API, valeur invalide, identifiant absent ou dangereux.
        assert_eq!(parse_input(&json!({"session_id": ID, "context_window": {"used_percentage": null}})), None);
        assert_eq!(parse_input(&json!({"session_id": ID})), None);
        assert_eq!(parse_input(&json!({"session_id": ID, "context_window": {"used_percentage": -3}})), None);
        assert_eq!(parse_input(&json!({"context_window": {"used_percentage": 10}})), None);
        assert_eq!(parse_input(&json!({"session_id": "..\\..\\x", "context_window": {"used_percentage": 10}})), None);
    }

    #[test]
    fn since_restarts_after_a_clear_drop() {
        let a = merge(None, ID, 20.0, 100);
        assert_eq!(a.since, 100);
        let b = merge(Some(&a), ID, 65.0, 200);
        assert_eq!((b.used_percentage, b.at, b.since), (65.0, 200, 100));
        // Petite baisse (arrondi, changement de modèle mineur) : même remplissage.
        let c = merge(Some(&b), ID, 61.0, 300);
        assert_eq!(c.since, 100);
        // `/compact` : le contexte retombe, le remplissage repart.
        let d = merge(Some(&c), ID, 18.0, 400);
        assert_eq!(d.since, 400);
    }

    #[test]
    fn records_per_conversation_and_keeps_last_value() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().join("context");
        let first = record(&d, ID, 12.0, 1).unwrap().unwrap();
        assert_eq!(first, ContextInfo { session_id: ID.into(), used_percentage: 12.0, at: 1, since: 1 });
        // Valeur inchangée : rien n'est réécrit.
        assert_eq!(record(&d, ID, 12.0, 2).unwrap(), None);
        assert_eq!(read(&d, ID).unwrap().at, 1);
        // Mise à jour, et une deuxième conversation à part.
        record(&d, ID, 64.5, 3).unwrap();
        record(&d, ID2, 30.0, 4).unwrap();
        let all = read_all(&d);
        assert_eq!(all.len(), 2);
        assert_eq!(all[ID], ContextInfo { session_id: ID.into(), used_percentage: 64.5, at: 3, since: 1 });
        assert_eq!(all[ID2].used_percentage, 30.0);
        // Format du fichier, sans fichier temporaire restant.
        let v: Value = serde_json::from_str(&std::fs::read_to_string(d.join(format!("{ID}.json"))).unwrap()).unwrap();
        assert_eq!(v, json!({"sessionId": ID, "usedPercentage": 64.5, "at": 3, "since": 1}));
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 2);
        // Fichiers étrangers ou illisibles ignorés.
        std::fs::write(d.join("pas-un-id.json"), "{}").unwrap();
        std::fs::write(d.join(format!("{ID2}.json")), "pas du json").unwrap();
        assert_eq!(read_all(&d).len(), 1);
        assert_eq!(read(&d, "../x"), None);
    }

    #[test]
    fn records_from_statusline_input() {
        let dir = tempfile::tempdir().unwrap();
        record_from_statusline(dir.path(), &json!({"session_id": ID, "context_window": {"used_percentage": 81.0}}));
        record_from_statusline(dir.path(), &json!({"session_id": ID2, "context_window": {"used_percentage": null}}));
        let all = read_all(&context_dir(dir.path()));
        assert_eq!(all.len(), 1);
        assert_eq!(all[ID].used_percentage, 81.0);
    }
}
