# ⚡ Prodigy Chat — Plateforme de Messagerie en Temps Réel

**Prodigy Chat** est une application web de messagerie instantanée haut de gamme et performante, développée dans le cadre de la quatrième tâche (Task 04) du stage en développement Full Stack chez **Prodigy InfoTech** (`PRODIGY_FS_04`).

Ce projet a été conçu avec une exigence rigoureuse, en combinant une architecture backend robuste (Node.js, WebSockets, SQLite/Turso) et une interface frontend premium, respectant les standards de design et d'animation les plus modernes :
- 🎨 **Taste Skill (Anti-IA) :** Interface brutaliste et éditoriale au design sombre (Dark Mode) épuré. Refus strict des clichés visuels génériques au profit d'une typographie soignée (`Inter` & `Playfair Display`) et d'une hiérarchie visuelle claire.
- ⚡ **Emil Kowalski Animation & UI :** Transitions fluides, modales interactives avec physique de ressort (Spring physics), indicateurs de frappe en direct et tiroirs latéraux réactifs pour une immersion totale.
- 📐 **Impeccable Design & Rigueur :** Alignement strict sur une grille spatiale de 4px/8px, ergonomie intuitive et accessibilité soignée.

---

## 🚀 Fonctionnalités Clés Implémentées

### 1. 🔐 Sécurité & Authentification (Auth System)
- **Inscription & Connexion Sécurisées :** Hachage des mots de passe en base de données via `bcrypt`.
- **Sessions Persistantes :** Génération et validation de jetons **JSON Web Tokens (JWT)** stockés de manière sécurisée pour maintenir la session active.
- **Gestion des Erreurs :** Retours visuels dynamiques en cas d'identifiants incorrects ou de noms d'utilisateurs déjà existants.

### 2. 💬 Messagerie Instantanée (WebSockets)
- **Communication Basse Latence :** Transmission bidirectionnelle en temps réel propulsée par `Socket.io`.
- **Historique Persistant :** Chargement automatique des 50 derniers messages d'un salon dès la connexion grâce à la base de données SQLite/Turso.
- **Indicateur de Saisie (Typing Indicator) :** Notification visuelle animée en direct (`...`) indiquant lorsqu'un utilisateur est en train d'écrire dans le salon actif.

### 3. 📁 Gestion Avancée des Canaux (Rooms Management)
- **Salons Thématiques :** Navigation fluide entre différents canaux de discussion (ex: `# Général`).
- **Création de Canaux Personnalisés :** Modale interactive permettant aux utilisateurs de créer instantanément de nouveaux salons publics, diffusés en direct à tous les membres connectés.

### 4. 👥 Communauté & Statuts en Direct
- **Indicateurs de Présence :** Pastilles d'état dynamiques (vert pour `En ligne`, gris pour `Hors ligne`) mises à jour instantanément lors de la connexion/déconnexion d'un membre.
- **Compteur en Temps Réel :** Affichage en direct du nombre total de membres actifs présents sur la plateforme.

### 5. 📎 Partage de Fichiers & Médias (File Sharing)
- **Capacité de Téléversement Élargie (15 Mo) :** Supporte l'envoi de documents volumineux, photos haute résolution et vidéos jusqu'à **15 Mo**. Le serveur utilise un buffer de 25 Mo pour prendre en charge l'overhead d'encodage base64 sans coupure.
- **Envoi d'Images & Prévisualisation :** Partage instantané d'images avec affichage direct et élégant dans le flux de messages.
- **Documents & Archives :** Prise en charge des fichiers PDF, DOCX et autres documents avec bouton de téléchargement direct intégré au message.
- **Défilement Intelligent & Instantané (Scroll-to-Bottom) :** Dès qu'un message est reçu ou qu'un média (image, sticker, vidéo) termine son chargement sur n'importe quel appareil, le fil de discussion défile automatiquement vers le bas de façon fluide, garantissant une visibilité instantanée et parfaite du nouveau message.

### 6. 🎙️ Messagerie Vocale Premium & Lecteur Custom (Cross-Browser)
- **Enregistrement Haute Fidélité :** Enregistrement audio natif avec détection automatique du type MIME optimal selon le navigateur client (évitant les erreurs de codec).
- **Lecteur Audio Événementiel Premium :** Interface minimaliste intégrée en mode sombre, contrôles ultra-réactifs et barres de progression fluides utilisant exclusivement les événements HTML5 natifs (`timeupdate`, `ended`, `play`, `pause`). Évite toute consommation inutile (zéro intervalle ou temporisateur).
- **Bypass du bug WebM "Infinity Duration" :** Injection dynamique et calcul en temps réel de la progression temporelle à partir des métadonnées de durée enregistrées, contournant le bug natif de Chrome/Edge sur les conteneurs WebM.
- **Chargement Asynchrone par Blob URL :** Conversion automatique à la volée des payloads Base64 volumineux en objets Blobs virtuels (`URL.createObjectURL`), garantissant une fluidité maximale et éliminant tout plantage ou erreur `NotSupportedError` du navigateur.

