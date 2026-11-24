# Couleurs de l'encart des limites

Status: resolved

## Ce qu'on veut

Dans l'encart des limites d'utilisation (en bas à gauche, `UsageLimits.tsx`), chaque barre prend une couleur selon son taux.

## Comportement attendu

- Vert en dessous de 70 %, orange de 70 à 90 %, rouge à partir de 90 %.
- S'applique à chaque barre indépendamment (5 h, 7 jours, plafond de dépense s'il existe).
- Seuils fixes, pas de réglage. Couleurs lisibles en thème clair et sombre.

## Comments

- `level()` de `UsageLimits.tsx` renvoie `ok` / `high` / `critical` aux seuils 70 et 90 % ; la barre `ok` prend la couleur verte des pastilles *en cours*. Le plafond de dépense n'est pas affiché par l'encart aujourd'hui (seules les fenêtres 5 h et semaine le sont), donc rien à colorer de plus.
