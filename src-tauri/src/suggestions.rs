//! Moteur de suggestions (voir GLOSSARY.md, « Suggestion », et `.scratch/suggestions/spec.md`).
//!
//! L'app repère des situations où une bonne pratique s'impose et la propose, sans jamais
//! agir seule. La détection n'utilise que des données déjà là (ligne d'état, configuration…),
//! sans appel à un modèle.
//!
//! # Fonctionnement
//!
//! - Chaque règle ([`Rule`]) a un identifiant et une fonction de détection pure qui, à partir
//!   des [`Inputs`], renvoie les suggestions qu'elle voit, conversation par conversation,
//!   avec leur **palier** (`level`) : un nombre qui grandit quand la situation s'aggrave
//!   (60, 80, 90 % pour le contexte).
//! - [`compute`] applique les règles de [`RULES`] puis retire les règles coupées dans les
//!   réglages, les conversations archivées et les suggestions **ignorées** : « Ignorer »
//!   enregistre le palier et l'heure du clic ([`crate::config::Dismissal`]) ; la suggestion
//!   reparaît au palier suivant, ou quand la situation recommence après le clic
//!   ([`Suggestion::since`], par exemple après un `/compact`).
//! - L'app recalcule et émet [`EVT_SUGGESTIONS`] ([`Snapshot`]) quand une donnée change
//!   (contexte relevé, configuration enregistrée) ; l'interface (`src/suggestions.ts`)
//!   affiche l'icône 💡, le bandeau et l'action de chaque règle.
//!
//! # Ajouter une règle
//!
//! 1. Écrire sa fonction de détection (`fn(&Inputs) -> Vec<Suggestion>`), ajouter au besoin
//!    ses données à [`Inputs`], et la déclarer dans [`RULES`].
//! 2. Côté interface, déclarer son texte, son action et son libellé de réglage dans
//!    `SUGGESTION_RULES` (`src/suggestions.ts`).

use crate::config::Config;
use crate::context::ContextInfo;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

/// Évènement : les suggestions ont changé (charge utile : [`Snapshot`]).
pub const EVT_SUGGESTIONS: &str = "suggestions";

/// Règle « Contexte rempli » : proposer un hand off.
pub const RULE_CONTEXT: &str = "context";
/// Paliers fixes de la règle « Contexte rempli », au-dessus du seuil réglable.
const CONTEXT_TIERS: [u32; 2] = [80, 90];
/// Bornes du seuil réglable.
const CONTEXT_THRESHOLD_RANGE: (u32, u32) = (10, 95);

/// Données disponibles pour la détection.
pub struct Inputs<'a> {
    pub config: &'a Config,
    /// Dernier remplissage connu du contexte, par conversation.
    pub contexts: &'a HashMap<String, ContextInfo>,
}

/// Une suggestion pour une conversation.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// Identifiant de la règle.
    pub rule: &'static str,
    pub session_id: String,
    /// Clé sous laquelle « Ignorer » est enregistré pour la conversation : l'identifiant de
    /// la règle, ou plus précis quand une règle peut proposer plusieurs choses à la même
    /// conversation (par exemple une par autre conversation).
    pub key: String,
    /// Palier courant : « Ignorer » masque la suggestion jusqu'à un palier plus élevé.
    pub level: u32,
    /// Début de la situation (ms) : une suggestion ignorée avant reparaît. `None` : « Ignorer »
    /// vaut tant que le palier ne monte pas.
    pub since: Option<u64>,
    /// Précisions pour l'interface (pourcentage…), propres à chaque règle.
    pub data: Value,
}

/// Une règle de suggestion.
pub struct Rule {
    pub id: &'static str,
    pub detect: fn(&Inputs) -> Vec<Suggestion>,
}

/// Règles connues, dans l'ordre d'affichage des bandeaux.
pub const RULES: &[Rule] = &[Rule { id: RULE_CONTEXT, detect: detect_context }];

/// Ce que l'interface reçoit : le contexte de chaque conversation et les suggestions à afficher.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub contexts: Vec<ContextInfo>,
    pub suggestions: Vec<Suggestion>,
}

// ---------------------------------------------------------------------------
// Règle « Contexte rempli »
// ---------------------------------------------------------------------------

/// Palier atteint par un contexte rempli à `pct` % : le plus haut parmi le seuil réglé et
/// les paliers fixes au-dessus (80, 90). `None` : sous le seuil.
pub fn context_level(pct: f64, threshold: u32) -> Option<u32> {
    let t = threshold.clamp(CONTEXT_THRESHOLD_RANGE.0, CONTEXT_THRESHOLD_RANGE.1);
    std::iter::once(t).chain(CONTEXT_TIERS.into_iter().filter(|x| *x > t)).filter(|x| pct >= f64::from(*x)).max()
}

