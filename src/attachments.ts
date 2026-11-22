// Pièces jointes d'un message : chaque fichier est cité par une mention `@"chemin"` que
// Claude Code lit comme une pièce jointe (image ou fichier).
//
// - Toujours entre guillemets : sans eux, Claude Code reconnaît un chemin d'image collé et le
//   charge (« Pasting… ») ; l'Entrée envoyée juste après est alors perdue et le message reste
//   dans sa zone de saisie.
// - Les mentions vont sur la première ligne, le texte après. Seules, elles sont suivies d'un
//   espace pour que le curseur ne reste pas sur une mention.
// - À l'affichage, une ligne faite uniquement de mentions de chemins absolus est montrée en
//   pièces jointes (les messages envoyés avant ce format avaient la ligne à la fin).

/** Mention `@"chemin"` d'un fichier. */
export const mention = (path: string) => `@"${path}"`;

/** Texte envoyé au terminal pour un message et ses pièces jointes. */
export function composeMessage(text: string, paths: string[]): string {
  if (!paths.length) return text;
  const refs = paths.map(mention).join(" ");
  return text ? `${refs}\n${text}` : `${refs} `;
}

const TOKEN = /@"([^"]+)"|@(\S+)/g;
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** Chemins d'une ligne faite uniquement de mentions de chemins absolus, sinon null. */
function attachmentLine(line: string): string[] | null {
  const paths: string[] = [];
  let rest = line;
  for (const m of line.matchAll(TOKEN)) {
    const path = m[1] ?? m[2];
    if (!ABSOLUTE.test(path)) return null;
    paths.push(path);
    rest = rest.replace(m[0], "");
  }
  return paths.length && !rest.trim() ? paths : null;
}

/** Sépare le texte d'un message de ses pièces jointes. */
export function splitAttachments(message: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const kept: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    const found = attachmentLine(line);
    if (found) paths.push(...found);
    else kept.push(line);
  }
  return paths.length ? { text: kept.join("\n").trim(), paths } : { text: message, paths };
}

/** Nom du fichier d'un chemin. */
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Extension d'image reconnue (icône dans la bulle). */
export const isImagePath = (path: string) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(path);
