//! Hubs (voir GLOSSARY.md, « Hubs », et ADR 0002) : des conversations, éventuellement de
//! projets différents, regroupées pour travailler ensemble. Une conversation reste rangée dans
//! son projet ; le hub n'y fait que renvoyer.
//!
//! Les hubs sont dans `config.json` (`Config::hubs`) et gérés uniquement par le backend
//! (commandes `hub_*` dans lib.rs ; `save_config` garde ceux du backend) : les règles sont
//! appliquées ici, et testées.
//! - Une conversation est dans un hub au plus ; l'ajouter à un autre hub l'y déplace.
//! - Au plus un coordinateur par hub : en désigner un nouveau rétrograde l'ancien en exécutant.
//! - Archiver un hub archive ses conversations (une à une par l'interface, avec la confirmation
//!   habituelle) puis [`mark_archived`] ; le restaurer remet en place les conversations
//!   archivées avec lui ([`archived_ids`] puis [`unarchive`]). Supprimer un hub ne touche pas à
//!   ses conversations.
//! - Une conversation qui n'existe plus (Corbeille) quitte son hub ([`prune`]).
//! - Hand off d'un membre : la suite prend sa place et son rôle ([`replace_member`]), et son
//!   premier message liste les autres membres ([`HandoffContext`], voir handoff.rs).

use crate::config::{Config, Hub, HubArchive, HubMember, HubRole};
use std::collections::HashMap;
use std::path::Path;

/// Hub par identifiant.
pub fn find<'a>(cfg: &'a Config, hub_id: &str) -> Option<&'a Hub> {
    cfg.hubs.iter().find(|h| h.id == hub_id)
}

fn find_mut<'a>(cfg: &'a mut Config, hub_id: &str) -> Result<&'a mut Hub, String> {
    cfg.hubs.iter_mut().find(|h| h.id == hub_id).ok_or_else(|| "Ce hub n'existe plus.".to_string())
}

/// Hub d'une conversation, avec son rôle.
pub fn hub_of<'a>(cfg: &'a Config, conversation_id: &str) -> Option<(&'a Hub, HubRole)> {
    cfg.hubs
        .iter()
        .find_map(|h| h.members.iter().find(|m| m.conversation_id == conversation_id).map(|m| (h, m.role)))
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Le nom du hub est vide.".into());
    }
    Ok(name.to_string())
}

/// Crée un hub vide, placé en dernier. Renvoie son identifiant.
pub fn create(cfg: &mut Config, name: &str, color: Option<String>, at: u64) -> Result<String, String> {
    let name = clean_name(name)?;
    let mut n = 0u32;
    let id = loop {
        let id = if n == 0 { format!("hub-{at:x}") } else { format!("hub-{at:x}-{n}") };
        if find(cfg, &id).is_none() {
            break id;
        }
        n += 1;
    };
    cfg.hubs.push(Hub { id: id.clone(), name, color, created_at: at, ..Default::default() });
    Ok(id)
}

/// Renomme un hub et change sa couleur.
pub fn update(cfg: &mut Config, hub_id: &str, name: &str, color: Option<String>) -> Result<(), String> {
    let name = clean_name(name)?;
    let hub = find_mut(cfg, hub_id)?;
    hub.name = name;
    hub.color = color;
    Ok(())
}

/// Supprime le regroupement seulement : les conversations ne sont pas touchées.
pub fn delete(cfg: &mut Config, hub_id: &str) -> Result<(), String> {
    let before = cfg.hubs.len();
    cfg.hubs.retain(|h| h.id != hub_id);
    if cfg.hubs.len() == before {
        return Err("Ce hub n'existe plus.".into());
    }
    Ok(())
}

