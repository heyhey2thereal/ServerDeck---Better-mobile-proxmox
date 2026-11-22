#!/usr/bin/env bash
# Diagnostic ServerDeck : affiche l'état réel (config, clé, autorisation, SSH).
#   bash doctor.sh        # conteneur nommé serverdeck ou 109
#   bash doctor.sh 110
set -u

CTID="${1:-}"
PVE_HOST="${PVE_HOST:-$(hostname -I | awk '{print $1}')}"
[ -n "$CTID" ] || CTID=$(pct list | awk '{print $1, $NF}' | awk '$2=="serverdeck" {print $1; exit}')
CTID="${CTID:-109}"

hr() { printf '\n\033[1;36m--- %s\033[0m\n' "$*"; }

hr "conteneur"
printf 'id=%s  hote=%s  service=' "$CTID" "$PVE_HOST"
pct exec "$CTID" -- systemctl is-active serverdeck 2>/dev/null || echo inconnu

hr "config.json (bloc proxmox)"
pct exec "$CTID" -- node -e "const c=require('/opt/serverdeck/config.json');console.log(JSON.stringify(c.proxmox||null,null,2))"

hr "cle SSH dans le conteneur"
pct exec "$CTID" -- ls -la /var/lib/serverdeck/.ssh 2>&1

hr "setup:pve (execution reelle, sortie complete)"
pct exec "$CTID" -- bash -c "cd /opt/serverdeck && runuser -u serverdeck -- env HOME=/var/lib/serverdeck \
  npm run setup:pve -- --host '$PVE_HOST' --port 8006 --ssh-user root --ssh-port 22 --force" 2>&1 | tail -25

hr "cle publique"
pct exec "$CTID" -- cat /var/lib/serverdeck/.ssh/serverdeck_ed25519.pub 2>&1

hr "authorized_keys du noeud"
grep -c 'serverdeck-shell' /root/.ssh/authorized_keys 2>/dev/null || echo "0 ligne"
ls -l /usr/local/sbin/serverdeck-shell 2>&1

hr "test SSH reel (hote -> noeud)"
pct exec "$CTID" -- cat /var/lib/serverdeck/.ssh/serverdeck_ed25519 > /tmp/sd-test-key 2>/dev/null || true
if [ -s /tmp/sd-test-key ]; then
  chmod 600 /tmp/sd-test-key
  # la commande forcée n'accepte que « host » : on lui envoie la commande à exécuter
  # sur son entrée standard.
  echo 'echo SSH_OK' | ssh -T -i /tmp/sd-test-key -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/tmp/sd-known -p 22 "root@$PVE_HOST" host 2>&1 | tail -5
  rm -f /tmp/sd-test-key /tmp/sd-known
else
  echo "pas de cle privee dans le conteneur"
fi

hr "fichiers envoyes (onglet Fichiers)"
pct exec "$CTID" -- bash -c 'du -sh /opt/serverdeck/files 2>/dev/null || echo "aucun fichier"'
pct exec "$CTID" -- bash -c 'df -h /opt/serverdeck | tail -1'

hr "API ServerDeck"
pct exec "$CTID" -- bash -c 'curl -s localhost:8090/api/auth-mode'
printf '\n'
