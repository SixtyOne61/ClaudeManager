//! Pièces jointes : image collée (Ctrl+V) dans la zone de saisie, écrite dans un fichier
//! temporaire dont le chemin est ensuite cité dans le message (`@chemin`) : Claude Code le
//! lit comme une pièce jointe. Les fichiers déjà sur le disque sont cités tels quels, sans copie.
//! Les images collées sont supprimées à la fermeture de l'app.

use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request};

/// Dossier des images collées.
fn dir() -> std::path::PathBuf {
    std::env::temp_dir().join("claude-manager-attachments")
}

/// Supprime les images collées (à la fermeture de l'app, et au démarrage pour les restes).
pub fn clear() {
    let _ = std::fs::remove_dir_all(dir());
}

/// Écrit l'image reçue (octets bruts du corps de la requête, extension dans l'en-tête `x-ext`)
/// dans le dossier temporaire et renvoie son chemin.
#[tauri::command]
pub fn save_pasted_image(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("image attendue en octets bruts".into());
    };
    let ext: String = request
        .headers()
        .get("x-ext")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("png")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(5)
        .collect();
    let ext = if ext.is_empty() { "png".to_string() } else { ext.to_lowercase() };
    let dir = dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("image-{stamp}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