/// Range une conversation dans un hub avec ce rôle, ou change son rôle si elle y est déjà.
/// Elle quitte son ancien hub le cas échéant. Un nouveau coordinateur rétrograde l'ancien en
/// exécutant.
pub fn set_member(cfg: &mut Config, hub_id: &str, conversation_id: &str, role: HubRole) -> Result<(), String> {
    find_mut(cfg, hub_id)?;
    for hub in cfg.hubs.iter_mut().filter(|h| h.id != hub_id) {
        hub.members.retain(|m| m.conversation_id != conversation_id);
    }
    let hub = find_mut(cfg, hub_id)?;
    if role == HubRole::Coordinateur {
        for m in hub.members.iter_mut().filter(|m| m.role == HubRole::Coordinateur) {
            m.role = HubRole::Executant;
        }
    }
    match hub.members.iter_mut().find(|m| m.conversation_id == conversation_id) {
        Some(m) => m.role = role,
        None => hub.members.push(HubMember { conversation_id: conversation_id.to_string(), role }),
    }
    Ok(())
}

/// Retire une conversation d'un hub (la conversation n'est pas touchée).
pub fn remove_member(cfg: &mut Config, hub_id: &str, conversation_id: &str) -> Result<(), String> {
    find_mut(cfg, hub_id)?.members.retain(|m| m.conversation_id != conversation_id);
    Ok(())
}

/// Marque un hub comme archivé, une fois ses conversations archivées par l'interface.
/// `session_ids` : les conversations archivées avec lui, restaurées avec lui.
pub fn mark_archived(cfg: &mut Config, hub_id: &str, session_ids: Vec<String>, at: u64) -> Result<(), String> {
    find_mut(cfg, hub_id)?.archived = Some(HubArchive { archived_at: at, session_ids });
    Ok(())
}

/// Conversations archivées avec un hub archivé, à restaurer avec lui.
pub fn archived_ids(cfg: &Config, hub_id: &str) -> Result<Vec<String>, String> {
    let hub = find(cfg, hub_id).ok_or("Ce hub n'existe plus.")?;
    hub.archived.as_ref().map(|a| a.session_ids.clone()).ok_or_else(|| "Ce hub n'est pas archivé.".into())
}

/// Le hub revient dans la barre latérale (ses conversations ont été restaurées).
pub fn unarchive(cfg: &mut Config, hub_id: &str) -> Result<(), String> {
    find_mut(cfg, hub_id)?.archived = None;
    Ok(())
}

/// Une conversation archivée avec son hub n'est plus dans les archives (restaurée seule ou
/// mise à la Corbeille) : elle est retirée de la liste du hub. Restaurée seule (`restored`),
/// elle fait aussi revenir le hub. Renvoie `true` si quelque chose a changé.
pub fn detach_from_archived_hub(cfg: &mut Config, session_id: &str, restored: bool) -> bool {
    let Some(hub) = cfg
        .hubs
        .iter_mut()
        .find(|h| h.archived.as_ref().is_some_and(|a| a.session_ids.iter().any(|id| id == session_id)))
    else {
        return false;
    };
    if restored {
        hub.archived = None;
    } else if let Some(a) = hub.archived.as_mut() {
        a.session_ids.retain(|id| id != session_id);
    }
    true
}

/// Hand off d'un membre : la suite prend la place et le rôle de la parente dans son hub.
pub fn replace_member(cfg: &mut Config, parent: &str, successor: &str) {
    if !cfg.hubs.iter().any(|h| h.members.iter().any(|m| m.conversation_id == parent)) {
        return;
    }
    for hub in &mut cfg.hubs {
        hub.members.retain(|m| m.conversation_id != successor);
        for m in hub.members.iter_mut().filter(|m| m.conversation_id == parent) {
            m.conversation_id = successor.to_string();
        }
    }
}

/// Retire des hubs les conversations qui n'existent plus (`keep` : présente sur le disque ou
/// dans les archives). Renvoie `true` si quelque chose a changé.
pub fn prune(cfg: &mut Config, keep: impl Fn(&str) -> bool) -> bool {
    let mut changed = false;
    for hub in &mut cfg.hubs {
        let before = hub.members.len();
        hub.members.retain(|m| keep(&m.conversation_id));
        changed |= hub.members.len() != before;
    }
    changed
}

