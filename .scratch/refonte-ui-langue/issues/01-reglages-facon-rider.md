# Réglages façon Rider

Status: resolved

## Ce qu'on veut

Réorganiser la fenêtre des Réglages (`src/components/Settings.tsx`), aujourd'hui une seule colonne avec trois rubriques à la suite, en onglets latéraux comme les réglages de Rider.

## Comportement attendu

- Fenêtre plus grande : liste d'onglets à gauche (Affichage, Suggestions, Hand off ; Langue sera ajouté par le ticket 06), contenu de l'onglet choisi à droite.
- La zone de contenu défile seule si elle dépasse la hauteur ; la liste d'onglets reste fixe.
- Enregistrement immédiat de chaque changement, comme aujourd'hui (pas de « Enregistrer / Annuler »), bouton « Fermer ».
- Le dernier onglet consulté est mémorisé (préférence locale) et rouvert à l'ouverture suivante.
- Prévoir l'ajout facile d'un onglet (liste déclarative id → libellé → composant).
- Pas de champ de recherche.

## Vérifications

- Chaque réglage existant marche toujours (projets temporaires, règles de suggestion et seuil, consigne de hand off avec « Rétablir »).
- Affichage correct sur une petite fenêtre (défilement) et en thème clair et sombre.

## Comments

Fait : `SettingsDialog` en onglets (`SETTINGS_TABS`, liste déclarative id → libellé, contenu par onglet dans `panels`). Fenêtre `.settings-modal` (760 × 560 max), liste à gauche fixe, contenu `.settings-panel` qui défile ; sous 560 px les onglets passent en ligne au-dessus. Dernier onglet mémorisé dans `localStorage` (`claudeManager.settingsTab`, lecture et écriture protégées). `Modal` accepte une `className`.
