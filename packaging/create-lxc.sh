#!/usr/bin/env bash
# Crée un conteneur LXC Debian et y installe ServerDeck.
# À lancer en root sur le nœud Proxmox :
#
#   bash create-lxc.sh 109
#   TOKEN=ghp_xxx bash create-lxc.sh 109     # dépôt privé
#
# Variables : CTID (ou $1), TOKEN (facultatif), REPO, RAM, DISK, BRIDGE, CT_HOSTNAME.
set -eu

CTID="${1:-${CTID:-109}}"
REPO="${REPO:-heyhey2thereal/ServerDeck---Better-mobile-proxmox}"
TOKEN="${TOKEN:-}"
RAM="${RAM:-256}"
DISK="${DISK:-4}"
BRIDGE="${BRIDGE:-vmbr0}"
CT_HOSTNAME="${CT_HOSTNAME:-serverdeck}"
STORE="${STORE:-}"

command -v pct >/dev/null || { echo "pct introuvable : à lancer sur un nœud Proxmox" >&2; exit 1; }
pct status "$CTID" >/dev/null 2>&1 && { echo "Le conteneur $CTID existe déjà." >&2; exit 1; }

echo "==> gabarit Debian 12"
pveam update >/dev/null 2>&1 || true
TSTORE=$(pvesm status -content vztmpl | awk 'NR>1 && $3=="active" {print $1; exit}')
TSTORE="${TSTORE:-local}"
TMPL=$(pveam list "$TSTORE" | awk '/debian-12-standard/ {print $1; exit}')
if [ -z "$TMPL" ]; then
  NAME=$(pveam available --section system \
    | awk '{for (i=1;i<=NF;i++) if ($i ~ /^debian-12-standard.*\.tar\.zst$/) {print $i; exit}}')
  [ -n "$NAME" ] || { echo "Aucun gabarit Debian 12 disponible." >&2; exit 1; }
  pveam download "$TSTORE" "$NAME" >/dev/null
  TMPL="$TSTORE:vztmpl/$NAME"
fi
echo "    $TMPL"

echo "==> création du conteneur $CTID"
# Un conteneur a besoin d'un stockage qui accepte les racines de conteneur
# (rootdir) — « images » ne suffit pas et peut désigner une clé USB.
ROOTDIR_STORES=$(pvesm status -content rootdir | awk 'NR>1 && $3=="active" {print $1}')
if [ -z "$STORE" ]; then
  STORE=$(printf '%s\n' "$ROOTDIR_STORES" | head -1)
fi
if [ -z "$STORE" ]; then
  echo "Aucun stockage actif n'accepte les racines de conteneur (content rootdir)." >&2
  echo "Active « Container » sur un stockage : Datacenter > Stockage > <nom> > Modifier > Contenu." >&2
  echo "Ou en ligne de commande : pvesm set local --content backup,iso,vztmpl,rootdir" >&2
  exit 1
fi
if ! printf '%s\n' "$ROOTDIR_STORES" | grep -qx "$STORE"; then
  echo "Le stockage « $STORE » n'accepte pas les conteneurs (content rootdir)." >&2
  echo "Stockages qui l'acceptent : $(printf '%s' "$ROOTDIR_STORES" | tr '\n' ' ')" >&2
  echo "Pour l'activer sur $STORE :" >&2
  echo "  pvesm set $STORE --content backup,iso,vztmpl,rootdir   (adapte la liste à tes besoins)" >&2
  exit 1
fi
echo "    disque sur $STORE ($DISK Go)"
pct create "$CTID" "$TMPL" \
  --hostname "$CT_HOSTNAME" --cores 1 --memory "$RAM" --swap "$RAM" \
  --rootfs "$STORE":"$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --unprivileged 1 --features nesting=1 --onboot 1
pct start "$CTID"

echo "==> attente du réseau"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done

echo "==> préparation"
pct exec "$CTID" -- bash -c 'apt-get update -qq && apt-get install -y -qq curl ca-certificates git'

echo "==> installation de ServerDeck"
# L'hôte Proxmox est connu ici : on le transmet pour que la connexion avec les
# identifiants Proxmox fonctionne sans aucune configuration supplémentaire.
PVE_HOST="${PVE_HOST:-$(hostname -I | awk '{print $1}')}"
echo "    connexion Proxmox sur $PVE_HOST"
if [ -n "$TOKEN" ]; then
  pct exec "$CTID" -- bash -c \
    "git clone -q https://x-access-token:$TOKEN@github.com/$REPO /root/serverdeck && bash /root/serverdeck/install.sh"
else
  pct exec "$CTID" -- env SERVERDECK_PVE_HOST="$PVE_HOST" bash -c \
    "bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/$REPO/main/get.sh)\""
fi

echo "==> terminal du nœud et des conteneurs (SSH)"
# Paramètres explicites + stdin fermé : setup:pve ne pose aucune question.
pct exec "$CTID" -- bash -c "cd /opt/serverdeck && runuser -u serverdeck -- env HOME=/var/lib/serverdeck \
  npm run setup:pve -- --host '$PVE_HOST' --port 8006 --ssh-user root --ssh-port 22 --force" \
  < /dev/null >/dev/null 2>&1 || true

if pct exec "$CTID" -- cat /opt/serverdeck/packaging/proxmox-setup.sh > /tmp/serverdeck-setup.sh 2>/dev/null; then
  PUBKEY=$(pct exec "$CTID" -- cat /var/lib/serverdeck/.ssh/serverdeck_ed25519.pub 2>/dev/null || true)
  if [ -n "$PUBKEY" ]; then bash /tmp/serverdeck-setup.sh "$PUBKEY" >/dev/null 2>&1 || true; fi
fi
rm -f /tmp/serverdeck-setup.sh
pct exec "$CTID" -- systemctl restart serverdeck >/dev/null 2>&1 || true

IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
echo
echo "Conteneur $CTID prêt : http://$IP:8090"
