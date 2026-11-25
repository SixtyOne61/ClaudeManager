// Textes : app (voir src/i18n/index.ts pour le format).

export default {
  "app.session.fallbackTitle": "Session {id}",
  // Écran principal
  "app.loading": "Lecture des conversations…",
  "app.selectProject": "Sélectionnez un projet.",
  "app.newConversationTitle": "Nouvelle conversation",
  "app.worktreeAutoName": "(nom automatique)",
  "app.conversationNotFound": "conversation introuvable",
  "app.conversationNotFoundTitle": "Conversation introuvable",
  "app.conversationMissing": "Cette conversation est introuvable (mise à la Corbeille ?).",
  "app.moveToTrash": "Mettre à la Corbeille",
  "app.andMore": "… et {count} autre(s)",

  // Fermeture de l'app
  "app.quit.busy":
    "{count, plural, one {Une conversation a un agent au travail ou une action en attente.} other {# conversations ont un agent au travail ou une action en attente.}}\nQuitter les interrompra (les conversations restent enregistrées).",
  "app.quit.title": "Quitter Claude Manager",
  "app.quit.ok": "Quitter",

  // Catégories
  "app.category.deleteConfirm": "Supprimer la catégorie « {name} » ?\nSes {count} projet(s) reviendront dans « Non classés ».",
  "app.category.deleteTitle": "Supprimer la catégorie",
  "app.category.new": "Nouvelle catégorie",
  "app.category.rename": "Renommer la catégorie",

  // Projets
  "app.project.renameTitle": "Nom d'affichage du projet",
  "app.project.renameLabel": "Nom (laisser vide pour revenir au nom du dossier)",
  "app.project.closeTabsFirst": "Fermez d'abord les onglets ouverts du projet « {name} ».",
  "app.project.archiveConfirm":
    "Archiver le projet « {name} » ?\n\n{count, plural, =0 {} one {Ses # conversation sera archivée avec lui. } other {Ses # conversations seront archivées avec lui. }}Le projet disparaît de la barre latérale et se restaure depuis les Archives, avec sa catégorie, sa couleur et ses sections.\nLe dossier du projet n'est pas touché.",
  "app.project.archiveTitle": "Archiver le projet",
  "app.project.notArchived":
    "Le projet « {name} » n'a pas été archivé : {count, plural, one {# conversation est restée} other {# conversations sont restées}} en place. Celles déjà archivées se restaurent depuis les Archives.",
  "app.project.archived": "Projet « {name} » archivé",
  "app.project.restored": "Projet « {name} » restauré{count, plural, =0 {} one { (# conversation)} other { (# conversations)}}",
  "app.restore.errors": "{count, plural, one {# conversation est restée} other {# conversations sont restées}} dans les archives :\n{list}",

  // Terminal intégré et conversations
  "app.launch.resume": "Reprise de la conversation dans un terminal…",
  "app.launch.new": "Nouvelle conversation dans un terminal…",
  "app.maybeActive.title": "Conversation peut-être en cours",
  "app.maybeActive.continue": "Continuer",
  "app.maybeActive.confirm": "{message}\n\nContinuer quand même ?",
  "app.openElsewhere.confirm":
    "{message}\nDeux programmes qui écrivent en même temps dans la même conversation peuvent l'abîmer.\n\nContinuer quand même ?",
  "app.closeConversation.confirm": "{warning}\n\nFermer « {title} » quand même ?",
  "app.closeConversation.title": "Fermer la conversation",
  "app.conversation.archived": "« {title} » archivée",
  "app.conversation.restored": "« {title} » restaurée",
  "app.conversation.trashConfirm": "Mettre la conversation « {title} » à la Corbeille ?\nElle pourra être récupérée depuis la Corbeille.",
  "app.conversation.trashTitle": "Supprimer la conversation",
  "app.conversation.trashed": "Conversation envoyée à la Corbeille",
  "app.archive.trashConfirm": "Mettre la conversation archivée « {title} » à la Corbeille ?",
  "app.archive.trashTitle": "Supprimer l'archive",
  "app.archive.trashed": "Archive envoyée à la Corbeille",

  // Hand off
  "app.handoff.cancelled": "Hand off annulé : rien n'a été créé ni archivé.",
  "app.handoff.successorTitle": "Suite de {title}",
  "app.handoff.notStarted":
    "Hand off interrompu : la nouvelle conversation n'a pas démarré. La conversation d'origine n'est pas archivée ; son résumé de passation y reste visible.",
  "app.handoff.archiveFailed": "La suite a pris le relais, mais « {title} » n'a pas pu être archivée : {error}",
  "app.handoff.done": "Hand off : « {title} » est archivée, sa suite a pris le relais.",

  // Actions sur plusieurs conversations
  "app.bulk.trashConfirm":
    "Mettre {count, plural, one {# conversation} other {# conversations}} à la Corbeille ?\n{count, plural, one {Elle pourra être récupérée} other {Elles pourront être récupérées}} depuis la Corbeille.\n\n{titles}",
  "app.bulk.archiveConfirm":
    "Archiver {count, plural, one {# conversation} other {# conversations}} ?\n{count, plural, one {Elle pourra être restaurée} other {Elles pourront être restaurées}} depuis les Archives.\n\n{titles}",
  "app.bulk.trashTitle": "Supprimer les conversations",
  "app.bulk.archiveTitle": "Archiver les conversations",
  "app.bulk.failedItem": "« {title} » : {message}",
  "app.bulk.activeConfirm":
    "{count, plural, one {# conversation a été modifiée} other {# conversations ont été modifiées}} il y a moins de 2 minutes : peut-être {count, plural, one {ouverte} other {ouvertes}} dans Claude Desktop ou dans un autre terminal.\n\n{titles}",
  "app.bulk.activeTitle": "Conversations peut-être en cours",
  "app.bulk.trashToo": "Les mettre aussi à la Corbeille",
  "app.bulk.archiveToo": "Les archiver aussi",
  "app.bulk.ignore": "Les ignorer",
  "app.bulk.trashed":
    "{count, plural, one {# conversation envoyée à la Corbeille} other {# conversations envoyées à la Corbeille}}{skipped, plural, =0 {} one { (# ignorée)} other { (# ignorées)}}",
  "app.bulk.archived":
    "{count, plural, one {# conversation archivée} other {# conversations archivées}}{skipped, plural, =0 {} one { (# ignorée)} other { (# ignorées)}}",
  "app.bulk.noneTrashed": "Aucune conversation supprimée ({skipped, plural, one {# ignorée} other {# ignorées}})",
  "app.bulk.noneArchived": "Aucune conversation archivée ({skipped, plural, one {# ignorée} other {# ignorées}})",
  "app.bulk.failed": "Échec pour {count, plural, one {# conversation} other {# conversations}} :\n{list}",

  // Hubs
  "app.hub.created": "Hub « {name} » créé",
  "app.hub.createdHint": "Hub « {name} » créé : ajoutez-y des conversations (glisser-déposer, ou « Ajouter à un hub… »)",
  "app.hub.closeTabsFirst": "Fermez d'abord les onglets ouverts des conversations du hub « {name} ».",
  "app.hub.archiveConfirm":
    "Archiver le hub « {name} » ?\n\n{count, plural, =0 {} one {Ses # conversation sera archivée avec lui. } other {Ses # conversations seront archivées avec lui. }}Le hub disparaît de la barre latérale et se restaure depuis les Archives, avec ses conversations.",
  "app.hub.archiveTitle": "Archiver le hub",
  "app.hub.notArchived":
    "Le hub « {name} » n'a pas été archivé : {count, plural, one {# conversation est restée} other {# conversations sont restées}} en place. Celles déjà archivées se restaurent depuis les Archives.",
  "app.hub.archived": "Hub « {name} » archivé",
  "app.hub.restored": "Hub « {name} » restauré{count, plural, =0 {} one { (# conversation)} other { (# conversations)}}",
  "app.hub.deleteConfirm": "Supprimer le hub « {name} » ?\nSes conversations restent dans leur projet, seul le regroupement disparaît.",
  "app.hub.deleteTitle": "Supprimer le hub",
  "app.hub.joined": "« {title} » a rejoint le hub « {hub} »",
  "app.hub.theConversation": "La conversation",
  "app.hub.executorNotStarted": "L'exécutant n'a pas démarré : sa tâche n'a pas été envoyée.",
  "app.hub.new": "Nouveau hub",
  "app.hub.rename": "Renommer le hub",
  "app.hub.createTitle": "Créer un hub",
  "app.hub.createFromExchangeLabel": "Nom du hub — « {from} » coordinateur, « {to} » exécutant",

  // Boîtes de dialogue
  "app.dialog.submit": "Valider",
  "app.dialog.start": "Démarrer",
  "app.worktree.newTitle": "Nouvelle conversation dans un nouveau worktree",
  "app.worktree.nameLabel": "Nom du worktree (facultatif)",
  "app.worktree.namePlaceholder": "ex. correction-connexion",
  "app.worktree.nameHint":
    "Copie de travail séparée dans .claude\\worktrees\\<nom>, sur la branche worktree-<nom>. Sans nom, Claude Code en choisit un.",
  "app.worktree.offerTitle": "Démarrer dans un worktree ?",
  "app.worktree.offerText":
    "{count, plural, =2 {Deux} other {#}} conversations tournent déjà dans ce dossier. Démarrer celle-ci dans un worktree pour éviter qu'elles se marchent dessus ?",
  "app.worktree.dontAskAgain": "Ne plus demander pour ce projet",
  "app.worktree.hereAnyway": "Ici quand même",
  "app.worktree.inWorktree": "Dans un worktree",
  "app.newProject.title": "Nouveau projet",
  "app.newProject.pickTitle": "Choisir ou créer le dossier du projet",
  "app.newProject.folder": "Dossier",
  "app.newProject.noFolder": "Aucun dossier choisi",
  "app.newProject.browse": "Parcourir…",
  "app.newProject.folderHint": "Pour créer un dossier, utilisez « Nouveau dossier » dans la fenêtre de sélection.",
  "app.newProject.category": "Catégorie",
  "app.newProject.uncategorized": "Non classés",
  "app.newProject.displayName": "Nom d'affichage (facultatif)",
  "app.newProject.displayNamePlaceholder": "Nom du dossier par défaut",
  "app.newProject.language": "Langue des réponses de Claude",
  "app.newProject.languageDefault": "Par défaut (réglage habituel)",
  "app.newProject.languageHint": "Enregistrée dans .claude\\settings.local.json du projet.",
  "app.newProject.startConversation": "Lancer une nouvelle conversation dans ce dossier",

  // Sélecteur de couleur
  "app.color.custom": "Couleur libre",
  "app.color.none": "Aucune",

  // État des conversations
  "app.activity.runningCount": "{count, plural, one {# conversation en cours} other {# conversations en cours}}",
  "app.activity.actionCount": "{count, plural, one {# conversation avec une action requise} other {# conversations avec une action requise}}",
  "app.activity.warnRunning": "L'agent est en train de travailler : fermer l'arrêtera en cours de route.",
  "app.activity.warnPermission": "Une action attend ta permission : fermer l'annulera.",
  "app.activity.closed": "Fermée",
  "app.activity.running": "En cours",
  "app.activity.yours": "À toi : Claude attend ton prochain message",
  "app.activity.permission": "Action requise : permission demandée",
  "app.activity.question": "Action requise : question posée",
  "app.activity.error": "Action requise : erreur, relance ton message",
  "app.activity.errorDetail": "Action requise : erreur ({detail}), relance ton message",

  // Mises à jour
  "app.update.title": "Mises à jour",
  "app.update.upToDate": "Vous utilisez la dernière version.",
  "app.update.upToDateVersion": "Vous utilisez la dernière version ({version}).",
  "app.update.available":
    "La version {version} est disponible (actuelle : {current}).{notes}\n\nTélécharger et installer maintenant ? L'application se fermera pendant l'installation.",
  "app.update.availableTitle": "Mise à jour disponible",
  "app.update.install": "Installer",
  "app.update.later": "Plus tard",
  "app.update.failed": "Impossible de vérifier ou d'installer la mise à jour :\n{message}",
  "app.update.checking": "Vérification…",
  "app.update.downloading": "Téléchargement…",
  "app.update.downloadingPercent": "Téléchargement {percent} %",
  "app.update.check": "Vérifier les mises à jour",
  "app.update.checkTooltip": "Interroge GitHub pour savoir si une nouvelle version existe",

  // Limites d'utilisation
  "app.limits.tooltip":
    "Limites d'utilisation de ton forfait Claude (Pro, Max), telles que Claude Code les reçoit.\nLes chiffres ne se mettent à jour que pendant qu'une conversation tourne dans l'app.",
  "app.limits.minutesAgo": "il y a {count} min",
  "app.limits.hoursAgo": "il y a {count} h",
  "app.limits.daysAgo": "il y a {count} j",
  "app.limits.label": "{label} :",
  "app.limits.percent": "{pct} %",
  "app.limits.reset": "remis à zéro",
  "app.limits.compareTooltip": "Comparer avec la consommation théorique (linéaire sur la semaine)",
  "app.limits.over": "Théorique : {pct} % · surconsommation de {diff} pts",
  "app.limits.under": "Théorique : {pct} % · {diff} pts de marge",
  "app.limits.even": "Théorique : {pct} % · pile dans le rythme",
  "app.limits.fiveHours": "5 h",
  "app.limits.week": "Semaine",
  "app.limits.updated": "mis à jour {age}",
  "app.limits.empty": "Lance une conversation pour voir tes limites",

  // Archives
  "app.archives.title": "Archives",
  "app.archives.intro": "Les conversations archivées sont rangées dans {path} et n'apparaissent plus dans Claude Code.",
  "app.archives.projects": "Projets archivés",
  "app.archives.hubs": "Hubs archivés",
  "app.archives.conversations": "Conversations archivées",
  "app.archives.empty": "Aucune conversation archivée.",
  "app.archives.archivedOnMasc": "archivé le {date}",
  "app.archives.archivedOnFem": "archivée le {date}",
  "app.archives.lastActivity": "dernière activité {date}",
  "app.archives.conversationCount": "{count, plural, =0 {aucune conversation} one {# conversation} other {# conversations}}",
  "app.archives.messageCount": "{count, plural, other {# messages}}",
  "app.archives.restoreProject": "Restaurer le projet",
  "app.archives.restoreProjectTooltip": "Remet le projet dans la barre latérale, avec les conversations archivées avec lui",
  "app.archives.restoreHub": "Restaurer le hub",
  "app.archives.restoreHubTooltip": "Remet le hub dans la barre latérale, avec les conversations archivées avec lui",
  "app.archives.parentTooltip": "Ouvrir la conversation d'origine de ce hand off",
  "app.archives.parent": "Suite de {title}",
  "app.archives.successorTooltip": "Ouvrir la conversation qui a pris le relais",
  "app.archives.successor": "Suite : {title}",

  // Recherche globale
  "app.search.title": "Rechercher partout",
  "app.search.intro": "Dans les messages et les réponses de toutes les conversations, archives comprises. Casse et accents ignorés.",
  "app.search.placeholder": "Un mot, une phrase…",
  "app.search.searching": "Recherche…",
  "app.search.noResult": "Aucune conversation ne contient ce texte.",
  "app.search.summary":
    "{count, plural, one {# conversation} other {# conversations}} dans {projects, plural, one {# projet} other {# projets}}",
  "app.search.truncated": "(liste limitée aux plus récentes)",
  "app.search.elapsed": "{ms} ms",
  "app.search.tooShort": "Tapez au moins {count} caractères.",
  "app.search.open": "Ouvrir la conversation",
  "app.search.archived": "archivée",
  "app.search.matchCount": "{count, plural, one {# message} other {# messages}}",
  "app.search.you": "Vous",
  "app.search.more": "et {count, plural, one {# autre message} other {# autres messages}}",
} as const satisfies Record<string, string>;
