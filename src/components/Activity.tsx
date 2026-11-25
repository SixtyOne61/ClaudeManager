// Pastille d'activité d'une conversation et compteurs (projet, catégorie).
// Couleurs propres, indépendantes de la couleur de la conversation.

import { t } from "../i18n";
import { activityDisplay, activityLabel, type Activity, type ActivityCount } from "../activity";

/**
 * Pastille : verte qui pulse (en cours), orange (action requise ; rouge pour une erreur),
 * bleue discrète (à toi), rien (fermée). `compact` : rien du tout quand la conversation est
 * fermée (sinon un espace vide garde l'alignement des lignes).
 */
export function ActivityDot({ activity, compact }: { activity: Activity | null | undefined; compact?: boolean }) {
  const display = activityDisplay(activity);
  if (display === "closed") return compact ? null : <span className="session-activity" aria-hidden />;
  const label = activityLabel(activity);
  const error = display === "action" && activity?.kind === "error" ? " activity-error" : "";
  return <span className={`session-activity activity-dot activity-${display}${error}`} title={label} aria-label={label} role="img" />;
}

/** Compteurs « en cours » et « action requise » ; rien si les deux sont à zéro. */
export function ActivityCounts({ running, action }: ActivityCount) {
  if (!running && !action) return null;
  return (
    <span className="activity-counts">
      {running > 0 && (
        <span className="activity-count" title={t("app.activity.runningCount", { count: running })}>
          <span className="activity-dot activity-running" />
          {running}
        </span>
      )}
      {action > 0 && (
        <span className="activity-count" title={t("app.activity.actionCount", { count: action })}>
          <span className="activity-dot activity-action" />
          {action}
        </span>
      )}
    </span>
  );
}
