// Rendu Markdown des réponses de l'agent.
//
// `marked` (analyse, sans dépendance) puis `DOMPurify` (nettoyage du HTML produit) : deux
// petites bibliothèques embarquées dans l'app, aucune ressource réseau, la politique de
// sécurité de la fenêtre ne change pas. Le texte vient de l'agent : le HTML brut qu'il
// pourrait contenir est nettoyé (pas de script, d'image, de formulaire ni de style). Les
// liens restent affichés mais ne sont pas suivis (voir `ConversationView`).

import { Marked } from "marked";
import DOMPurify from "dompurify";

const marked = new Marked({ gfm: true, breaks: true, async: false });

const cache = new Map<string, string>();
const CACHE_MAX = 2000;

/** HTML nettoyé d'un texte Markdown. */
export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const raw = marked.parse(text) as string;
  const html = DOMPurify.sanitize(raw, {
    FORBID_TAGS: ["img", "style", "form", "input", "button", "iframe", "object", "embed", "video", "audio", "svg", "math"],
    FORBID_ATTR: ["style", "class", "id"],
  });
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(text, html);
  return html;
}