/// Libellé d'un rôle, pour les messages.
pub fn role_label(role: HubRole) -> &'static str {
    match role {
        HubRole::Coordinateur => "coordinateur",
        HubRole::Executant => "exécutant",
        HubRole::Pair => "pair",
    }
}

/// Noms de messagerie des conversations en cours, par identifiant de conversation, lus dans
/// `~/.claude/sessions/<pid>.json` (voir ADR 0002). Format non documenté : un fichier
/// illisible ou un dossier absent est simplement ignoré.
pub fn messaging_names(sessions_dir: &Path) -> HashMap<String, String> {
    crate::messages::running_names(sessions_dir).into_iter().map(|n| (n.session_id, n.name)).collect()
}

/// Un autre membre du hub, tel que présenté à la suite d'un hand off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberBrief {
    pub title: String,
    pub role: HubRole,
    /// Nom de messagerie actuel, si la conversation tourne en ce moment.
    pub messaging_name: Option<String>,
}

/// Ce que la suite d'un hand off doit savoir de son hub (voir `handoff::first_message`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandoffContext {
    pub hub_name: String,
    /// Rôle de la parente, repris par la suite.
    pub role: HubRole,
    /// Les autres membres, coordinateur en tête.
    pub members: Vec<MemberBrief>,
}

