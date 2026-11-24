//! Moteur de suggestions (voir GLOSSARY.md, « Suggestion », et `.scratch/suggestions/spec.md`).
//!
//! L'app repère des situations où une bonne pratique s'impose et la propose, sans jamais
//! agir seule. La détection n'utilise que des données déjà là (ligne d'état, configuration,
//! échanges entre conversations déjà repérés…), sans appel à un modèle.
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

use crate::config::{Config, Hub};
use crate::context::ContextInfo;
use crate::messages::Exchange;
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

/// Règle « Conversations qui ont échangé » : proposer de les regrouper dans un hub.
pub const RULE_HUB: &str = "hub";

/// Données disponibles pour la détection.
pub struct Inputs<'a> {
    pub config: &'a Config,
    /// Dernier remplissage connu du contexte, par conversation.
    pub contexts: &'a HashMap<String, ContextInfo>,
    /// Paires de conversations qui ont échangé un message (premier message de chaque paire,
    /// voir `messages::ExchangeTracker`).
    pub exchanges: &'a [Exchange],
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
pub const RULES: &[Rule] = &[Rule { id: RULE_CONTEXT, detect: detect_context }, Rule { id: RULE_HUB, detect: detect_hub }];

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
// Règle « Conversations qui ont échangé »
// ---------------------------------------------------------------------------

/// Hub (non archivé) d'une conversation.
fn active_hub<'a>(cfg: &'a Config, id: &str) -> Option<&'a Hub> {
    crate::hubs::hub_of(cfg, id).map(|(h, _)| h).filter(|h| h.archived.is_none())
}

