#!/usr/bin/env bash
# Réinitialise complètement ServerDeck : détruit le conteneur, le recrée,
# l'installe, configure Proxmox et le terminal SSH. Aucune question posée.
#
#   bash reset.sh        # conteneur 109 (ou celui nommé « serverdeck »)
#   bash reset.sh 110    # autre identifiant
#
# ATTENTION : la configuration (mot de passe local) et les fichiers envoyés
# (onglet Fichiers) sont perdus : le conteneur est détruit puis recréé.
set -eu

CTID="${1:-}"
REPO="${REPO:-heyhey2thereal/ServerDeck---Better-mobile-proxmox}"
RAM="${RAM:-256}"
DISK="${DISK:-4}"
BRIDGE="${BRIDGE:-vmbr0}"
PVE_HOST="${PVE_HOST:-$(hostname -I | awk '{print $1}')}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v pct >/dev/null || die "à lancer sur un nœud Proxmox, en root"
[ "$(id -u)" -eq 0 ] || die "à lancer en root"

if [ -z "$CTID" ]; then
  CTID=$(pct list | awk '{print $1, $NF}' | awk '$2=="serverdeck" {print $1; exit}')
fi
CTID="${CTID:-109}"

say "Réinitialisation du conteneur $CTID"
printf '    DESTRUCTION du conteneur %s puis recréation (dans 5 s, Ctrl+C pour annuler)\n' "$CTID"
sleep 5

if pct status "$CTID" >/dev/null 2>&1; then
  pct stop "$CTID" >/dev/null 2>&1 || true
  pct destroy "$CTID"
fi

say "Gabarit Debian 12"
TSTORE=$(pvesm status -content vztmpl | awk 'NR>1 && $3=="active" {print $1; exit}')
TSTORE="${TSTORE:-local}"
TMPL=$(pveam list "$TSTORE" | awk '/debian-12-standard/ {print $1; exit}')
if [ -z "$TMPL" ]; then
  NAME=$(pveam available --section system | awk '{for(i=1;i<=NF;i++) if ($i ~ /^debian-12-standard.*\.tar\.zst$/) {print $i; exit}}')
  [ -n "$NAME" ] || die "aucun gabarit Debian 12 disponible"
  pveam download "$TSTORE" "$NAME" >/dev/null
  TMPL="$TSTORE:vztmpl/$NAME"
fi
echo "    $TMPL"

say "Création (${RAM} Mo de RAM, ${DISK} Go de disque)"
STORE=$(pvesm status -content rootdir | awk 'NR>1 && $3=="active" {print $1; exit}')
STORE="${STORE:-local-lvm}"
echo "    disque sur $STORE"
pct create "$CTID" "$TMPL" \
  --hostname serverdeck --cores 1 --memory "$RAM" --swap "$RAM" \
  --rootfs "$STORE":"$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --unprivileged 1 --features nesting=1 --onboot 1
pct start "$CTID"

say "Attente du réseau"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done

say "Installation de ServerDeck (archive de branche, sans cache)"
pct exec "$CTID" -- env SERVERDECK_PVE_HOST="$PVE_HOST" bash -c \
  "apt-get update -qq && apt-get install -y -qq curl ca-certificates && \
   mkdir -p /tmp/sd && \
   curl -fsSL https://codeload.github.com/$REPO/tar.gz/refs/heads/main | tar -xz -C /tmp/sd --strip-components=1 && \
   bash /tmp/sd/install.sh"

say "Connexion Proxmox et clé SSH"
pct exec "$CTID" -- bash -c "cd /opt/serverdeck && runuser -u serverdeck -- env HOME=/var/lib/serverdeck \
  npm run setup:pve -- --host '$PVE_HOST' --port 8006 --ssh-user root --ssh-port 22 --force" < /dev/null

pct exec "$CTID" -- cat /opt/serverdeck/packaging/proxmox-setup.sh > /tmp/sd-setup.sh
PUBKEY=$(pct exec "$CTID" -- cat /var/lib/serverdeck/.ssh/serverdeck_ed25519.pub)
[ -n "$PUBKEY" ] || die "clé publique absente dans le conteneur"
bash /tmp/sd-setup.sh "$PUBKEY"
rm -f /tmp/sd-setup.sh

say "Redémarrage"
pct exec "$CTID" -- systemctl restart serverdeck
sleep 2

IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
printf '\n\033[1;32mServerDeck est prêt\033[0m\n\n'
printf '  URL        http://%s:8090\n' "$IP"
printf '  connexion  root@pam (identifiants Proxmox)\n\n'
pct exec "$CTID" -- bash -c 'systemctl is-active serverdeck'
pct exec "$CTID" -- bash -c 'curl -s localhost:8090/api/auth-mode'
printf '\n'