### 7. 📲 PWA & Notifications d'Arrière-Plan Mobiles & Bureau (Service Worker)
- **Notifications d'Arrière-Plan Persistantes :** Enregistrement automatique d'un **Service Worker** (`sw.js`) pour prendre en charge l'affichage des notifications système natives directement sur appareils mobiles (Android & iOS 16.4+) et ordinateurs de bureau, même lorsque le navigateur est fermé ou en arrière-plan.
- **Redirection Intelligente :** Cliquer sur une notification réactive bascule instantanément l'utilisateur sur le bon canal de chat et ramène la fenêtre au premier plan de façon transparente.

### 8. 🎬 Lecteur Vidéo en Ligne Intégré (Inline Video Player)
- **Lecture Directe dans le Chat :** Détection automatique des formats vidéo partagés (`video/mp4`, `video/webm`, `video/ogg`, etc.) et affichage immédiat sous forme de lecteur vidéo HTML5 haute résolution, contrôlable et incurvé directement dans le fil de discussion sans nécessiter de téléchargement externe.

### 9. ✨ Créateur & Bibliothèque de Stickers Personnels (User-Generated Stickers)
- **Ajout Direct d'Images / GIFs :** Les utilisateurs peuvent désormais enrichir la bibliothèque en important leurs propres images transparentes, mèmes ou GIFs animés directement depuis leur appareil photo/galerie.
- **Stockage Persistant Clientless (LocalStorage) :** Sauvegarde locale persistante et instantanée via `localStorage` garantissant zéro surcharge de bande passante ou de stockage sur la base de données du serveur.
- **Gestion Complète de Collection :** Option de suppression rapide en un clic (bouton de suppression dynamique rouge survolé) sur chaque sticker personnel pour gérer sa collection en toute simplicité.

---

## 🛠️ Architecture Technique & Technologies

Le projet repose sur une stack moderne, légère et hautement performante, garantissant une simplicité d'exécution et une scalabilité optimale :

```text
PRODIGY_FS_04/
│
├── server.js           # Serveur Node.js/Express, configuration Socket.io et logique DB
├── chat.db             # Base de données SQLite / libSQL locale (compatible Turso)
├── package.json        # Dépendances du projet (Express, Socket.io, Bcrypt, JWT, libSQL...)
└── public/             # Application Frontend Vanilla (Zéro framework externe)
    ├── index.html      # Structure sémantique HTML5
    ├── style.css       # Système de design complet (Dark mode, UI premium)
    └── app.js          # Logique client, gestionnaire de sockets et interactions UI
```

### Stack Technique Détaillée :
- **Backend :** Node.js, Express.js, WebSockets (`Socket.io`).
- **Base de Données :** SQLite / libSQL (`@libsql/client`), compatible avec le cloud Turso.
- **Sécurité :** `bcrypt` (hachage), `jsonwebtoken` (JWT), `dotenv` (variables d'environnement).
- **Frontend :** HTML5, CSS3 Vanilla, JavaScript ES6+ (Fetch API, Socket.io Client, Web Storage API).

---

## 📦 Instructions d'Installation & d'Exécution

Pour lancer l'application sur votre environnement local :

1. **Clonez le dépôt ou accédez au dossier du projet :**
   ```bash
   cd c:\TON_ORDINATEUR\Prodigy\PRODIGY_FS_04
   ```

2. **Installez les dépendances requises :**
   ```bash
   npm install
   ```

3. **Configurez l'environnement (Optionnel) :**
   Le projet fonctionne immédiatement avec une base SQLite locale (`chat.db`). Si vous souhaitez utiliser une base Turso distante ou personnaliser votre clé JWT, créez un fichier `.env` à la racine :
   ```env
   PORT=3001
   JWT_SECRET=votre_cle_secrete_super_secu
   # TURSO_DATABASE_URL=libsql://votre-base-turso.turso.io
   # TURSO_AUTH_TOKEN=votre_token_turso
   ```

4. **Démarrez le serveur :**
   ```bash
   npm start
   ```

5. **Accédez à l'application :**
   Ouvrez votre navigateur web à l'adresse suivante : [http://localhost:3001](http://localhost:3001).

---
*Développé avec passion, rigueur et excellence pour Prodigy InfoTech (PRODIGY_FS_04).*