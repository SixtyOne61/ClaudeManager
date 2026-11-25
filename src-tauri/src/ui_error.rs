//! Erreurs montrées à l'utilisateur, sous forme codée pour que l'interface les affiche dans sa
//! langue (voir `errorMessage` dans src/api.ts et le catalogue `src/i18n/fr/errors.ts`).
//!
//! Une commande renvoie `Err(ui_err("pty.notFound", json!({ "path": p })))` ; l'interface
//! affiche le texte de la clé `error.pty.notFound`, variables remplacées. Les messages
//! techniques bruts (sortie de git, erreur système) restent des chaînes ordinaires, ajoutées
//! si besoin en paramètre (`"detail"`).

use serde_json::Value;

/// Erreur codée : `{"uiError":"<code>","params":{…}}`.
/// `uiError` en premier (l'interface reconnaît l'erreur à ce début) : écrit à la main, car
/// `serde_json` range les clés d'un objet par ordre alphabétique.
pub fn ui_err(code: &str, params: Value) -> String {
    format!(r#"{{"uiError":{},"params":{}}}"#, Value::from(code), params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coded_error_is_json_with_code_and_params() {
        let s = ui_err("pty.notFound", json!({ "path": "C:/x" }));
        assert!(s.starts_with(r#"{"uiError""#));
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["uiError"], "pty.notFound");
        assert_eq!(v["params"]["path"], "C:/x");
    }
}