/// Contexte du hub de `parent` pour son hand off ; `None` s'il n'est dans aucun hub.
/// `title` : titre d'une conversation (sinon son identifiant court) ; `names` : noms de
/// messagerie des conversations en cours ([`messaging_names`]).
pub fn handoff_context(
    cfg: &Config,
    parent: &str,
    title: impl Fn(&str) -> Option<String>,
    names: &HashMap<String, String>,
) -> Option<HandoffContext> {
    let (hub, role) = hub_of(cfg, parent)?;
    let mut members: Vec<MemberBrief> = hub
        .members
        .iter()
        .filter(|m| m.conversation_id != parent)
        .map(|m| MemberBrief {
            title: title(&m.conversation_id).unwrap_or_else(|| m.conversation_id.chars().take(8).collect()),
            role: m.role,
            messaging_name: names.get(&m.conversation_id).cloned(),
        })
        .collect();
    members.sort_by_key(|m| m.role != HubRole::Coordinateur);
    Some(HandoffContext { hub_name: hub.name.clone(), role, members })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{load, prune_conversations, save, ArchiveEntry};
    use std::collections::HashSet;

    fn roles(cfg: &Config, hub_id: &str) -> Vec<(String, HubRole)> {
        find(cfg, hub_id).unwrap().members.iter().map(|m| (m.conversation_id.clone(), m.role)).collect()
    }

    #[test]
    fn create_update_delete_and_persist() {
        let mut cfg = Config::default();
        assert!(create(&mut cfg, "   ", None, 1).is_err());
        let a = create(&mut cfg, " Refonte ", Some("#2563eb".into()), 10).unwrap();
        let b = create(&mut cfg, "Autre", None, 10).unwrap();
        assert_ne!(a, b);
        assert_eq!(cfg.hubs[0].name, "Refonte");
        assert_eq!(cfg.hubs[0].created_at, 10);
        update(&mut cfg, &a, "Refonte du site", None).unwrap();
        assert_eq!((find(&cfg, &a).unwrap().name.as_str(), find(&cfg, &a).unwrap().color.clone()), ("Refonte du site", None));
        assert!(update(&mut cfg, "absent", "X", None).is_err());
        set_member(&mut cfg, &a, "c1", HubRole::Coordinateur).unwrap();

        // Enregistré puis relu : identique, rôles en minuscules.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        save(&p, &cfg).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains("\"hubs\"") && text.contains("\"role\": \"coordinateur\"") && text.contains("\"conversationId\": \"c1\""));
        assert_eq!(load(&p).hubs, cfg.hubs);
        // Fichier en version 4 : aucun hub.
        std::fs::write(&p, r#"{"version":4}"#).unwrap();
        assert!(load(&p).hubs.is_empty());

        // Supprimer un hub ne touche qu'au regroupement.
        delete(&mut cfg, &a).unwrap();
        assert_eq!(cfg.hubs.len(), 1);
        assert!(delete(&mut cfg, &a).is_err());
    }

    #[test]
    fn at_most_one_coordinator() {
        let mut cfg = Config::default();
        let h = create(&mut cfg, "H", None, 1).unwrap();
        set_member(&mut cfg, &h, "a", HubRole::Coordinateur).unwrap();
        set_member(&mut cfg, &h, "b", HubRole::Executant).unwrap();
        set_member(&mut cfg, &h, "c", HubRole::Pair).unwrap();
        // Nouveau coordinateur : l'ancien devient exécutant.
        set_member(&mut cfg, &h, "b", HubRole::Coordinateur).unwrap();
        assert_eq!(
            roles(&cfg, &h),
            vec![("a".into(), HubRole::Executant), ("b".into(), HubRole::Coordinateur), ("c".into(), HubRole::Pair)]
        );
        // Changer de rôle ne duplique pas le membre.
        set_member(&mut cfg, &h, "c", HubRole::Coordinateur).unwrap();
        assert_eq!(find(&cfg, &h).unwrap().members.iter().filter(|m| m.role == HubRole::Coordinateur).count(), 1);
        assert_eq!(find(&cfg, &h).unwrap().members.len(), 3);
        assert!(set_member(&mut cfg, "absent", "a", HubRole::Pair).is_err());
    }

    #[test]
    fn conversation_in_one_hub_only_and_removal() {
        let mut cfg = Config::default();
        let h1 = create(&mut cfg, "Un", None, 1).unwrap();
        let h2 = create(&mut cfg, "Deux", None, 2).unwrap();
        set_member(&mut cfg, &h1, "a", HubRole::Pair).unwrap();
        set_member(&mut cfg, &h2, "a", HubRole::Executant).unwrap();
        assert!(roles(&cfg, &h1).is_empty());
        assert_eq!(hub_of(&cfg, "a").map(|(h, r)| (h.id.clone(), r)), Some((h2.clone(), HubRole::Executant)));
        remove_member(&mut cfg, &h2, "a").unwrap();
        assert!(hub_of(&cfg, "a").is_none());
    }

    #[test]
    fn archive_and_restore_in_cascade() {
        let mut cfg = Config::default();
        let h = create(&mut cfg, "H", None, 1).unwrap();
        for id in ["a", "b", "c"] {
            set_member(&mut cfg, &h, id, HubRole::Pair).unwrap();
        }
        assert!(archived_ids(&cfg, &h).is_err());
        // L'interface a archivé les conversations : elles sont dans les archives.
        for id in ["a", "b", "c"] {
            cfg.archives.push(ArchiveEntry { session_id: id.into(), ..Default::default() });
        }
        mark_archived(&mut cfg, &h, vec!["a".into(), "b".into(), "c".into()], 5).unwrap();
        // Les membres archivés restent dans le hub.
        assert!(!prune_conversations(&mut cfg, &HashSet::new()));
        assert_eq!(find(&cfg, &h).unwrap().members.len(), 3);

        // « c » mise à la Corbeille depuis les archives : retirée de la liste du hub et du hub.
        cfg.archives.retain(|a| a.session_id != "c");
        assert!(detach_from_archived_hub(&mut cfg, "c", false));
        assert!(prune_conversations(&mut cfg, &HashSet::new()));
        assert_eq!(archived_ids(&cfg, &h).unwrap(), vec!["a", "b"]);
        assert_eq!(roles(&cfg, &h).len(), 2);

        // Restauration du hub : ses conversations, puis le hub.
        unarchive(&mut cfg, &h).unwrap();
        assert!(find(&cfg, &h).unwrap().archived.is_none());

        // « b » restaurée seule fait revenir le hub.
        mark_archived(&mut cfg, &h, vec!["a".into(), "b".into()], 6).unwrap();
        assert!(detach_from_archived_hub(&mut cfg, "b", true));
        assert!(find(&cfg, &h).unwrap().archived.is_none());
        assert!(!detach_from_archived_hub(&mut cfg, "b", true));
    }

    #[test]
    fn deleted_conversation_leaves_its_hub() {
        let mut cfg = Config::default();
        let h = create(&mut cfg, "H", None, 1).unwrap();
        set_member(&mut cfg, &h, "vivante", HubRole::Coordinateur).unwrap();
        set_member(&mut cfg, &h, "corbeille", HubRole::Executant).unwrap();
        let existing: HashSet<String> = ["vivante".to_string()].into();
        assert!(prune_conversations(&mut cfg, &existing));
        assert_eq!(roles(&cfg, &h), vec![("vivante".into(), HubRole::Coordinateur)]);
        assert!(!prune_conversations(&mut cfg, &existing));
    }

    #[test]
    fn handoff_successor_takes_place_and_role() {
        let mut cfg = Config::default();
        let h = create(&mut cfg, "H", None, 1).unwrap();
        set_member(&mut cfg, &h, "x", HubRole::Executant).unwrap();
        set_member(&mut cfg, &h, "parente", HubRole::Coordinateur).unwrap();
        set_member(&mut cfg, &h, "y", HubRole::Pair).unwrap();
        crate::handoff::apply(&mut cfg, "parente", "suite", 1);
        assert_eq!(
            roles(&cfg, &h),
            vec![("x".into(), HubRole::Executant), ("suite".into(), HubRole::Coordinateur), ("y".into(), HubRole::Pair)]
        );
        // Conversation hors hub : rien ne change.
        replace_member(&mut cfg, "autre", "suite2");
        assert!(hub_of(&cfg, "suite2").is_none());
    }

    #[test]
    fn handoff_context_lists_other_members() {
        let mut cfg = Config::default();
        let h = create(&mut cfg, "Refonte", None, 1).unwrap();
        set_member(&mut cfg, &h, "parente", HubRole::Executant).unwrap();
        set_member(&mut cfg, &h, "pair", HubRole::Executant).unwrap();
        set_member(&mut cfg, &h, "chef", HubRole::Coordinateur).unwrap();
        let titles: HashMap<&str, &str> = [("chef", "Coordination"), ("parente", "Menu")].into();
        let names: HashMap<String, String> = [("chef".to_string(), "projet-ab".to_string())].into();
        let ctx = handoff_context(&cfg, "parente", |id| titles.get(id).map(|t| t.to_string()), &names).unwrap();
        assert_eq!(ctx.hub_name, "Refonte");
        assert_eq!(ctx.role, HubRole::Executant);
        assert_eq!(
            ctx.members,
            vec![
                MemberBrief { title: "Coordination".into(), role: HubRole::Coordinateur, messaging_name: Some("projet-ab".into()) },
                MemberBrief { title: "pair".into(), role: HubRole::Executant, messaging_name: None },
            ]
        );
        assert!(handoff_context(&cfg, "hors-hub", |_| None, &names).is_none());
    }

    #[test]
    fn reads_messaging_names_tolerantly() {
        let dir = tempfile::tempdir().unwrap();
        assert!(messaging_names(&dir.path().join("absent")).is_empty());
        std::fs::write(dir.path().join("1.json"), r#"{"pid":1,"sessionId":"s1","name":"projet-bf","status":"busy"}"#).unwrap();
        std::fs::write(dir.path().join("2.json"), r#"{"pid":2,"sessionId":"s2"}"#).unwrap();
        std::fs::write(dir.path().join("3.json"), "{oups").unwrap();
        std::fs::write(dir.path().join("3.key"), "x").unwrap();
        let names = messaging_names(dir.path());
        assert_eq!(names.len(), 1);
        assert_eq!(names["s1"], "projet-bf");
    }
}