fn detect_context(i: &Inputs) -> Vec<Suggestion> {
    let threshold = i.config.suggestions.context_threshold;
    i.contexts
        .values()
        .filter_map(|c| {
            let level = context_level(c.used_percentage, threshold)?;
            Some(Suggestion {
                rule: RULE_CONTEXT,
                session_id: c.session_id.clone(),
                key: RULE_CONTEXT.into(),
                level,
                since: Some(c.since),
                data: json!({ "percent": c.used_percentage.round() }),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Moteur
// ---------------------------------------------------------------------------

/// La suggestion a été ignorée à un palier au moins aussi élevé, depuis le début de la
/// situation.
pub fn is_dismissed(cfg: &Config, s: &Suggestion) -> bool {
    let Some(d) = cfg.conversations.get(&s.session_id).and_then(|p| p.dismissed_suggestions.get(&s.key)) else {
        return false;
    };
    d.level >= s.level && s.since.is_none_or(|since| d.at >= since)
}

/// Suggestions à afficher : règles actives, conversations non archivées, non ignorées.
/// Triées par conversation, puis dans l'ordre de [`RULES`].
pub fn compute(i: &Inputs) -> Vec<Suggestion> {
    compute_with(RULES, i)
}

fn compute_with(rules: &[Rule], i: &Inputs) -> Vec<Suggestion> {
    let cfg = i.config;
    let archived: HashSet<&str> = cfg.archives.iter().map(|a| a.session_id.as_str()).collect();
    let mut out: Vec<(usize, Suggestion)> = rules
        .iter()
        .enumerate()
        .filter(|(_, r)| !cfg.suggestions.disabled.iter().any(|d| d == r.id))
        .flat_map(|(n, r)| (r.detect)(i).into_iter().map(move |s| (n, s)))
        .filter(|(_, s)| !archived.contains(s.session_id.as_str()) && !is_dismissed(cfg, s))
        .collect();
    out.sort_by(|(na, a), (nb, b)| a.session_id.cmp(&b.session_id).then(na.cmp(nb)).then(a.key.cmp(&b.key)));
    out.into_iter().map(|(_, s)| s).collect()
}

/// Contexte de chaque conversation et suggestions, pour l'interface.
pub fn snapshot(i: &Inputs) -> Snapshot {
    let mut contexts: Vec<ContextInfo> = i.contexts.values().cloned().collect();
    contexts.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    Snapshot { contexts, suggestions: compute(i) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ArchiveEntry, Dismissal};

    fn ctx(id: &str, pct: f64, since: u64) -> ContextInfo {
        ContextInfo { session_id: id.into(), used_percentage: pct, at: since + 1, since }
    }

    fn contexts(list: &[ContextInfo]) -> HashMap<String, ContextInfo> {
        list.iter().map(|c| (c.session_id.clone(), c.clone())).collect()
    }

    fn dismiss(cfg: &mut Config, id: &str, key: &str, level: u32, at: u64) {
        cfg.conversations.entry(id.into()).or_default().dismissed_suggestions.insert(key.into(), Dismissal { level, at });
    }

    fn levels(cfg: &Config, ctxs: &HashMap<String, ContextInfo>) -> Vec<(String, u32)> {
        compute(&Inputs { config: cfg, contexts: ctxs }).into_iter().map(|s| (s.session_id, s.level)).collect()
    }

    #[test]
    fn context_thresholds_and_tiers() {
        // Seuil par défaut : paliers 60 → 80 → 90.
        assert_eq!(context_level(0.0, 60), None);
        assert_eq!(context_level(59.9, 60), None);
        assert_eq!(context_level(60.0, 60), Some(60));
        assert_eq!(context_level(79.0, 60), Some(60));
        assert_eq!(context_level(80.0, 60), Some(80));
        assert_eq!(context_level(89.9, 60), Some(80));
        assert_eq!(context_level(90.0, 60), Some(90));
        assert_eq!(context_level(100.0, 60), Some(90));
        // Seuil réglé plus haut : les paliers fixes en dessous disparaissent.
        assert_eq!(context_level(84.0, 85), None);
        assert_eq!(context_level(86.0, 85), Some(85));
        assert_eq!(context_level(95.0, 85), Some(90));
        assert_eq!(context_level(70.0, 40), Some(40));
        // Seuil hors bornes : ramené entre 10 et 95.
        assert_eq!(context_level(5.0, 0), None);
        assert_eq!(context_level(10.0, 0), Some(10));
        assert_eq!(context_level(99.0, 200), Some(95));
    }

    #[test]
    fn context_rule_suggests_hand_off() {
        let cfg = Config::default();
        let c = contexts(&[ctx("a", 72.4, 10), ctx("b", 12.0, 10), ctx("c", 91.0, 10)]);
        let got = compute(&Inputs { config: &cfg, contexts: &c });
        assert_eq!(got.len(), 2);
        assert_eq!(
            got[0],
            Suggestion { rule: RULE_CONTEXT, session_id: "a".into(), key: "context".into(), level: 60, since: Some(10), data: json!({"percent": 72.0}) }
        );
        assert_eq!((got[1].session_id.as_str(), got[1].level), ("c", 90));
        // Seuil réglable.
        let mut cfg = Config::default();
        cfg.suggestions.context_threshold = 75;
        assert_eq!(levels(&cfg, &c), vec![("c".into(), 90)]);
    }

    #[test]
    fn dismissed_until_next_tier() {
        let mut cfg = Config::default();
        dismiss(&mut cfg, "a", RULE_CONTEXT, 60, 100);
        // Ignorée à 60 % : masquée tant que le palier reste 60.
        assert_eq!(levels(&cfg, &contexts(&[ctx("a", 65.0, 50)])), vec![]);
        assert_eq!(levels(&cfg, &contexts(&[ctx("a", 79.9, 50)])), vec![]);
        // Palier suivant : elle reparaît.
        assert_eq!(levels(&cfg, &contexts(&[ctx("a", 80.0, 50)])), vec![("a".into(), 80)]);
        // Ignorée à 80 % : reparaît à 90 %.
        dismiss(&mut cfg, "a", RULE_CONTEXT, 80, 120);
        assert_eq!(levels(&cfg, &contexts(&[ctx("a", 85.0, 50)])), vec![]);
        assert_eq!(levels(&cfg, &contexts(&[ctx("a", 93.0, 50)])), vec![("a".into(), 90)]);
        // Ignorée à 90 % : plus rien au-dessus.
        dismiss(&mut cfg, "a", RULE_CONTEXT, 90, 130);
        assert_eq!(levels(&cfg, &contexts(&[ctx("a", 99.0, 50)])), vec![]);
        // Une autre conversation n'est pas concernée.
        assert_eq!(levels(&cfg, &contexts(&[ctx("b", 65.0, 50)])), vec![("b".into(), 60)]);
    }

    #[test]
    fn dismissal_forgotten_when_context_restarts() {
        let mut cfg = Config::default();
        dismiss(&mut cfg, "a", RULE_CONTEXT, 90, 100);
        // `/compact` après le clic : le remplissage repart (since = 200), la suggestion
        // reparaît dès le premier palier.
        assert_eq!(levels(&cfg, &contexts(&[ctx("a", 62.0, 200)])), vec![("a".into(), 60)]);
        // Sans `since` (règle sans début), « Ignorer » vaut pour de bon à ce palier.
        let s = Suggestion { rule: RULE_CONTEXT, session_id: "a".into(), key: "context".into(), level: 60, since: None, data: Value::Null };
        assert!(is_dismissed(&cfg, &s));
    }

    #[test]
    fn disabled_rules_and_archived_conversations() {
        let c = contexts(&[ctx("a", 72.0, 10), ctx("z", 95.0, 10)]);
        let mut cfg = Config::default();
        cfg.archives.push(ArchiveEntry { session_id: "z".into(), ..Default::default() });
        assert_eq!(levels(&cfg, &c), vec![("a".into(), 60)]);
        cfg.suggestions.disabled.push(RULE_CONTEXT.into());
        assert_eq!(levels(&cfg, &c), vec![]);
    }

    #[test]
    fn engine_sorts_and_keys_per_rule() {
        // Deux règles fictives : l'ordre suit la conversation puis RULES ; « Ignorer » vaut
        // pour une clé seulement.
        fn first(_: &Inputs) -> Vec<Suggestion> {
            ["b", "a"].iter().map(|id| Suggestion { rule: "first", session_id: (*id).into(), key: "first".into(), level: 1, since: None, data: Value::Null }).collect()
        }
        fn second(_: &Inputs) -> Vec<Suggestion> {
            ["x", "y"]
                .iter()
                .map(|o| Suggestion { rule: "second", session_id: "a".into(), key: format!("second:{o}"), level: 1, since: None, data: Value::Null })
                .collect()
        }
        let rules = [Rule { id: "first", detect: first }, Rule { id: "second", detect: second }];
        let mut cfg = Config::default();
        let none = HashMap::new();
        let keys = |cfg: &Config| -> Vec<(String, String)> {
            compute_with(&rules, &Inputs { config: cfg, contexts: &none }).into_iter().map(|s| (s.session_id, s.key)).collect()
        };
        let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
        assert_eq!(keys(&cfg), vec![pair("a", "first"), pair("a", "second:x"), pair("a", "second:y"), pair("b", "first")]);
        dismiss(&mut cfg, "a", "second:x", 1, 0);
        assert_eq!(keys(&cfg), vec![pair("a", "first"), pair("a", "second:y"), pair("b", "first")]);
        cfg.suggestions.disabled.push("first".into());
        assert_eq!(keys(&cfg), vec![pair("a", "second:y")]);
    }

    #[test]
    fn snapshot_serializes_for_the_interface() {
        let cfg = Config::default();
        let c = contexts(&[ctx("a", 80.0, 3)]);
        let v = serde_json::to_value(snapshot(&Inputs { config: &cfg, contexts: &c })).unwrap();
        assert_eq!(
            v,
            json!({
                "contexts": [{"sessionId": "a", "usedPercentage": 80.0, "at": 4, "since": 3}],
                "suggestions": [{"rule": "context", "sessionId": "a", "key": "context", "level": 80, "since": 3, "data": {"percent": 80.0}}]
            })
        );
    }
}
