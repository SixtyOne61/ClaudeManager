// Menu des commandes `/…` au-dessus de la zone de saisie, comme dans Claude Code :
// il s'ouvre quand le texte commence par `/`, se filtre pendant la frappe, se parcourt au
// clavier (↑ ↓, Tab ou Entrée pour compléter, Échap pour fermer) ou à la souris.
// Compléter remplace la saisie par `/nom ` sans envoyer le message.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cachedSlashCommands, filterSlashCommands, loadSlashCommands, slashArgumentHint, slashDescription, slashQuery, sourceLabel, type SlashEntry } from "../slashCommands";
import { t } from "../i18n";

/** Au-delà, la liste est coupée (le filtrage reste possible). */
const MAX_SHOWN = 200;

interface Options {
  text: string;
  setText: (t: string) => void;
  cwd: string | null;
  sessionId: string | null;
}

/**
 * État du menu pour une zone de saisie. `onKeyDown` est à appeler en premier dans le
 * gestionnaire de touches de la zone : il renvoie true quand le menu a consommé la touche.
 */
export function useSlashMenu({ text, setText, cwd, sessionId }: Options) {
  const query = slashQuery(text);
  const [dismissed, setDismissed] = useState(false);
  const [entries, setEntries] = useState<SlashEntry[]>(() => cachedSlashCommands(cwd, sessionId) ?? []);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const open = query !== null && !dismissed;

  // Échap ferme le menu jusqu'à ce que la saisie ne commence plus par `/`.
  useEffect(() => {
    if (query === null) setDismissed(false);
  }, [query]);

  // À chaque ouverture : liste en cache affichée tout de suite, puis relue (skills ajoutés…).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const cached = cachedSlashCommands(cwd, sessionId);
    if (cached) setEntries(cached);
    setLoading(!cached);
    loadSlashCommands(cwd, sessionId)
      .then((list) => alive && setEntries(list))
      .catch(() => {
        /* backend indisponible : on garde la liste connue */
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, cwd, sessionId]);

  const matches = useMemo(() => (open ? filterSlashCommands(entries, query ?? "").slice(0, MAX_SHOWN) : []), [open, entries, query]);

  // La sélection revient en tête quand le filtre change.
  useEffect(() => setSelected(0), [query]);

  const pick = (e: SlashEntry) => setText(`/${e.name} `);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
      return true;
    }
    if (matches.length === 0) return false;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected((s) => (s + 1) % matches.length);
        return true;
      case "ArrowUp":
        e.preventDefault();
        setSelected((s) => (s - 1 + matches.length) % matches.length);
        return true;
      case "Tab":
        e.preventDefault();
        pick(matches[Math.min(selected, matches.length - 1)]);
        return true;
      case "Enter":
        if (e.shiftKey || e.nativeEvent.isComposing) return false;
        e.preventDefault();
        pick(matches[Math.min(selected, matches.length - 1)]);
        return true;
      default:
        return false;
    }
  };

  const menu = open ? (
    <SlashMenu matches={matches} selected={Math.min(selected, Math.max(0, matches.length - 1))} loading={loading} onHover={setSelected} onPick={pick} />
  ) : null;

  return { open, onKeyDown, menu };
}

interface MenuProps {
  matches: SlashEntry[];
  selected: number;
  loading: boolean;
  onHover: (i: number) => void;
  onPick: (e: SlashEntry) => void;
}

function SlashMenu({ matches, selected, loading, onHover, onPick }: MenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Garde l'entrée sélectionnée visible pendant la navigation au clavier.
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, matches]);

  return (
    <div className="slash-menu">
      <div className="slash-list" role="listbox" aria-label={t("slash.menu.ariaLabel")} ref={listRef}>
        {matches.length === 0 ? (
          <div className="slash-empty">{loading ? t("slash.menu.loading") : t("slash.menu.noMatch")}</div>
        ) : (
          matches.map((e, i) => {
            const description = slashDescription(e);
            const hint = slashArgumentHint(e);
            return (
            <div
              key={e.name}
              data-index={i}
              role="option"
              aria-selected={i === selected}
              className={"slash-item" + (i === selected ? " selected" : "")}
              onMouseEnter={() => onHover(i)}
              // mousedown : la zone de saisie garde la mise au point.
              onMouseDown={(ev) => {
                ev.preventDefault();
                onPick(e);
              }}
            >
              <span className="slash-name">
                /{e.name}
                {hint && <span className="slash-hint"> {hint}</span>}
              </span>
              <span className="slash-desc" title={description}>
                {description}
              </span>
              <span className={"slash-source " + e.source}>{sourceLabel(e.source)}</span>
            </div>
            );
          })
        )}
      </div>
      <div className="slash-help">{t("slash.menu.help")}</div>
    </div>
  );
}
