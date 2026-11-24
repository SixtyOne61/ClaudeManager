// Affichage des suggestions (voir src/suggestions.ts) : icône 💡 dans la barre latérale et
// bandeaux dans l'onglet de la conversation, avec un bouton d'action et « Ignorer ».
// L'app n'agit jamais d'elle-même : l'action ne part que sur un clic.

import { useContext } from "react";
import { X } from "lucide-react";
import { SUGGESTION_RULES, suggestionHint, suggestionsOf, useSuggestions, type Suggestion } from "../suggestions";
import { ConversationLinksContext } from "../messages";

/** Icône 💡 (sans compteur). `title` : info-bulle. */
export function SuggestionIcon({ title }: { title: string }) {
  return (
    <span className="suggestion-icon" title={title} aria-label={title} role="img">
      💡
    </span>
  );
}

/** Icône 💡 d'une conversation, avec le détail de ses suggestions ; rien s'il n'y en a pas. */
export function ConversationSuggestionIcon({ sessionId }: { sessionId: string }) {
  const list = suggestionsOf(useSuggestions(), sessionId);
  return list.length > 0 ? <SuggestionIcon title={suggestionHint(list)} /> : null;
}

/** Gestionnaire d'une action de suggestion, fourni par la vue qui affiche les bandeaux. */
export interface SuggestionActionHandler {
  run: (s: Suggestion) => void;
  /** Raison pour laquelle l'action est indisponible pour l'instant (bouton grisé). */
  disabledReason?: string | null;
}

interface BannersProps {
  sessionId: string;
  onDismiss: (s: Suggestion) => void;
  /** Gestionnaires par identifiant d'action (`SUGGESTION_RULES[règle].action.id`). Une action
   *  sans gestionnaire est affichée grisée. */
  actions?: Partial<Record<string, SuggestionActionHandler>>;
}

/** Bandeaux des suggestions d'une conversation (rien s'il n'y en a pas). */
export function SuggestionBanners({ sessionId, onDismiss, actions }: BannersProps) {
  const list = suggestionsOf(useSuggestions(), sessionId);
  const links = useContext(ConversationLinksContext);
  const ctx = { titleOf: links?.titleOf ?? (() => null) };
  const shown = list.filter((s) => SUGGESTION_RULES[s.rule]?.text);
  if (shown.length === 0) return null;
  return (
    <div className="suggestion-banners">
      {shown.map((s) => {
        const rule = SUGGESTION_RULES[s.rule];
        const handler = rule.action ? actions?.[rule.action.id] : undefined;
        const unavailable = !handler ? "Pas encore disponible dans cette version" : handler.disabledReason ?? null;
        return (
          <div key={`${s.rule}:${s.key}`} className="suggestion-banner" role="status">
            <span className="suggestion-banner-icon" aria-hidden>
              💡
            </span>
            <span className="suggestion-banner-text">{rule.text!(s, ctx)}</span>
            {rule.action && (
              <button className="btn small primary" disabled={!!unavailable} title={unavailable ?? undefined} onClick={() => handler?.run(s)}>
                {typeof rule.action.label === "function" ? rule.action.label(s) : rule.action.label}
              </button>
            )}
            <button
              className="btn small ghost"
              onClick={() => onDismiss(s)}
              title={rule.dismissHint ?? "Masquer cette suggestion pour cette conversation (elle reviendra si la situation s'aggrave)"}
            >
              <X size={12} /> Ignorer
            </button>
          </div>
        );
      })}
    </div>
  );
}
