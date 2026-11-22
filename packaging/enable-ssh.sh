#!/usr/bin/env bash
# Active le terminal du nœud et des conteneurs, sans aucune saisie.
# À lancer en root sur le nœud Proxmox :
#
#   bash enable-ssh.sh            # détecte le conteneur nommé « serverdeck »
#   bash enable-ssh.sh 109        # ou précise l'identifiant
set -eu

CTID="${1:-${CTID:-}}"
PVE_HOST="${PVE_HOST:-$(hostname -I | awk '{print $1}')}"
KEY=/var/lib/serverdeck/.ssh/serverdeck_ed25519.pub

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v pct >/dev/null || die "à lancer sur un nœud Proxmox"

if [ -z "$CTID" ]; then
  CTID=$(pct list | awk '{print $1, $NF}' | awk '$2=="serverdeck" {print $1; exit}')
fi
[ -n "$CTID" ] || die "conteneur introuvable : relance avec l'identifiant, ex. bash enable-ssh.sh 109"
pct status "$CTID" >/dev/null 2>&1 || die "le conteneur $CTID n'existe pas"

say "Clé SSH et hôte Proxmox (conteneur $CTID → $PVE_HOST)"
# Paramètres explicites + stdin fermé : setup:pve ne pose aucune question,
# quelle que soit la version installée dans le conteneur.
pct exec "$CTID" -- bash -c "cd /opt/serverdeck && runuser -u serverdeck -- env HOME=/var/lib/serverdeck \
  npm run setup:pve -- --host '$PVE_HOST' --port '${SERVERDECK_PVE_PORT:-8006}' --ssh-user root --ssh-port 22 --force" < /dev/null || {
  echo "échec de setup:pve (voir ci-dessus)"; exit 1; }

say "Autorisation de la clé sur le nœud"
pct exec "$CTID" -- cat /opt/serverdeck/packaging/proxmox-setup.sh > /tmp/serverdeck-setup.sh
PUBKEY=$(pct exec "$CTID" -- cat "$KEY")
[ -n "$PUBKEY" ] || die "clé publique absente dans le conteneur"
bash /tmp/serverdeck-setup.sh "$PUBKEY"
rm -f /tmp/serverdeck-setup.sh

say "Redémarrage du service"
pct exec "$CTID" -- systemctl restart serverdeck
sleep 2

printf '\n\033[1;32mTerminal prêt\033[0m\n\n'
pct exec "$CTID" -- bash -c 'systemctl is-active serverdeck' || true
pct exec "$CTID" -- bash -c 'curl -s localhost:8090/api/auth-mode' || true
printf '\n'
