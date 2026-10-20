# Pocket Player

Lecteur MP3 / MP4 personnel pour iPhone, qui fonctionne hors ligne. Il s'installe sur l'écran d'accueil depuis Safari, sans Mac, sans compte Apple Developer et sans serveur payant.

Le site (hébergé gratuitement sur GitHub Pages) ne contient **que le code** de l'application. Vos musiques et vidéos restent **sur votre iPhone** : elles ne sont jamais envoyées sur Internet.

---

## Sommaire

1. [Comment ça marche](#1-comment-ça-marche)
2. [Ce que l'application sait faire](#2-ce-que-lapplication-sait-faire)
3. [Contenu du projet](#3-contenu-du-projet)
4. [Guide de déploiement pas à pas](#4-guide-de-déploiement-pas-à-pas)
5. [Installer sur l'iPhone](#5-installer-sur-liphone)
6. [Vérifier le mode hors ligne](#6-vérifier-le-mode-hors-ligne)
7. [Publier une mise à jour](#7-publier-une-mise-à-jour)
8. [Checklist de tests](#8-checklist-de-tests)
9. [Limites connues](#9-limites-connues)
10. [Ce qui a été testé, et ce qui reste à vérifier](#10-ce-qui-a-été-testé-et-ce-qui-reste-à-vérifier)
11. [Dépannage](#11-dépannage)

---

## 1. Comment ça marche

Pocket Player est une **PWA** (Progressive Web App) : un site web que l'iPhone peut installer comme une application.

| Élément | Rôle |
|---|---|
| **GitHub Pages** | Héberge gratuitement le code (HTML, CSS, JavaScript, icônes) en HTTPS. |
| **Service worker** (`service-worker.js`) | Garde une copie du code sur l'iPhone pour que l'app s'ouvre sans Internet. |
| **IndexedDB** | Base de données du navigateur, sur l'iPhone. Elle stocke vos fichiers audio et vidéo (sous forme de « Blob »), ainsi que les titres, favoris, playlists et positions de lecture. |
| **Lecteurs HTML5** | Les éléments `<audio>` et `<video>` de Safari lisent les fichiers. Ce sont donc les formats que Safari sait lire qui comptent. |
| **Media Session** | Transmet titre, artiste et pochette à iOS (écran verrouillé, Centre de contrôle) et reçoit les commandes lecture, pause, précédent, suivant. |

```
 iPhone
 ┌──────────────────────────────────────────────────┐
 │  Pocket Player (Safari / écran d'accueil)          │
 │   ├─ code de l'app ◄── cache du service worker ◄─┼── GitHub Pages (une seule fois,
 │   └─ vos médias   ◄── IndexedDB (local)           │    puis à chaque mise à jour)
 │            ▲                                       │
 │            └── importés depuis l'app Fichiers      │
 └──────────────────────────────────────────────────┘
```

Les médias ne passent jamais par le service worker ni par GitHub : ils sont lus via des adresses `blob:` qui n'existent que sur l'iPhone.

### Les limites d'une PWA sur iPhone, en bref

- **Lecture en arrière-plan non garantie.** Quand l'écran est verrouillé ou que vous changez d'application, iOS peut mettre la musique en pause, surtout pour une app installée sur l'écran d'accueil. Le comportement dépend de la version d'iOS. Voir la [section 9](#9-limites-connues).
- **Stockage limité et non garanti.** iOS limite l'espace d'une application web et peut l'effacer (manque de place, effacement des données de Safari, suppression de l'icône). **Gardez toujours vos fichiers originaux** dans l'app Fichiers.
- **Safari et l'app installée ne partagent pas les mêmes données.** Importez vos fichiers **depuis l'icône de l'écran d'accueil**, pas depuis l'onglet Safari.
- **Formats** : seuls les formats lus par Safari fonctionnent (voir plus bas).

---

## 2. Ce que l'application sait faire

**Musique**
- Importer plusieurs fichiers d'un coup depuis l'app Fichiers (MP3, M4A/AAC, WAV, AIFF, FLAC, et d'autres formats si Safari les lit).
- Lire les titre, artiste, album et pochette des MP3 (balises ID3). Sinon, le nom du fichier sert de titre.
- Lecture/pause, précédent/suivant, barre de progression déplaçable, temps écoulé et durée.
- Enchaînement automatique, lecture aléatoire, répétition de la liste ou d'un morceau.
- Mini-lecteur toujours visible pendant la navigation, et lecteur détaillé en plein écran.
- Recherche par titre, artiste, album ou nom de fichier (accents ignorés). Tri par nom ou par date d'ajout.
- Favoris, et playlists (créer, renommer, supprimer, ajouter/retirer des morceaux, changer l'ordre).

**Vidéo**
- Importer des MP4 / MOV / M4V, voir la liste, lire avec les commandes de Safari, passer en plein écran.
- Reprise à la dernière position (enregistrée toutes les 5 secondes, à la pause et à la fermeture).
- Messages clairs quand un fichier n'est pas lisible (codec non pris en charge, fichier abîmé).

**Bibliothèque et stockage**
- Accueil avec compteurs, ajouts récents, favoris, playlists.
- Suppression d'un fichier, ou de toute la bibliothèque après confirmation.
- Écran Réglages : espace utilisé, quota estimé, demande de stockage persistant, version, état du mode hors ligne, journal des erreurs.
- Vérification de l'espace avant l'importation, et message clair si le stockage est plein.
- **Sauvegarde** : export/import d'un petit fichier `.json` qui contient favoris, playlists et positions (sans les médias). **Export d'une copie** de n'importe quel fichier via le menu « … » (feuille de partage iOS, puis « Enregistrer dans Fichiers »).

Aucune publicité, aucune mesure d'audience, aucun compte. Aucune fonction de téléchargement depuis des sites tiers : l'app lit les fichiers que vous possédez déjà.

---

## 3. Contenu du projet

```
pocket-player/
├── index.html            Structure de la page, icônes SVG, lecteurs audio/vidéo
├── style.css             Thème sombre, mise en page adaptée à l'iPhone
├── app.js                Toute la logique : base locale, import, lecteurs, écrans
├── manifest.json         Nom, icônes et couleurs de l'app installée
├── service-worker.js     Mise en cache du code pour le hors ligne + mises à jour
├── README.md             Ce guide
└── icons/
    ├── icon-192.png
    ├── icon-512.png
    └── apple-touch-icon.png   (ajouté) icône 180×180 utilisée par iOS sur l'écran d'accueil
```

Seul changement par rapport à la structure demandée : l'ajout de `icons/apple-touch-icon.png`. Pour l'écran d'accueil, iOS utilise surtout la balise `apple-touch-icon` et pas toujours les icônes du manifeste.

Tous les chemins sont **relatifs** (`./app.js`, `icons/…`). L'app fonctionne donc dans le sous-dossier `https://votre-pseudo.github.io/pocket-player/`.

---

## 4. Guide de déploiement pas à pas

Tout se fait depuis Windows, gratuitement.

### Étape 1 : préparer Windows

1. Allez sur <https://code.visualstudio.com>, cliquez sur **Download for Windows** et installez Visual Studio Code (les options par défaut conviennent).
2. Facultatif : installez aussi **Git** depuis <https://git-scm.com/download/win> si vous voulez publier en ligne de commande (étape 4, méthode B). Sinon, tout peut se faire dans le navigateur.

### Étape 2 : créer le projet

Vous avez déjà le dossier `pocket-player` (ou l'archive `pocket-player.zip`, à extraire avec un clic droit > **Extraire tout…**).

1. Ouvrez Visual Studio Code.
2. Menu **Fichier > Ouvrir le dossier…** et choisissez le dossier `pocket-player`.
3. Vous voyez à gauche les fichiers listés à la section 3. Vous n'avez rien à modifier pour une première publication.

> Si vous créez les fichiers à la main : dans VS Code, **Fichier > Nouveau fichier**, collez le contenu, puis **Fichier > Enregistrer sous…** avec le nom exact (`index.html`, `style.css`…). Les icônes PNG doivent être copiées telles quelles dans un sous-dossier `icons`.

### Étape 3 : créer un dépôt GitHub

1. Allez sur <https://github.com> et cliquez sur **Sign up** pour créer un compte gratuit (adresse e-mail, mot de passe, nom d'utilisateur). Votre **nom d'utilisateur** apparaîtra dans l'adresse du site.
2. Une fois connecté, cliquez sur le **+** en haut à droite, puis **New repository**.
3. **Repository name** : `pocket-player`.
4. Choisissez **Public** (obligatoire pour GitHub Pages gratuit).
5. Ne cochez rien d'autre et cliquez sur **Create repository**.

### Étape 4 : publier les fichiers

**Méthode A : depuis le navigateur (la plus simple)**

1. Sur la page du dépôt vide, cliquez sur le lien **uploading an existing file** (ou **Add file > Upload files**).
2. Ouvrez le dossier `pocket-player` dans l'Explorateur Windows, sélectionnez **tout son contenu** (les fichiers **et** le dossier `icons`) et glissez-le dans la page GitHub.
   - Glissez le *contenu* du dossier, pas le dossier `pocket-player` lui-même : `index.html` doit se retrouver à la racine du dépôt.
   - Vérifiez dans la liste que `icons/icon-192.png`, `icons/icon-512.png` et `icons/apple-touch-icon.png` apparaissent. Edge et Chrome sur PC acceptent le glisser-déposer d'un dossier. Si le dossier `icons` n'apparaît pas, utilisez la méthode B.
3. En bas, cliquez sur **Commit changes**.

**Méthode B : avec Git**

Dans VS Code, ouvrez un terminal (**Terminal > Nouveau terminal**) dans le dossier `pocket-player`, puis :

```bash
git init
git add .
git commit -m "Première version de Pocket Player"
git branch -M main
git remote add origin https://github.com/VOTRE-PSEUDO/pocket-player.git
git push -u origin main
```

Au premier `git push`, une fenêtre vous demande de vous connecter à GitHub.

### Étape 5 : activer GitHub Pages

1. Sur la page du dépôt, cliquez sur **Settings** (onglet en haut).
2. Dans le menu de gauche, cliquez sur **Pages**.
3. Sous **Build and deployment** > **Source**, choisissez **Deploy from a branch**.
4. Sous **Branch**, choisissez **main** et le dossier **/ (root)**, puis cliquez sur **Save**.

### Étape 6 : ouvrir le site

1. Patientez 1 à 5 minutes, puis rechargez la page **Settings > Pages**.
2. Un encadré indique **Your site is live at** `https://VOTRE-PSEUDO.github.io/pocket-player/`.
3. Ouvrez cette adresse sur votre PC pour vérifier que Pocket Player s'affiche. L'adresse commence bien par **https://**, ce qui est indispensable au mode hors ligne.

---

## 5. Installer sur l'iPhone

1. Ouvrez l'adresse `https://VOTRE-PSEUDO.github.io/pocket-player/` dans **Safari**.
2. Attendez le chargement complet (l'écran « Pocket Player » s'affiche).
3. Touchez le bouton **Partager** (carré avec une flèche vers le haut).
4. Faites défiler et choisissez **Sur l'écran d'accueil** (le libellé peut varier selon la version d'iOS).
5. Vérifiez que le nom est « Pocket Player », puis touchez **Ajouter**.
6. Lancez Pocket Player depuis sa nouvelle icône.
7. **Importez vos fichiers depuis l'app installée** : bouton **Importer de la musique** ou **Importer des vidéos**, puis choisissez vos fichiers dans l'app Fichiers (vous pouvez en sélectionner plusieurs).

> Conseil : pour mettre vos MP3 sur l'iPhone depuis Windows, utilisez iCloud Drive (site icloud.com ou application iCloud pour Windows), un câble avec l'app Apple Devices, ou une clé USB compatible. Les fichiers apparaissent ensuite dans l'app Fichiers.

---

## 6. Vérifier le mode hors ligne

1. Ouvrez l'application avec Internet.
2. Importez un MP3 et un MP4 compatible.
3. Lisez les deux fichiers.
4. Fermez complètement l'app (balayez-la vers le haut dans le sélecteur d'applications), puis rouvrez-la.
5. Activez le **mode avion**.
6. Rouvrez l'app : elle doit démarrer, afficher la bibliothèque et lire les fichiers.

Dans **Réglages** (roue dentée sur l'accueil), la ligne **Mode hors ligne** doit afficher « prêt ». Si elle affiche « pas encore prêt », fermez et rouvrez l'app une fois avec Internet.

---

## 7. Publier une mise à jour

1. Modifiez les fichiers dans VS Code.
2. **Important** : ouvrez `service-worker.js` et augmentez la version, par exemple :
   ```js
   const APP_VERSION = '1.0.1';
   ```
   Sans ce changement, les iPhone garderont l'ancienne version en cache.
3. Publiez :
   - **Méthode A** : sur GitHub, **Add file > Upload files**, glissez les fichiers modifiés (ils remplacent les anciens), puis **Commit changes**.
   - **Méthode B** : `git add .`, `git commit -m "Version 1.0.1"`, puis `git push`.
4. Attendez quelques minutes (GitHub Pages peut garder l'ancienne version en cache jusqu'à environ 10 minutes).
5. Sur l'iPhone, ouvrez l'app avec Internet. Un bandeau **« Une nouvelle version est disponible »** apparaît : touchez **Mettre à jour**. S'il n'apparaît pas, fermez et rouvrez l'app, ou utilisez **Réglages > Rechercher une mise à jour**.

Vos médias, favoris et playlists ne sont pas touchés par une mise à jour : ils sont dans IndexedDB, séparément du code.

---

## 8. Checklist de tests

À cocher sur votre iPhone, après installation depuis GitHub Pages.

- [ ] Le site fonctionne en HTTPS.
- [ ] Le site s'ajoute à l'écran d'accueil.
- [ ] L'icône et le nom « Pocket Player » sont corrects.
- [ ] L'importation d'un MP3 fonctionne (titre, artiste et pochette affichés si le fichier en contient).
- [ ] L'importation de plusieurs fichiers d'un coup fonctionne.
- [ ] La lecture et la pause fonctionnent (mini-lecteur et lecteur détaillé).
- [ ] La barre de progression fonctionne (affichage et déplacement).
- [ ] Le morceau suivant démarre tout seul ; l'aléatoire et la répétition fonctionnent.
- [ ] La recherche et le tri fonctionnent.
- [ ] L'importation d'un MP4 fonctionne.
- [ ] Le plein écran vidéo fonctionne (bouton « Plein écran » ou commandes de la vidéo).
- [ ] La vidéo reprend à la dernière position après fermeture.
- [ ] Les favoris sont conservés après fermeture de l'app.
- [ ] Les playlists sont conservées après fermeture de l'app.
- [ ] Les fichiers importés restent accessibles hors ligne.
- [ ] L'application démarre en mode avion après le premier chargement.
- [ ] Les erreurs de format sont gérées (essayez un `.mkv` ou un fichier renommé en `.mp3`).
- [ ] Les erreurs de stockage sont gérées (message si l'espace est insuffisant).
- [ ] La suppression d'un fichier fonctionne, y compris pendant sa lecture.
- [ ] « Supprimer toute la bibliothèque » demande confirmation et vide tout.
- [ ] L'export d'une copie (menu « … ») et l'export/import de sauvegarde fonctionnent.
- [ ] Le comportement en arrière-plan est testé et noté ci-dessous :
  - écran verrouillé pendant la lecture : ☐ continue ☐ s'arrête
  - passage à une autre app : ☐ continue ☐ s'arrête
  - commandes de l'écran verrouillé / Centre de contrôle : ☐ OK ☐ absentes
  - pause/lecture depuis les écouteurs : ☐ OK ☐ sans effet
  - enchaînement du morceau suivant écran verrouillé : ☐ OK ☐ non
- [ ] Les fichiers personnels ne sont envoyés à aucun serveur (le code ne contient aucune requête réseau vers l'extérieur ; le dépôt GitHub ne contient aucun média).
- [ ] Le déploiement fonctionne depuis le sous-chemin `/pocket-player/` de GitHub Pages.

---

## 9. Limites connues

**Lecture en arrière-plan**
- iOS ne garantit pas qu'une application web continue de jouer de l'audio écran verrouillé ou en arrière-plan. Selon la version d'iOS, la musique peut continuer, s'arrêter au verrouillage, ou s'arrêter au morceau suivant.
- L'app ne simule rien : elle utilise l'API Media Session (titre, pochette, commandes lecture/pause/précédent/suivant/position). C'est iOS qui décide de les afficher.
- Une application native (avec un Mac et un compte Apple Developer) serait nécessaire pour garantir ce comportement. Ce n'est pas l'objet de cette première version.

**Stockage**
- L'espace accordé à une app web dépend de la version d'iOS et de l'espace libre de l'iPhone. **Réglages** affiche l'estimation fournie par Safari, qui reste approximative.
- iOS peut effacer les données si l'iPhone manque de place. Elles sont aussi perdues si vous effacez l'historique et les données de Safari ou si vous supprimez l'icône de l'écran d'accueil.
- Dans Safari (sans installation), iOS peut effacer les données d'un site après quelques jours sans visite. L'app installée sur l'écran d'accueil est mieux protégée, sans garantie absolue.
- Le bouton « Demander le stockage persistant » n'est qu'une demande : iOS peut la refuser, et même accordée, elle ne protège pas contre une suppression par l'utilisateur.
- Importer de très gros fichiers (vidéos de plusieurs Go) peut être lent ou échouer selon la mémoire et l'espace disponibles.
- La sauvegarde `.json` ne contient pas les médias. **Conservez vos fichiers originaux.**

**Formats**
- Audio lisible en général par Safari sur iPhone : MP3, AAC/M4A, ALAC, WAV, AIFF, FLAC. L'OGG/Opus dépend de la version d'iOS.
- Vidéo : MP4, MOV ou M4V en **H.264** ou **HEVC (H.265)**, avec un son **AAC**. Un fichier `.mp4` en MPEG-4 Part 2/Xvid, ou un MKV/AVI, ne sera pas lu. Pour convertir : **HandBrake** (gratuit, Windows), préréglage « Fast 1080p30 ».
- Les métadonnées (titre, artiste, pochette) ne sont lues que pour les MP3 (ID3). Pour les autres formats, le nom du fichier sert de titre.
- Il n'y a pas de miniature d'image pour les vidéos (icône générique).

**Autres**
- Un même fichier (même nom et même taille) n'est importé qu'une fois.
- L'import ne fonctionne pas en navigation privée si Safari y bloque IndexedDB (un message l'indique).
- Le journal des erreurs n'est conservé que pendant la session en cours.

---

## 10. Ce qui a été testé, et ce qui reste à vérifier

**Testé automatiquement par le développeur, sur PC Windows, dans Google Chrome (mode sans interface, écran simulé de 390×844 px) :**
servi depuis un sous-chemin `/pocket-player/` comme sur GitHub Pages, avec des fichiers WAV et une vidéo WebM générés pour le test :
- activation du service worker, démarrage et lecture **après arrêt du serveur web** (hors ligne) ;
- import multiple, refus d'un faux MP3 et d'une fausse MP4 avec message, détection des doublons ;
- recherche, tri par nom, lecture, pause, déplacement dans le morceau, enchaînement automatique, aléatoire, répétition ;
- favoris, création de playlist, ajout de morceaux, changement d'ordre ;
- lecture vidéo, conservation des favoris et playlists après rechargement ;
- suppression d'un morceau en cours de lecture, suppression de toute la bibliothèque (base vidée vérifiée) ;
- aucune erreur JavaScript pendant ces scénarios.
- Le lecteur de balises ID3 (v2.2/2.3/2.4 et v1, textes UTF-8/UTF-16/Latin-1, pochettes) a été testé avec des balises fabriquées.

**Non testé, à vérifier sur votre iPhone (voir la checklist) :**
- **rien n'a été testé sur un vrai iPhone ni dans Safari** ;
- vrais fichiers MP3 et MP4 (H.264/HEVC) ;
- installation sur l'écran d'accueil, icône, barre d'état ;
- sélection de fichiers depuis l'app Fichiers d'iOS ;
- comportement en arrière-plan, écran verrouillé, Centre de contrôle, écouteurs ;
- plein écran vidéo sur iPhone et reprise de position ;
- quotas de stockage réels d'iOS et message « stockage plein » ;
- feuille de partage iOS pour l'export.

---

## 11. Dépannage

| Problème | Solution |
|---|---|
| Page blanche ou 404 sur GitHub Pages | Vérifiez que `index.html` est **à la racine** du dépôt, et non dans un sous-dossier `pocket-player/`. Attendez quelques minutes après l'activation de Pages. |
| Icône manquante sur l'écran d'accueil | Vérifiez que le dossier `icons/` et ses 3 fichiers sont bien publiés. Supprimez l'icône puis réinstallez. |
| Mes fichiers ont disparu dans l'app installée | Ils ont peut-être été importés dans Safari et non dans l'app : réimportez-les depuis l'icône de l'écran d'accueil. |
| La vidéo ne se lit pas | Codec non pris en charge : convertissez-la en MP4 H.264 + AAC avec HandBrake. |
| La musique s'arrête écran verrouillé | Limite d'iOS pour les apps web (voir section 9). |
| La mise à jour n'apparaît pas | Avez-vous augmenté `APP_VERSION` dans `service-worker.js` ? Fermez puis rouvrez l'app avec Internet. |
| Message d'erreur | Ouvrez **Réglages > Journal des erreurs** pour le détail. |
