//! Pièces jointes : image collée (Ctrl+V) dans la zone de saisie, écrite dans un fichier
//! temporaire dont le chemin est ensuite cité dans le message (`@chemin`) : Claude Code le
//! lit comme une pièce jointe. Les fichiers déjà sur le disque sont cités tels quels, sans copie.
//! Les images collées sont supprimées à la fermeture de l'app.
//!
//! [`preview`] lit une pièce jointe pour la visionneuse de l'app (image, texte, PDF). Une
//! image disparue (image collée supprimée, fichier déplacé) est retrouvée dans le `.jsonl` de
//! la conversation, où Claude Code en garde une copie.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
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

// ---- Visionneuse -------------------------------------------------------------------------

/// Taille maximale d'une image ou d'un PDF envoyé à la visionneuse.
const MAX_BINARY: u64 = 40 * 1024 * 1024;
/// Texte lu au plus (le reste est signalé comme tronqué).
const MAX_TEXT: usize = 512 * 1024;

/// Contenu d'une pièce jointe pour la visionneuse.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Preview {
    /// Image en data URL ; `transcript` : copie gardée dans la conversation (fichier disparu).
    Image { src: String, transcript: bool },
    Text { text: String, truncated: bool },
    /// PDF encodé en base64.
    Pdf { data: String },
    /// Fichier présent, mais ni image, ni texte, ni PDF (ou trop gros).
    Unsupported,
    /// Fichier introuvable, et aucune copie dans la conversation.
    Missing,
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

fn is_pdf(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// Lit `path` pour la visionneuse ; `transcript` : `.jsonl` de la conversation, pour une image
/// qui n'est plus sur le disque.
pub fn preview(path: &str, transcript: Option<&Path>) -> Preview {
    let p = Path::new(path);
    let Some(meta) = std::fs::metadata(p).ok().filter(|m| m.is_file()) else {
        return transcript.and_then(|t| image_from_transcript(t, path)).unwrap_or(Preview::Missing);
    };
    if let Some(mime) = image_mime(p) {
        if meta.len() > MAX_BINARY {
            return Preview::Unsupported;
        }
        return match std::fs::read(p) {
            Ok(bytes) => Preview::Image { src: format!("data:{mime};base64,{}", STANDARD.encode(bytes)), transcript: false },
            Err(_) => Preview::Missing,
        };
    }
    if is_pdf(p) {
        if meta.len() > MAX_BINARY {
            return Preview::Unsupported;
        }
        return std::fs::read(p).map(|b| Preview::Pdf { data: STANDARD.encode(b) }).unwrap_or(Preview::Missing);
    }
    let Ok(file) = std::fs::File::open(p) else { return Preview::Missing };
    let mut buf = Vec::new();
    if file.take(MAX_TEXT as u64 + 1).read_to_end(&mut buf).is_err() {
        return Preview::Missing;
    }
    let truncated = buf.len() > MAX_TEXT;
    buf.truncate(MAX_TEXT);
    // Un octet nul dans le début : fichier binaire.
    if buf.iter().take(8192).any(|&b| b == 0) {
        return Preview::Unsupported;
    }
    Preview::Text { text: String::from_utf8_lossy(&buf).into_owned(), truncated }
}

/// Dernière copie de l'image `path` dans le `.jsonl` (ligne `attachment` de type `file`).
fn image_from_transcript(transcript: &Path, path: &str) -> Option<Preview> {
    let reader = BufReader::new(std::fs::File::open(transcript).ok()?);
    let mut found = None;
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains("\"attachment\"") || !line.contains("\"base64\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let a = &v["attachment"];
        if a["filename"].as_str() != Some(path) || a["content"]["type"].as_str() != Some("image") {
            continue;
        }
        let file = &a["content"]["file"];
        if let (Some(data), Some(mime)) = (file["base64"].as_str(), file["type"].as_str()) {
            found = Some(Preview::Image { src: format!("data:{mime};base64,{data}"), transcript: true });
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("cm-preview-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d.join(name)
    }

    #[test]
    fn texte_image_binaire_absent() {
        let t = tmp("note.md");
        std::fs::write(&t, "# Titre\nbonjour").unwrap();
        assert_eq!(preview(t.to_str().unwrap(), None), Preview::Text { text: "# Titre\nbonjour".into(), truncated: false });

        let i = tmp("a.PNG");
        std::fs::write(&i, [1u8, 2, 3]).unwrap();
        assert_eq!(preview(i.to_str().unwrap(), None), Preview::Image { src: "data:image/png;base64,AQID".into(), transcript: false });

        let b = tmp("x.bin");
        std::fs::write(&b, [0u8, 1, 2]).unwrap();
        assert_eq!(preview(b.to_str().unwrap(), None), Preview::Unsupported);

        assert_eq!(preview(r"C:\nulle\part.png", None), Preview::Missing);
    }

    #[test]
    fn texte_tronque() {
        let t = tmp("long.txt");
        std::fs::write(&t, "a".repeat(MAX_TEXT + 10)).unwrap();
        let Preview::Text { text, truncated } = preview(t.to_str().unwrap(), None) else { panic!() };
        assert!(truncated);
        assert_eq!(text.len(), MAX_TEXT);
    }

    #[test]
    fn image_disparue_retrouvee_dans_la_conversation() {
        let gone = r"C:\Temp\claude-manager-attachments\image-1.png";
        let jsonl = tmp("s.jsonl");
        let line = serde_json::json!({
            "type": "attachment",
            "attachment": { "type": "file", "filename": gone, "content": { "type": "image", "file": { "base64": "AQID", "type": "image/png" } } }
        });
        std::fs::write(&jsonl, format!("{{\"type\":\"user\"}}\n{line}\n")).unwrap();
        assert_eq!(preview(gone, Some(&jsonl)), Preview::Image { src: "data:image/png;base64,AQID".into(), transcript: true });
        assert_eq!(preview(r"C:\autre.png", Some(&jsonl)), Preview::Missing);
    }
}
