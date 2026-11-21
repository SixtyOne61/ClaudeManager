// Pastille d'activité d'une conversation et compteurs (projet, catégorie).
// Couleurs propres, indépendantes de la couleur de la conversation.

import { activityLabel, activityStatus, type Activity } from "../activity";

/** Pastille : verte qui pulse (en cours), orange (attend ta réponse), rien (terminée). */
export function ActivityDot({ activity }: { activity: Activity | null | undefined }) {
  const status = activityStatus(activity);
  if (status === "ended") return <span className="session-activity" aria-hidden />;
  const label = activityLabel(activity);
  return <span className={`session-activity activity-dot activity-${status}`} title={label} aria-label={label} role="img" />;
}

/** Compteurs « en cours » et « attend ta réponse » ; rien si les deux sont à zéro. */
export function ActivityCounts({ running, waiting }: { running: number; waiting: number }) {
  if (!running && !waiting) return null;
  return (
    <span className="activity-counts">
      {running > 0 && (
        <span className="activity-count" title={`${running} conversation${running > 1 ? "s" : ""} en cours`}>
          <span className="activity-dot activity-running" />
          {running}
        </span>
      )}
      {waiting > 0 && (
        <span className="activity-count" title={`${waiting} conversation${waiting > 1 ? "s attendent" : " attend"} ta réponse`}>
          <span className="activity-dot activity-waiting" />
          {waiting}
        </span>
      )}
    </span>
  );
}
