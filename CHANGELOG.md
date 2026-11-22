# Journal des versions

## 1.0.3 — pilotage Proxmox au complet

- **Instantanés** : créer, revenir en arrière, supprimer, depuis le panneau d'un
  conteneur ou d'une VM (le retour arrière demande deux appuis).
- **Sauvegardes** : lancer un `vzdump` (mode `snapshot`, `suspend` ou `stop`), lister
  les archives d'un invité (taille, date, stockage) et les supprimer.
- **Clone complet** et **agrandissement du disque** (`+2G`, `16G`) sans passer par le
  shell.
- **Tâches** : liste récente par nœud avec pastille d'état, journal complet, arrêt
  d'une tâche en cours ; une **notification** arrive à la fin d'une sauvegarde, d'un
  clone ou d'un instantané (suivi de la tâche côté client, sans rester sur l'écran).
- **Nœud** : journal (`syslog`), **modèles LXC** (appliances disponibles + installation
  vers un stockage `vztmpl`), **redémarrage / arrêt** avec double confirmation.
- **Liste des conteneurs** : recherche (nom, vmid, tag) et filtres LXC / VM / en marche
  / arrêtés avec compteurs, sans perdre la saisie lors du rafraîchissement.
- Le bouton « Couper » utilise le double appui (plus de `confirm()` sur iOS).
- API : `/api/pve/guests/:node/:type/:vmid/{snapshots,clone,resize,backup}`,
  `/api/pve/backups/:node`, `/api/pve/tasks/:node/:upid`, `/api/pve/syslog/:node`,
  `/api/pve/nodes/:node/power`, `/api/pve/templates/{available/:node,:node/download}`.
- Tests : 7 nouveaux tests unitaires (client Proxmox) et 6 vérifications de bout en
  bout ; total 33 + 15 + 49 = 97.

## 1.0.2 — gestionnaire de fichiers

- **Nouvel onglet Fichiers** : envoi de n'importe quel fichier depuis le téléphone
  (sélecteur iOS/Android, glisser-déposer sur ordinateur), liste avec taille et date,
  téléchargement, renommage et suppression en deux appuis.
- **Utilisation dans les conteneurs** : lien signé (24 h) et commandes `wget`/`curl`
  prêtes à coller vers le dossier choisi, ou collage direct dans le terminal du
  conteneur. Le lien fonctionne sans cookie de session — indispensable depuis un LXC.
- Envoi **en flux** vers un fichier temporaire puis renommage : aucun fichier tronqué,
  jamais en mémoire (le conteneur a 256 Mo de RAM), plafond de 512 Mo par fichier et
  refus si le disque est plein. Les fichiers vivent à côté de `config.json` et
  survivent à `update.sh`.
- API : `GET/PUT/DELETE /api/files`, `POST /api/files/:name/rename`,
  `GET /api/files/:name/link`, `GET /d/:name?t=…` (lien signé, toujours en pièce
  jointe pour qu'un HTML envoyé ne s'exécute pas dans l'origine de l'app).
- `update.sh` se rafraîchit lui-même en fin de mise à jour : la copie
  `/root/update.sh` ne prend plus de retard sur le dépôt.
- Tests : 6 tests unitaires du stockage + 9 vérifications de bout en bout (envoi,
  liste, plafond, type refusé, noms de chemin refusés, lien signé, renommage,
  suppression).

## 1.0.1

- **Correctif : authentification Proxmox** — l'épinglage du certificat au premier
  contact cassait les connexions suivantes (certificats signés par l'autorité de
  cluster). Supprimé : `verifyTls: false` par défaut, ou `verifyTls: true` + `ca`.
- Le login distingue désormais « identifiants refusés » d'un « API injoignable ».
- **Sessions persistées** : un redémarrage du service ne déconnecte plus.

- **Console sur le nœud PVE** par défaut, avec sélecteur (nœud / tmux local / conteneur).
- **Courbes cliquables** : graphique en grand, plages heure→mois, valeur au doigt.
- **Panneau conteneur** : bouton Terminal, interrupteur « démarrer au boot ».
- **Réglages** : sessions actives avec révocation, affichage, état du conteneur.

