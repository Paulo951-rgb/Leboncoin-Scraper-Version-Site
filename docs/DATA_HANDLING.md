# Gestion des données — Transparence et minimisation

Ce document détaille les catégories de données traitées par **Leboncoin Scraper Pro**, leur finalité, leur persistance et les options de contrôle dont dispose l'utilisateur.

## Principes

1. **Collecte minimale** : le logiciel ne collecte que les données présentes dans les réponses réseau du site ciblé. Aucune donnée n'est inventée ou extrapolée lors du scraping.
2. **100% local** : les données restent sur l'ordinateur de l'utilisateur. Aucune transmission vers le cloud, aucune API externe, aucun envoi vers un service tiers. Les seules connexions réseau sortantes sont vers le site ciblé (scraping), l'API de géocodage du gouvernement français (carte, optionnelle) et des CDN publics servant à charger les bibliothèques d'interface (Chart.js, Leaflet) et les tuiles de carte OpenStreetMap. Aucune de ces connexions ne transmet les données scrapées.
3. **Transparence** : chaque catégorie de données est documentée ci-dessous avec sa finalité et sa traçabilité.
4. **Contrôle utilisateur** : l'utilisateur peut configurer quelles données sont conservées, exportées et affichées.

## Tableau des catégories de données

| Catégorie | Utilisation | Exportable | Désactivable | Stockage |
|-----------|-------------|------------|--------------|----------|
| Informations annonce (titre, prix, URL, localisation, dates, photos, description) | Analyse, export, statistiques | Oui (JSON, TXT) | Oui (profil Personnalisé) | Disque local (`output/jobs/`) |
| Prix | Statistiques, filtres | Oui | Oui (profil Personnalisé) | Disque local |
| Description | Export TXT | Oui | Oui (case « Ignorer les descriptions » + profil Personnalisé) | Disque local |
| Données vendeur (nom, ID, type, note, avis, URL profil, ancienneté) | Identification, filtres, statistiques, export | Oui | Oui (paramètre « Données vendeur » dans les réglages) | Disque local |
| Données brutes HAR (capture réseau complète) | Diagnostic, reprise de scraping, intégrité | Non (fichier technique `.har`) | Oui (nettoyage automatique paramétrable) | Disque local, nettoyé après X jours |
| Favoris et filtres utilisateur | Interface, rappel entre sessions | Non | Oui (effacement localStorage) | localStorage (navigateur intégré) |

## Champ `deliveryType` (unifié)

Le logiciel utilise un champ unique `deliveryType` pour décrire le mode de remise d'une annonce. Il remplace les anciens champs séparés `livraison` et `mainPropre` par une seule valeur canonique :

| Valeur | Signification |
|---|---|
| `les_deux` | Livraison **et** remise en main propre |
| `livraison` | Livraison uniquement |
| `main_propre` | Remise en main propre uniquement |
| `aucun` | Ni livraison ni main propre |
| `inconnu` | Indéterminé (données indisponibles) |

