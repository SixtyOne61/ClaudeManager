// Phrases traduites qui contiennent un élément React (titre en gras, chemin en `<code>`…) :
// la phrase reste entière dans le catalogue, l'élément prend la place de sa variable.

import { Fragment, type ReactNode } from "react";
import { t, type MessageKey, type Vars } from "./index";

/** Repère d'une variable remplacée par un élément (caractère absent des textes). */
const MARK = "\u0001";

/**
 * Texte de `key` où chaque variable nommée dans `elements` est remplacée par son élément.
 * Exemple : `tRich("hubs.dialog.conversation", {}, { title: <strong>{title}</strong> })`.
 */
export function tRich(key: MessageKey, vars: Vars, elements: Record<string, ReactNode>): ReactNode {
  const names = Object.keys(elements);
  const marks = Object.fromEntries(names.map((n, i) => [n, `${MARK}${i}${MARK}`]));
  const parts = t(key, { ...vars, ...marks }).split(MARK);
  return parts.map((part, i) => <Fragment key={i}>{i % 2 === 0 ? part : elements[names[Number(part)]]}</Fragment>);
}

/** Texte de `key` avant et après la variable `name` (pour placer soi-même l'élément). */
export function tSplit(key: MessageKey, name: string, vars: Vars = {}): [string, string] {
  const text = t(key, { ...vars, [name]: MARK });
  const i = text.indexOf(MARK);
  return i < 0 ? [text, ""] : [text.slice(0, i), text.slice(i + MARK.length)];
}
