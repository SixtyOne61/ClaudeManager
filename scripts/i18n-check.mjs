// Contrôle du catalogue de textes (src/i18n/fr/*.ts) : `node scripts/i18n-check.mjs`.
//
// - chaque clé est préfixée par le nom de son fichier (`sidebar.…` dans sidebar.ts) ;
// - aucune clé en double ;
// - chaque clé est utilisée quelque part dans src/ (hors catalogue), sauf celles construites
//   à l'exécution : `error.*` (erreurs codées du backend) et `slash.builtin.*` (commandes) ;
// - chaque texte se lit (accolades équilibrées).
// Les clés utilisées mais absentes sont déjà signalées par TypeScript (`t()` n'accepte que
// les clés du catalogue).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const catalogDir = join(root, "src", "i18n", "fr");
const DYNAMIC = [/^error\./, /^slash\.builtin\./];
const PREFIX_OF = { errors: "error." };

const problems = [];
const keys = new Map();
for (const file of readdirSync(catalogDir).filter((f) => f.endsWith(".ts"))) {
  const mod = basename(file, ".ts");
  const prefix = PREFIX_OF[mod] ?? mod + ".";
  const text = readFileSync(join(catalogDir, file), "utf8");
  for (const m of text.matchAll(/^\s*"([^"]+)":\s*(".*"|`[\s\S]*?`),?\s*$/gm)) {
    const [, key, value] = m;
    if (!key.startsWith(prefix)) problems.push(`${file} : clé « ${key} » sans le préfixe « ${prefix} »`);
    if (keys.has(key)) problems.push(`clé en double « ${key} » (${keys.get(key).file} et ${file})`);
    keys.set(key, { file, value });
    let depth = 0;
    for (const c of value) {
      if (c === "{") depth++;
      else if (c === "}" && --depth < 0) break;
    }
    if (depth !== 0) problems.push(`${file} : accolades déséquilibrées dans « ${key} »`);
  }
}

function sources(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return p.endsWith(join("src", "i18n")) ? [] : sources(p);
    return /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}
const code = sources(join(root, "src")).map((p) => readFileSync(p, "utf8")).join("\n");
for (const key of keys.keys()) {
  if (DYNAMIC.some((re) => re.test(key))) continue;
  if (!code.includes(`"${key}"`) && !code.includes(`'${key}'`) && !code.includes("`" + key + "`")) problems.push(`clé inutilisée « ${key} »`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} problème(s), ${keys.size} clés.`);
  process.exit(1);
}
console.log(`Catalogue correct : ${keys.size} clés.`);