Ce champ est extrait défensivement à partir des attributs structurés de l'annonce (`has_option.shipping`, attributs `shippable`) et de l'analyse de la description (détection des mentions « remise en main propre », « retrait sur place », « pas d'envoi », etc.).

## Profils de données

L'utilisateur choisit parmi **3 profils** au moment du scraping, dans l'onglet Scraper :

### Profil Défaut
Récupération des champs essentiels pour un scraping rapide et léger (13 champs) :
- `id`, `title`, `url`, `prix`, `ville`, `codePostal`, `deliveryType`, `datePublication`, `dateScraping`, `vendeurNom`, `vendeurType`, `photosCount`, `description`.

### Profil Maximum
Récupération de toutes les données disponibles techniquement (~23 champs). Ce profil garantit une sauvegarde complète et intacte de chaque session.

### Profil Personnalisé
L'utilisateur sélectionne uniquement les champs qu'il souhaite conserver, organisés par catégorie :
- **Identification** : id, title, url
- **Prix** : prix
- **Localisation** : ville, codePostal
- **Vendeur** : vendeurNom, vendeurType, vendeurId, vendeurNote, vendeurNbAvis, vendeurUrlProfil, vendeurAnciennete
- **Transaction** : deliveryType
- **Dates** : datePublication, dateModification, dateScraping
- **Statistiques** : likes
- **Produit** : etat
- **Photos** : photosCount, photosUrls
- **Description** : description

Les champs non sélectionnés n'apparaissent dans aucun export (JSON, TXT). La sélection est sauvegardée pour les sessions suivantes.

## Données vendeur

Un paramètre dédié permet d'exclure systématiquement les champs identifiés comme données vendeur de tous les exports, quelle que soit le profil choisi. Cela concerne :
- Nom du vendeur
- ID du vendeur
- Type du vendeur
- Note du vendeur
- Nombre d'avis
- URL du profil vendeur
- Ancienneté du vendeur

Dans l'interface, les informations vendeur sont également masquées lorsque cette option est activée.

## Descriptions

L'utilisateur peut choisir d'ignorer les descriptions lors du scraping (case « Ignorer les descriptions » dans le formulaire de recherche). Cela accélère le traitement et réduit la quantité de texte conservé.

## Formats d'export

Deux formats d'export sont disponibles :

| Format | Contenu | Usage |
|---|---|---|
| **JSON** (`annonces.json`) | Données structurées + checksum SHA-256 | Reprise programmatique, intégration |
| **TXT** (`annonces.txt`) | Texte lisible (blocs alignés par annonce) | Lecture humaine, partage |

> **Note** : Les formats XLSX et CSV ne sont plus disponibles. Seuls JSON et TXT sont générés.

## Persistance et durée de vie

| Support | Données | Durée de vie |
|---------|---------|--------------|
| `output/jobs/job-<timestamp>/` | Annonces, exports, métadonnées | Jusqu'à suppression manuelle ou automatique (paramétrable) |
| `output/jobs/job-<timestamp>/capture.har` | Capture réseau brute | Nettoyage automatique paramétrable (défaut : 7 jours) |
| `user-settings.json` | Paramètres utilisateur | Persistante |
| `localStorage` | Favoris, filtres, préférences UI | Persistante (navigateur intégré) |

## Suppression des données

L'utilisateur peut supprimer individuellement chaque job depuis l'onglet Historique. La suppression entraîne l'effacement complet du dossier correspondant (annonces, exports, HAR, métadonnées).

Le nettoyage automatique des jobs anciens et des fichiers HAR peut être activé dans les paramètres.

## Aucune transmission externe

Les données restent **100% locales** :
- Les exports sont générés et stockés sur le disque de l'utilisateur.
- Aucune télémétrie, aucun tracking et aucun compte-rendu automatique n'est envoyé au développeur.
- Aucun traitement par IA, aucun envoi vers un service cloud, aucune clé API requise.

Les seules connexions réseau externes sont :
- vers le site ciblé pour la collecte ;
- vers l'API de géocodage du gouvernement français (geo.api.gouv.fr) pour
  positionner les villes sur la carte (si la carte est utilisée) ;
- vers les tuiles de fond de carte OpenStreetMap (`*.tile.openstreetmap.org`)
  lorsque la carte est affichée.

Les bibliothèques d'interface (Chart.js pour les graphiques, Leaflet pour la
carte) sont **embarquées localement** dans `src/renderer/vendor/` et non plus
chargées depuis un CDN public. L'interface (graphiques, tableaux, onglets)
fonctionne donc même sans accès à un CDN ; seule la carte a besoin d'une
connexion pour ses tuiles OpenStreetMap.

Aucune de ces connexions ne transmet vos données scrapées. Si l'appareil est
hors ligne, l'application reste utilisable pour consulter les jobs déjà
scrapés ; seuls la carte et les graphiques peuvent ne pas s'afficher.

## Informations sensibles

Si vous collectez des données sensibles ou personnelles, appliquez les principes suivants :
- Ne conservez que ce qui est strictement nécessaire.
- Utilisez le profil Personnalisé pour limiter les champs récupérés.
- Désactivez les données vendeur si elles ne sont pas utiles à votre analyse.
- Supprimez les jobs dès qu'ils ne sont plus nécessaires.
- Utilisez le chiffrement de disque si votre système l'autorise.
- Consultez un professionnel juridique si vous avez un doute sur la légalité de votre traitement.