- **Connexion Proxmox sans configuration** : l'installateur transmet l'IP du nœud ;
  on se connecte avec `root@pam` et son mot de passe. Le ticket de session remplace le
  jeton d'API pour toutes les lectures et actions (droits de l'utilisateur).
  Jeton et clé SSH deviennent facultatifs (lecture seule / shells).
- **Certificat TLS épinglé** au premier contact (auto-signé accepté).
- **Déconnexion réelle** : sessions conservées côté serveur et révoquées au logout.

- **Connexion locale réparée** : le code TOTP était exigé par le serveur mais le
  champ n'était jamais affiché en mode « mot de passe local » — la connexion était
  donc impossible. Le champ apparaît maintenant dès que le TOTP est actif.
- `install.sh` utilise `runuser` au lieu de `sudo` (absent d'un Debian minimal) :
  la configuration n'était jamais générée, le service ne démarrait pas.
- Disque du conteneur à 4 Go par défaut (1 Go provoquait « No space left on device »).
- Stockage des conteneurs choisi sur `content rootdir` (une clé USB « images » ne
  peut plus être sélectionnée).

## 1.0.0 — première version complète

Tout ce qui suit est livré ensemble : terminal, sessions persistantes, Proxmox,
connexion par identifiants Proxmox, interface au style Proxmox VE, installation
en une commande.

**Terminal**
- xterm.js + PTY, sessions **tmux** persistantes (socket dédié, `status off`) ;
- barre de touches tactile : Esc, Tab, Ctrl/Alt *sticky*, flèches, Home/End,
  PgUp/PgDn, `|`, `~`, `/`, `-`, copier, coller ;
- presse-papier : sélection + bouton, `Ctrl+Shift+C/V`, **OSC 52** (tmux → téléphone) ;
- reconnexion automatique, écran maintenu allumé, plein écran, PWA installable.

**Proxmox**
- vue des ressources par nœud : CPU, mémoire, disque, uptime, version, courbe RRD ;
- liste des LXC/VM, détail (cœurs, RAM, système, hostname, réseau), jauges ;
- actions démarrer / arrêter / couper / redémarrer ;
- shell dans chaque conteneur LXC (SSH + commande restreinte) et shell du nœud.

**Authentification**
- identifiants Proxmox (`/access/ticket`), **2FA** gérée côté serveur ;
- repli sur un mot de passe local + TOTP (`allowLocalLogin`) ;
- cookies signés `HttpOnly` / `SameSite=Strict`, 6 tentatives par IP.

**Installation**
- conteneur LXC 256 Mo / 1 Go, service systemd (`MemoryMax=192M`) ;
- installateur animé (spinner, chrono, ✔/✖) et encadré final URL / TOTP / QR ;
- URL locale mDNS (`http://<nom>.local:8090`) ;
- `get.sh` : installation en une ligne sans jeton (dépôt public) ;
- `packaging/create-lxc.sh` : création du conteneur + installation en une commande.

**Tests** : 16 tests unitaires + 30 vérifications de bout en bout.

**Correctif** : disque du conteneur porté à 4 Go par défaut (1 Go ne suffit pas :
`apt` échouait avec « No space left on device » pendant l'installation de Node).

**Correctif** : la création du conteneur choisit un stockage qui accepte les racines
de conteneur (`content rootdir`). Avant, un stockage de type « images » (clé USB,
sauvegardes) pouvait être sélectionné et `pct create` échouait avec
`storage does not support container directories`.

## Historique du développement

- **0.2.1** — terminal, sessions tmux, authentification locale, installateur LXC.
- **0.3.0** — client API Proxmox, shells de conteneurs, presse-papier OSC 52,
  connexion par identifiants Proxmox (2FA), interface style Proxmox VE,
  installateur animé, `get.sh`.
- **0.3.1** — captures d'écran, liens profonds (`?view=`, `?guest=`), `allowFrame`,
  assets versionnés.
- **1.0.0** — regroupement en une seule version publiée.