/// Deux conversations (non archivées) qui ne sont pas dans un même hub ont échangé un
/// message : une suggestion dans chacune (clé `hub:<autre>`, « Ignorer » définitif : palier
/// unique, sans début). Données pour l'interface : l'autre conversation, l'expéditeur et le
/// destinataire du premier message (futurs coordinateur et exécutant), et, si l'une est déjà
/// dans un hub, ce hub et la conversation qui le rejoindrait (`joiner`) : l'autre si celle-ci
/// est dans un hub, sinon elle-même ; `leaves` : le hub que `joiner` quitterait (une
/// conversation est dans un hub au plus).
fn detect_hub(i: &Inputs) -> Vec<Suggestion> {
    let cfg = i.config;
    let mut out = Vec::new();
    for e in i.exchanges {
        // Une conversation archivée ne se regroupe pas : rien pour la paire.
        if cfg.archives.iter().any(|a| a.session_id == e.from || a.session_id == e.to) {
            continue;
        }
        let (hub_from, hub_to) = (active_hub(cfg, &e.from), active_hub(cfg, &e.to));
        if hub_from.zip(hub_to).is_some_and(|(a, b)| a.id == b.id) {
            continue;
        }
        for (me, other, my_hub, other_hub) in [(&e.from, &e.to, hub_from, hub_to), (&e.to, &e.from, hub_to, hub_from)] {
            let (hub, joiner, leaves) = match (my_hub, other_hub) {
                (Some(h), _) => (Some(h), Some(other), other_hub),
                (None, Some(h)) => (Some(h), Some(me), None),
                (None, None) => (None, None, None),
            };
            out.push(Suggestion {
                rule: RULE_HUB,
                session_id: me.clone(),
                key: format!("{RULE_HUB}:{other}"),
                level: 1,
                since: None,
                data: json!({
                    "other": other,
                    "from": e.from,
                    "to": e.to,
                    "hubId": hub.map(|h| &h.id),
                    "hubName": hub.map(|h| &h.name),
                    "joiner": joiner,
                    "leaves": leaves.map(|h| &h.name),
                }),
            });
        }
    }
    out
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
    use crate::config::{ArchiveEntry, Dismissal, HubRole};

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
        compute(&Inputs { config: cfg, contexts: ctxs, exchanges: &[] }).into_iter().map(|s| (s.session_id, s.level)).collect()
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
        let got = compute(&Inputs { config: &cfg, contexts: &c, exchanges: &[] });
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
            compute_with(&rules, &Inputs { config: cfg, contexts: &none, exchanges: &[] }).into_iter().map(|s| (s.session_id, s.key)).collect()
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
        let v = serde_json::to_value(snapshot(&Inputs { config: &cfg, contexts: &c, exchanges: &[] })).unwrap();
        assert_eq!(
            v,
            json!({
                "contexts": [{"sessionId": "a", "usedPercentage": 80.0, "at": 4, "since": 3}],
                "suggestions": [{"rule": "context", "sessionId": "a", "key": "context", "level": 80, "since": 3, "data": {"percent": 80.0}}]
            })
        );
    }

    fn exchange(from: &str, to: &str) -> Exchange {
        Exchange { from: from.into(), to: to.into() }
    }

    /// (conversation, clé, hub proposé, conversation qui le rejoindrait, hub quitté)
    type HubSuggestion = (String, String, Option<String>, Option<String>, Option<String>);

    fn hub_suggestions(cfg: &Config, exchanges: &[Exchange]) -> Vec<HubSuggestion> {
        let none = HashMap::new();
        compute(&Inputs { config: cfg, contexts: &none, exchanges })
            .into_iter()
            .filter(|s| s.rule == RULE_HUB)
            .map(|s| {
                let text = |k: &str| s.data[k].as_str().map(str::to_string);
                (s.session_id.clone(), s.key.clone(), text("hubName"), text("joiner"), text("leaves"))
            })
            .collect()
    }

    fn hub(cfg: &mut Config, name: &str, members: &[(&str, HubRole)]) -> String {
        let id = crate::hubs::create(cfg, name, None, 1).unwrap();
        for (m, role) in members {
            crate::hubs::set_member(cfg, &id, m, *role).unwrap();
        }
        id
    }

    #[test]
    fn hub_rule_suggests_grouping_both_conversations() {
        let mut cfg = Config::default();
        let ex = [exchange("a", "b")];
        let s = |id: &str, key: &str| (id.to_string(), key.to_string(), None, None, None);
        assert_eq!(hub_suggestions(&cfg, &ex), vec![s("a", "hub:b"), s("b", "hub:a")]);
        // Données : l'autre conversation, l'expéditeur et le destinataire du premier message.
        let none = HashMap::new();
        let all = compute(&Inputs { config: &cfg, contexts: &none, exchanges: &ex });
        assert_eq!(
            all[1].data,
            json!({"other": "a", "from": "a", "to": "b", "hubId": null, "hubName": null, "joiner": null, "leaves": null})
        );
        assert_eq!((all[1].level, all[1].since), (1, None));

        // « Ignorer » : définitif pour cette paire, dans cette conversation.
        dismiss(&mut cfg, "a", "hub:b", 1, 0);
        assert_eq!(hub_suggestions(&cfg, &ex), vec![s("b", "hub:a")]);
        // Règle coupée.
        cfg.suggestions.disabled.push(RULE_HUB.into());
        assert!(hub_suggestions(&cfg, &ex).is_empty());
    }

    #[test]
    fn hub_rule_proposes_existing_hub() {
        let mut cfg = Config::default();
        let ex = [exchange("a", "b")];
        // Déjà dans un même hub : rien.
        let h = hub(&mut cfg, "Refonte", &[("a", HubRole::Coordinateur), ("b", HubRole::Executant)]);
        assert!(hub_suggestions(&cfg, &ex).is_empty());
        // L'une seulement dans un hub : y ajouter l'autre.
        crate::hubs::remove_member(&mut cfg, &h, "b").unwrap();
        let some = |x: &str| Some(x.to_string());
        assert_eq!(
            hub_suggestions(&cfg, &ex),
            vec![
                ("a".into(), "hub:b".into(), some("Refonte"), some("b"), None),
                ("b".into(), "hub:a".into(), some("Refonte"), some("b"), None),
            ]
        );
        // Chacune dans un hub différent : chacune propose d'accueillir l'autre, qui quitterait le sien.
        hub(&mut cfg, "Site", &[("b", HubRole::Pair)]);
        assert_eq!(
            hub_suggestions(&cfg, &ex),
            vec![
                ("a".into(), "hub:b".into(), some("Refonte"), some("b"), some("Site")),
                ("b".into(), "hub:a".into(), some("Site"), some("a"), some("Refonte")),
            ]
        );
        // Un hub archivé ne compte pas.
        crate::hubs::mark_archived(&mut cfg, &h, vec![], 2).unwrap();
        assert_eq!(hub_suggestions(&cfg, &ex)[0], ("a".into(), "hub:b".into(), some("Site"), some("a"), None));
        // L'une est archivée : rien pour la paire.
        cfg.archives.push(ArchiveEntry { session_id: "a".into(), ..Default::default() });
        assert!(hub_suggestions(&cfg, &ex).is_empty());
    }
}
