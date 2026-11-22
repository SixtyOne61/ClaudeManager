// Rendu Markdown des réponses de l'agent.
//
// `marked` (analyse, sans dépendance) puis `DOMPurify` (nettoyage du HTML produit) : deux
// petites bibliothèques embarquées dans l'app, aucune ressource réseau, la politique de
// sécurité de la fenêtre ne change pas. Le texte vient de l'agent : le HTML brut qu'il
// pourrait contenir est nettoyé (pas de script, d'image, de formulaire ni de style). Les
// liens `http(s)` s'ouvrent dans le navigateur, les autres ne sont pas suivis (voir
// `ConversationView`). La classe `language-…` des blocs de code est gardée : elle dit si un
// bloc est une commande exécutable (bouton ▶, voir `CodeRunner`).

import { Marked } from "marked";
import DOMPurify from "dompurify";

const marked = new Marked({ gfm: true, breaks: true, async: false });

// Seule exception aux attributs interdits : `class="language-…"` d'un `<code>`.
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName === "class" && node.nodeName === "CODE" && /^language-[\w+-]+$/.test(data.attrValue)) data.forceKeepAttr = true;
});

const cache = new Map<string, string>();
const CACHE_MAX = 2000;

const SANITIZE = {
  FORBID_TAGS: ["img", "style", "form", "input", "button", "iframe", "object", "embed", "video", "audio", "svg", "math"],
  FORBID_ATTR: ["style", "class", "id"],
};

/** HTML nettoyé d'un texte Markdown. */
export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const raw = marked.parse(text) as string;
  const html = DOMPurify.sanitize(raw, SANITIZE);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(text, html);
  return html;
}

/** HTML nettoyé d'une ligne de Markdown (titre) : emphase et code, sans paragraphe. */
export function renderMarkdownInline(text: string): string {
  return DOMPurify.sanitize(marked.parseInline(text) as string, SANITIZE);
}
