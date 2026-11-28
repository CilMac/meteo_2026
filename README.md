# Météo personnelle

Application météo web, légère, pour iPhone et Mac. HTML, CSS et JavaScript natifs : pas de framework, pas de build, pas de compte, pas de serveur. Usage **personnel et non commercial**, sans publicité ni collecte de données.

Spécification : [cahier_des_charges_meteo_v1.1.md](cahier_des_charges_meteo_v1.1.md). Mesures de départ : [RAPPORT_LOT0.md](RAPPORT_LOT0.md). Bilan de vérification : [RAPPORT_LOT5.md](RAPPORT_LOT5.md).

## Lancer en local

Les modules JavaScript ne s'ouvrent pas depuis `file://`. Servir le dossier :

```bash
python3 -m http.server 8765
```

Puis ouvrir `http://localhost:8765/`.

## Tests

Node 18 ou plus récent, aucune dépendance à installer.

```bash
npm test
```

Les tests couvrent les règles métier avec des données synthétiques : sélection du modèle, frontière « tendance », null contre zéro, fuseaux et changements d'heure, classes de pluie, géocodage, vigilances.

Contrôle sur de vraies données (8 favoris, appels réseau) :

```bash
npm run live
```

## Déployer sur GitHub Pages

1. Pousser le dossier dans un dépôt GitHub (les fichiers à la racine du dépôt).
2. Dépôt → **Settings** → **Pages** → *Build and deployment* : source **Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. Attendre la publication ; le site est servi en HTTPS à l'adresse indiquée par GitHub.

Seuls `index.html`, `styles.css` et les fichiers `.js` de la racine sont nécessaires. `test-cors.html`, `tests/`, `package.json` et les rapports peuvent rester dans le dépôt sans gêner. Aucun secret ni clé API n'est utilisé.

## Vérifier que le site publié est à jour

Les fichiers du site doivent être publiés **tous ensemble** : une page qui mélange des fichiers de versions différentes (par exemple un `index.html` ancien avec un `app.js` récent) s'affiche mal ou signale une erreur. Après une publication, GitHub Pages peut mettre une à deux minutes à se mettre à jour, et le navigateur garde les fichiers en cache jusqu'à 10 minutes : rechargez avec Cmd+Maj+R.

Pour comparer le site publié aux fichiers de ce dossier (liste des fichiers absents ou différents) :

```bash
npm run check-deploy -- https://votre-nom.github.io/votre-depot/
```

Fichiers à publier : `index.html`, `styles.css` et tous les fichiers `.js` de la racine (`app.js`, `weather-provider.js`, `weather-render.js`, `places.js`, `warnings.js`, `info.js`, `device.js`, `loading.js`). Si la page ne se charge pas, un bandeau rouge l'indique en haut de l'écran.

## Structure

| Fichier | Rôle |
|---|---|
| `index.html`, `styles.css` | Structure et mise en page responsive ; charte « Carnet pastel » ([CHARTE_GRAPHIQUE_REUTILISABLE.md](CHARTE_GRAPHIQUE_REUTILISABLE.md)), avec un mode sombre décliné de ses couleurs, appliqué automatiquement selon le réglage du système |
| `app.js` | Orchestration : lieu, un appel par validation, onglets, états chargement/erreur/périmé |
| `weather-provider.js` | Appel Open-Meteo, normalisation, choix du modèle pour chaque valeur, frontière « tendance » |
| `weather-render.js` | Rendu des sections et gestion des valeurs manquantes |
| `places.js` | 8 favoris, géocodage, validation des lieux |
| `device.js`, `loading.js` | Vue par défaut selon l'appareil (compacte sur iOS) ; petite fenêtre « chargement en cours » avec barre d'avancement (étapes réellement terminées) |
| `info.js` | Fenêtre « i » (modale native `<dialog>` à deux onglets : fonctionnement, sous le capot) |
| `warnings.js` | Vigilances (ECCC pour le Canada ; « non confirmée » ailleurs) |
| `test-cors.html` | Page de test du lot 0 (CORS, horizons des modèles) |

## Sources et licences

- **Open-Meteo** (prévisions, géocodage) : gratuit pour un usage non commercial (moins de 10 000 appels par jour). Le lien « Weather data by Open-Meteo.com » est affiché avec les données. Un seul appel par lieu ; changer d'onglet n'en fait aucun.
- **Météo-France** (AROME/ARPEGE, via Open-Meteo) : « Source : Météo-France » n'est affiché que si des valeurs de ce modèle sont réellement montrées.
- **ECMWF, JMA, GEM** : modèles utilisés au-delà de la portée du modèle national, toujours étiquetés avec leur nom.
- **ECCC (Canada)** : alertes lues sur GeoMet-OGC-API, reproduites sans modification, avec l'attribution de la licence ECCC.

## Règles de fiabilité

- Chaque valeur est étiquetée avec le modèle qui l'a fournie ; aucune moyenne de modèles.
- La page s'arrête à 7 jours (J à J+6) depuis le 28/11/2026 : au-delà, une prévision jour par jour n'est plus fiable (mesuré : la quantité de pluie ne l'est déjà plus à 7 jours). Plus de scénarios d'ensemble.
- Une donnée absente s'affiche « — », jamais 0.
- Météo-France s'arrête à environ J+3 : au-delà, ECMWF prend le relais. Le séparateur « fiabilité en baisse » est calculé sur la réponse réelle, au plus tard à J+5.
- Les probabilités de pluie viennent souvent d'un autre modèle que les quantités : l'étiquette est donc par valeur.
- La section « Vigilances » n'affiche jamais « verte » par déduction.

## Limites connues

- **Vigilance France** : « non confirmée » + lien. L'API officielle exige un jeton ; une GitHub Action planifiée pourrait la publier (hors V1).
- **Vigilance Japon** : « non confirmée » + lien. Le fichier public JMA testé portait une date de publication ancienne.
- **Autres pays** : « non confirmée » + lien OMM. Un lieu libre n'a qu'ECMWF comme modèle, hors France, Japon et Canada.
- **Données sources incohérentes** : GEM donne parfois des rafales max inférieures au vent max (observé à Montréal). La page le signale sans corriger.
- Les modèles ne rendent pas compte des microclimats (littoral d'Agay notamment).
- La vue compacte condense la situation actuelle et les 24 heures et affiche les 7 jours dans un seul pavé, en deux blocs : J à J+3, puis J+4 à J+6 après « Dès J+4 : fiabilité en baisse. » ; c'est la vue par défaut (seule vue sur iOS) ; le choix de l'utilisateur est mémorisé (`device.js`).
- Pas de cache local : chaque validation ou « Actualiser » fait un appel.
- Les pictogrammes sont des emoji : leur aspect dépend du système.
