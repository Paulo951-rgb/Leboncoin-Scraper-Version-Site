# Fixtures de test (HAR + HTML)

Ces fichiers sont **entièrement synthétiques** : ils reproduisent la *forme* des
réponses Leboncoin (structure `__NEXT_DATA__`, API JSON, pages de détail) sans
contenir aucune donnée réelle (pas de nom, e-mail, téléphone ni annonce
authentique). Ils servent à tester le pipeline **hors-ligne**, sans réseau ni
Chromium.

| Fichier | Rôle | Testé par |
|---|---|---|
| `search-results.har` | Résultats de recherche : 3 annonces + entrées non-JSON (css/image) à ignorer | `[36]`, `[35]` |
| `search-blocked-403.har` | Recherche bloquée (HTTP 403) → aucune annonce exploitable | `[36]` |
| `search-empty.har` | Recherche HTTP 200 mais sans annonce (soft-block) | `[36]` |
| `search-duplicates.har` | Même annonce dans 2 réponses JSON → doit être dédupliquée | `[36]` |
| `detail-page.html` | Page de détail (enrichissement) avec `__NEXT_DATA__` (description, état, transaction) | `[36]` |
| `detail-page-no-nextdata.html` | Page de détail sans `__NEXT_DATA__` → enrichissement vide sans crash | `[36]` |

## Format

Un `.har` valide contient `log.entries[]`. Chaque entrée a `request.url` et
`response.status` + `response.content.{mimeType,text}`. Le pipeline ignore les
entrées dont le `status >= 400` et celles dont le mime n'est pas JSON (sauf
`__NEXT_DATA__` extrait d'un corps HTML).

Les valeurs numériques/ID sont volontairement fictives (`111`, `222`, `333`).
