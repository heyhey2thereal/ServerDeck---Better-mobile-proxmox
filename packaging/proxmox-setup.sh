#!/usr/bin/env bash
# Prépare un nœud Proxmox pour ServerDeck. À lancer en root sur le nœud.
#
#   bash proxmox-setup.sh '<clé publique serverdeck>'
#
# Crée : utilisateur + rôle + jeton d'API, commande SSH restreinte, autorisation
# de la clé. Affiche le secret du jeton une seule fois.
set -eu

PUBKEY="${1:-}"
[ -n "$PUBKEY" ] || { echo "usage: $0 '<clé publique serverdeck>'" >&2; exit 1; }

USER_NAME=serverdeck@pve
ROLE=ServerDeck
TOKEN_NAME=api
SHELL_WRAPPER=/usr/local/sbin/serverdeck-shell

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

command -v pveum >/dev/null || { echo "pveum introuvable : ce script doit tourner sur un nœud Proxmox" >&2; exit 1; }

say "Utilisateur $USER_NAME"
pveum user list --output-format json | grep -q "\"$USER_NAME\"" \
  || pveum user add "$USER_NAME" --comment "ServerDeck (console mobile)"

say "Rôle $ROLE (lecture + démarrage/arrêt des invités)"
pveum role add "$ROLE" --privs "VM.Audit,Sys.Audit,Datastore.Audit,VM.PowerMgmt" 2>/dev/null \
  || pveum role modify "$ROLE" --privs "VM.Audit,Sys.Audit,Datastore.Audit,VM.PowerMgmt"
pveum acl modify / --roles "$ROLE" --users "$USER_NAME"

say "Jeton d'API $USER_NAME!$TOKEN_NAME"
TOKEN_OUT="$(pveum user token list "$USER_NAME" --output-format json 2>/dev/null || echo '[]')"
if printf '%s' "$TOKEN_OUT" | grep -q "\"$TOKEN_NAME\""; then
  echo "Le jeton existe déjà. Pour en générer un nouveau :"
  echo "  pveum user token remove $USER_NAME $TOKEN_NAME && pveum user token add $USER_NAME $TOKEN_NAME --privsep 0"
  SECRET="(jeton existant, secret inchangé)"
else
  ADD_OUT="$(pveum user token add "$USER_NAME" "$TOKEN_NAME" --privsep 0)"
  SECRET="$(printf '%s' "$ADD_OUT" | awk -F'│' '/value/ {gsub(/ /,"",$3); print $3}')"
  [ -n "$SECRET" ] || SECRET="(voir la sortie de pveum ci-dessus)"
fi

say "Commande SSH restreinte $SHELL_WRAPPER"
cat > "$SHELL_WRAPPER" <<'WRAPPER'
#!/bin/bash
# N'accepte que deux commandes : « host » et « ct <vmid> ».
set -u
case "${SSH_ORIGINAL_COMMAND:-}" in
  host)
    exec /bin/bash -l
    ;;
  ct\ *)
    vmid="${SSH_ORIGINAL_COMMAND#ct }"
    if [[ "$vmid" =~ ^[0-9]{1,9}$ ]] && pct status "$vmid" >/dev/null 2>&1; then
      exec pct enter "$vmid"
    fi
    echo "conteneur inconnu : $vmid" >&2
    exit 2
    ;;
  *)
    echo "commande refusée" >&2
    exit 2
    ;;
esac
WRAPPER
chmod 0755 "$SHELL_WRAPPER"

say "Autorisation de la clé"
AUTH_KEYS=/root/.ssh/authorized_keys
mkdir -p /root/.ssh
chmod 700 /root/.ssh
touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"
LINE="command=\"$SHELL_WRAPPER\",no-port-forwarding,no-agent-forwarding,no-x11-forwarding $PUBKEY"
grep -qF "$PUBKEY" "$AUTH_KEYS" || printf '%s\n' "$LINE" >> "$AUTH_KEYS"

say "Terminé"
cat <<INFO
  Utilisateur : $USER_NAME
  Jeton       : $USER_NAME!$TOKEN_NAME
  Secret      : $SECRET
  SSH         : clé autorisée (commande restreinte : host | ct <vmid>)

  Dans ServerDeck (conteneur) :
    npm run setup:pve -- --host <ip-du-noeud> --token-id $USER_NAME!$TOKEN_NAME --token-secret '<secret>'
INFO
