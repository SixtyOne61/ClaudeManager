# Avertissement « peut-être ouverte ailleurs » à la reprise

Status: ready-for-agent
Blocked by: 01

## Ce qu'on veut

Quand on ouvre une conversation dans le terminal intégré alors que son fichier a été modifié il y a moins de 2 minutes, et qu'elle n'est pas déjà ouverte dans l'app, l'app prévient qu'elle est peut-être ouverte dans Desktop ou dans un autre terminal. Deux programmes qui écrivent en même temps dans la même conversation peuvent l'abîmer.

## Comportement attendu

- Même seuil et même ton que la confirmation qui existe déjà pour l'archivage et la corbeille.
- On peut continuer quand même : on prévient sans bloquer.
- Une conversation déjà ouverte dans l'app ne déclenche pas l'avertissement : on bascule simplement sur son onglet.
