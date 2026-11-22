#!/usr/bin/env bash
# Met à jour ServerDeck dans son conteneur. La configuration, les sessions et la
# clé SSH sont conservées. Tout est affiché : en cas d'échec, l'erreur est visible.
#
#   bash update.sh          # conteneur nommé « serverdeck » ou 109
#   bash update.sh 110
set -u

CTID="${1:-}"
REPO="${REPO:-heyhey2thereal/ServerDeck---Better-mobile-proxmox}"
PVE_HOST="${PVE_HOST:-$(hostname -I | awk '{print $1}')}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mÉCHEC : %s\033[0m\n' "$*" >&2; exit 1; }

command -v pct >/dev/null || fail "pct introuvable : lance ce script sur le nœud Proxmox, en root"
[ "$(id -u)" -eq 0 ] || fail "à lancer en root"

if [ -z "$CTID" ]; then
  CTID=$(pct list 2>/dev/null | awk '{print $1, $NF}' | awk '$2=="serverdeck" {print $1; exit}')
fi
CTID="${CTID:-109}"
pct status "$CTID" >/dev/null 2>&1 || fail "le conteneur $CTID n'existe pas ou est arrêté"

step "état actuel"
pct exec "$CTID" -- bash -c 'systemctl is-active serverdeck || true'
pct exec "$CTID" -- bash -c 'curl -s localhost:8090/api/health || true'
printf '\n'

step "téléchargement de la dernière version"
pct exec "$CTID" -- bash -c \
  "rm -rf /tmp/sd && mkdir -p /tmp/sd && \
   curl -fSL --retry 3 https://codeload.github.com/$REPO/tar.gz/refs/heads/main -o /tmp/sd/src.tar.gz && \
   tar -xzf /tmp/sd/src.tar.gz -C /tmp/sd --strip-components=1" \
  || fail "téléchargement impossible depuis le conteneur (DNS, proxy ou pas d'accès Internet)"

step "installation (sortie complète)"
pct exec "$CTID" -- env SERVERDECK_PVE_HOST="$PVE_HOST" bash -c 'bash /tmp/sd/install.sh' \
  || fail "l'installateur a échoué (voir les lignes ci-dessus)"

step "connexion Proxmox et clé SSH"
if pct exec "$CTID" -- bash -c "cd /opt/serverdeck && runuser -u serverdeck -- env HOME=/var/lib/serverdeck \
  npm run setup:pve -- --host '$PVE_HOST' --port 8006 --ssh-user root --ssh-port 22 --force" < /dev/null; then
  if pct exec "$CTID" -- cat /opt/serverdeck/packaging/proxmox-setup.sh > /tmp/sd-setup.sh 2>/dev/null; then
    PUBKEY=$(pct exec "$CTID" -- cat /var/lib/serverdeck/.ssh/serverdeck_ed25519.pub 2>/dev/null || true)
    if [ -n "$PUBKEY" ]; then
      bash /tmp/sd-setup.sh "$PUBKEY" >/tmp/sd-pve-auth.log 2>&1 || printf '   (clé déjà autorisée)\n'
    fi
  fi
  rm -f /tmp/sd-setup.sh
else
  printf '   setup:pve a échoué — le reste de la mise à jour continue\n'
fi

step "redémarrage"
pct exec "$CTID" -- systemctl restart serverdeck || fail "redémarrage impossible"
sleep 2

step "script de mise à jour"
# Le script se rafraîchit lui-même : la copie locale (/root/update.sh) ne prend
# pas de retard sur le dépôt. bash lit le fichier déjà ouvert, le mv est sans effet
# sur l'exécution en cours.
SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || true)"
if [ -n "$SELF" ] && [ -w "$(dirname "$SELF")" ] && command -v curl >/dev/null; then
  if curl -fsSL --retry 2 "https://raw.githubusercontent.com/$REPO/main/packaging/update.sh" \
      -o "$SELF.new" 2>/dev/null && bash -n "$SELF.new" 2>/dev/null; then
    chmod +x "$SELF.new" && mv "$SELF.new" "$SELF" && printf '   %s rafraîchi\n' "$SELF"
  else
    rm -f "$SELF.new"
    printf '   (rafraîchissement impossible, sans conséquence)\n'
  fi
fi

IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
printf '\n\033[1;32mMise à jour terminée\033[0m\n\n'
printf '  URL      http://%s:8090\n' "$IP"
printf '  service  '
pct exec "$CTID" -- bash -c 'systemctl is-active serverdeck'
printf '  version  '
pct exec "$CTID" -- bash -c 'curl -s localhost:8090/api/health'
printf '\n  proxmox  '
pct exec "$CTID" -- bash -c 'curl -s localhost:8090/api/auth-mode'
printf '\n'
