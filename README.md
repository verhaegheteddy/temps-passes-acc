# Temps passés

Application de bureau (Electron) qui remplace les deux workflows n8n « [TEMPS PASSES] » :
elle synchronise les bases Notion dans un cache SQLite local et génère les rapports XLSX.
Elle permet aussi de **clôturer** des mois ou des années : les lignes clôturées sont figées et les
rapports publiés sur ces périodes ne changent plus.

## Démarrer

```sh
npm install
npm start            # lance l'application
npm test             # tests du moteur (faux serveur Notion)
npm run smoke        # parcours complet de l'interface + captures d'écran
npm run dist:win     # installeur Windows (NSIS + portable)
npm run dist:linux   # paquet flatpak (nécessite flatpak-builder et les runtimes, voir plus bas)
```

Au premier lancement, onglet **Paramètres** :
1. Créer une intégration interne Notion (capacités « Lire le contenu » et « Lire les informations
   des utilisateurs, y compris l'e-mail »), puis partager les 5 bases avec elle (⋯ › Connexions).
2. Coller le token, puis cliquer sur « Enregistrer le token » : l'app lit les bases et associe
   automatiquement les propriétés (à partir des noms utilisés par n8n). Vérifier, puis cliquer sur « Enregistrer ».
3. Le premier import démarre. S'il est interrompu, il reprend là où il s'était arrêté.

Le token est chiffré via le trousseau du système (`safeStorage`). Les données sont stockées dans le
dossier utilisateur de l'app (bouton « Ouvrir le dossier »).

## Fonctionnement

| Élément | Comportement |
|---|---|
| Synchro (au démarrage et via le bouton) | Pages modifiées depuis le dernier passage (`last_edited_time`, référence = heure du serveur Notion). Enregistrée par lots de 100, donc reprenable. |
| Synchro complète | Relit toutes les bases, sauf les temps passés des périodes clôturées, et supprime du cache ce qui a disparu de Notion. Une réponse vide ne vide jamais le cache. |
| API Notion | Version `2025-09-03` (data sources), ~3 req/s, reprise automatique sur 429 / 5xx / coupure réseau. |
| Rapport | Hiérarchie Sujet › Sous-sujet › Tâche, détail par personne (optionnel). Tags = tags de la tâche + tags du sous-sujet. Filtre en **OU** entre tous les tags cochés. |
| Clôture | Fige chaque ligne jusqu'à la date choisie (temps, personne, tâche, sous-sujet, sujet, tags). Une synchro complète est lancée juste avant. Seuls des mois terminés peuvent être clôturés. |
| Après clôture | Une modification, création ou déplacement dans Notion sur une date clôturée est **ignoré** et listé dans « Synchronisation › Modifications Notion sur des périodes clôturées ». |
| Stats | Couverture saisi / attendu par personne et par semaine, personnes sans saisie ou inactives, anomalies (sans tâche, tâche sans sous-sujet/sujet, sans personne, temps vide, saisies groupées, week-ends, identifiants sans e-mail) avec le détail des lignes et un lien vers Notion. |
| Étiquettes | Dans Stats : temps par étiquette des temps passés (Développement, Absent…) au global et par personne (en temps ou en % du temps de chaque personne), avec le détail des lignes au clic. Tuile « Absences » si une étiquette « Absent » existe. |
| Personnes | Rattache un identifiant Notion (UUID d'un ancien membre, bot, ancienne adresse) à un e-mail saisi à la main. Appliqué aux rapports et aux stats ; les rapports des périodes clôturées gardent l'identité figée à la clôture. |
| Temps attendu | Unité du « Temps passé » Notion : **jours** par défaut (1 par jour ouvré) ou heures. Jours ouvrés = lun-ven hors fériés français, lundi de Pentecôte travaillé par défaut. Réglable par personne (temps partiel, arrivée, départ, suivi). |
| Réouverture | Possible (double confirmation), suivie automatiquement d'une synchro complète. Tracée dans l'historique. |

## Différences avec les workflows n8n

- Plus de fenêtre « modifié le mois dernier » : rien n'est perdu si l'app n'est pas lancée pendant longtemps.
- Les suppressions dans Notion sont prises en compte (synchro complète).
- La hiérarchie est résolue au moment du rapport (et figée à la clôture) : un changement de
  sous-sujet d'une tâche se répercute correctement sur les périodes ouvertes.
- Les colonnes de tags sont remplies même sans filtre. Les en-têtes du XLSX sont en français,
  et un onglet « Paramètres » rappelle les filtres et l'état de clôture.
- La base « Offres Accenta » (supprimée de Notion) n'est plus utilisée.
- Comme avant, seule la première personne d'un temps passé est comptée, et le sujet vient de la tâche (`Sujet FT`).

## Build et releases (GitHub Actions)

`.github/workflows/build.yml` :

| Déclencheur | Ce qui se passe |
|---|---|
| push sur `main`, pull request | tests, puis paquets **Linux (flatpak)** et **Windows (installeur + portable)** téléchargeables dans les artefacts du run |
| tag `vX.Y.Z` | idem + **release GitHub** avec les paquets (le tag doit correspondre à `version` dans `package.json`) |

Publier une version :

```sh
npm version 1.1.0        # met à jour package.json et crée le commit + le tag v1.1.0
git push --follow-tags
```

Installer le flatpak : `flatpak install --user temps-passes-1.1.0-linux-x86_64.flatpak` (le runtime
`org.freedesktop.Platform` 26.08 et `org.electronjs.Electron2.BaseApp` sont installés depuis Flathub au besoin).
Les données de la version flatpak sont dans `~/.var/app/fr.accenta.temps-passes/config/`.

Les exécutables Windows ne sont pas signés : SmartScreen affichera un avertissement au premier lancement
(« Informations complémentaires » › « Exécuter quand même »).

## Structure

```
src/core/      moteur sans dépendance à Electron (testé avec node --test)
  mapping.js   correspondance champs <-> propriétés Notion, extraction des valeurs
  notion.js    client HTTP (débit, reprises, pagination)
  store.js     cache SQLite (node:sqlite), clôtures, conflits
  sync.js      synchronisation incrémentale / complète
  report.js    agrégation et export XLSX (exceljs)
  stats.js     statistiques de diagnostic (couverture, anomalies)
  calendar.js  jours ouvrés et jours fériés français
src/main/      processus principal Electron (IPC, paramètres, token)
src/renderer/  interface (HTML/CSS/JS sans framework)
build/         icône de l'application
test/          faux serveur Notion, tests du moteur, test de l'interface
```
