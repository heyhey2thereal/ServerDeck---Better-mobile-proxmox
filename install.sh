#!/usr/bin/env bash
# Installation de ServerDeck dans un conteneur LXC Debian (Proxmox).
# À lancer en root, depuis le dossier du dépôt, ou via get.sh :
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/get.sh)"
set -eu

APP_DIR=/opt/serverdeck
APP_USER=serverdeck
APP_HOME=/var/lib/serverdeck
PORT="${SERVERDECK_PORT:-8090}"
MDNS="${SERVERDECK_MDNS:-1}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- présentation ---------------------------------------------------------

if [ -t 1 ]; then
  TTY=1
  R=$'\033[0m'; B=$'\033[1m'; D=$'\033[2m'
  OR=$'\033[38;5;208m'; GR=$'\033[32m'; RD=$'\033[31m'; CY=$'\033[36m'
else
  TTY=0
  R=''; B=''; D=''; OR=''; GR=''; RD=''; CY=''
fi

SPIN=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
LOG="$(mktemp)"
START_ALL=$SECONDS
trap 'rm -f "$LOG"' EXIT

banner() {
  printf '\n'
  printf '  %s┌──────────────────────────────────────────────────┐%s\n' "$D" "$R"
  printf '  %s│%s  %s%sServerDeck%s                                     %s│%s\n' "$D" "$R" "$B" "$OR" "$R" "$D" "$R"
  printf '  %s│%s  %sconsole web mobile pour Proxmox%s              %s│%s\n' "$D" "$R" "$D" "$R" "$D" "$R"
  printf '  %s└──────────────────────────────────────────────────┘%s\n\n' "$D" "$R"
}

say() { printf '  %s%s%s\n' "$D" "$*" "$R"; }

# run_step "Titre" commande args...
# Exécute la commande, affiche un spinner puis ✔ (ou ✖ + journal en cas d'échec).
run_step() {
  local title="$1"; shift
  local start=$SECONDS code=0
  if [ "$TTY" = 1 ]; then
    ( "$@" ) >"$LOG" 2>&1 &
    local pid=$! i=0
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r  %s%s%s %-42s %s%ss%s' "$OR" "${SPIN[$((i % 10))]}" "$R" "$title" "$D" "$((SECONDS - start))" "$R"
      i=$((i + 1))
      sleep 0.1
    done
    wait "$pid" || code=$?
    printf '\r\033[K'
  else
    ( "$@" ) >"$LOG" 2>&1 || code=$?
  fi

  if [ "$code" -eq 0 ]; then
    printf '  %s✔%s %s %s%ss%s\n' "$GR" "$R" "$title" "$D" "$((SECONDS - start))" "$R"
  else
    printf '  %s✖%s %s\n' "$RD" "$R" "$title"
    printf '\n%s--- sortie ---%s\n' "$D" "$R"
    tail -n 25 "$LOG" || true
    exit 1
  fi
}

die() { printf '\n  %s✖ %s%s\n\n' "$RD" "$*" "$R" >&2; exit 1; }

# --- vérifications --------------------------------------------------------

banner

[ "$(id -u)" -eq 0 ] || die "à lancer en root (ou via sudo)"
[ -f "$SRC_DIR/package.json" ] || die "lance le script depuis le dossier du dépôt"
command -v systemctl >/dev/null || die "systemd est requis (LXC non privilégié Debian)"

export DEBIAN_FRONTEND=noninteractive

# --- étapes ---------------------------------------------------------------

apt_install() {
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl build-essential python3 tmux openssh-client
}

install_node() {
  if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then
    return 0
  fi
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
}

create_user() {
  id "$APP_USER" >/dev/null 2>&1 && return 0
  useradd --system --create-home --home-dir "$APP_HOME" --shell /bin/bash "$APP_USER"
}

copy_app() {
  mkdir -p "$APP_DIR"
  tar -C "$SRC_DIR" \
    --exclude=./node_modules --exclude=./.git --exclude=./config.json \
    --exclude=./tests --exclude=./data --exclude=./files --exclude=./dist --exclude='./*.log' \
    -cf - . | tar -C "$APP_DIR" -xf -
  chown -R root:root "$APP_DIR"
}

install_deps() {
  npm install --omit=dev --no-audit --no-fund
  node -e "require('node-pty')" 2>/dev/null || npm rebuild node-pty
  node -e "require('node-pty')"
}

# sudo n'est pas installé sur un Debian minimal : runuser (util-linux) l'est toujours.
as_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$APP_USER" -- "$@"
  else
    su -s /bin/sh "$APP_USER" -c "$(printf '%q ' "$@")"
  fi
}

generate_config() {
  NEW_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  as_user env HOME="$APP_HOME" SERVERDECK_CONFIG="$APP_DIR/config.json" \
    node src/setup.js --password "$NEW_PASSWORD" --totp --port "$PORT" --bind 0.0.0.0 --force
  chmod 600 "$APP_DIR/config.json"
  chown "$APP_USER:$APP_USER" "$APP_DIR/config.json"
}

setup_pve_host() {
  [ -n "${SERVERDECK_PVE_HOST:-}" ] || return 0
  node -e '
    const fs = require("fs")
    const [file, host, port] = process.argv.slice(1)
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!cfg.proxmox || !cfg.proxmox.host) {
      cfg.proxmox = { host, port: Number(port) || 8006, scheme: "https", verifyTls: false }
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n")
    }
  ' "$APP_DIR/config.json" "$SERVERDECK_PVE_HOST" "${SERVERDECK_PVE_PORT:-8006}"
  chown "$APP_USER:$APP_USER" "$APP_DIR/config.json"
}

write_unit() {
  cat > /etc/systemd/system/serverdeck.service <<UNIT
[Unit]
Description=ServerDeck — console web mobile
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=$(command -v node) src/server.js
Restart=on-failure
RestartSec=3
MemoryMax=192M

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable serverdeck >/dev/null 2>&1 || true
  systemctl restart serverdeck
  sleep 2
  if ! systemctl is-active --quiet serverdeck; then
    echo "--- journal du service ---"
    journalctl -u serverdeck -n 30 --no-pager || true
    return 1
  fi
}

setup_mdns() {
  [ "$MDNS" = "1" ] || return 0
  apt-get install -y -qq avahi-daemon avahi-utils >/dev/null 2>&1 || return 0
  systemctl enable --now avahi-daemon >/dev/null 2>&1 || return 0
  avahi-resolve -n "$(hostname).local" >/dev/null 2>&1 || true
}

say "Conteneur $(hostname) · $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") · $(uname -m)"
printf '\n'

run_step "Paquets système (tmux, ssh, compilateur)" apt_install
run_step "Node.js" install_node
run_step "Utilisateur système $APP_USER" create_user
run_step "Copie de l'application dans $APP_DIR" copy_app

cd "$APP_DIR"
run_step "Dépendances npm (compilation de node-pty)" install_deps
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

run_step "Configuration (mot de passe, TOTP)" generate_config
TOTP_URI="$(grep -o 'otpauth://[^ ]*' "$LOG" | tail -1 || true)"
TOTP_SECRET="$(awk '/TOTP secret/ {print $NF}' "$LOG" | tail -1 || true)"

run_step "Connexion Proxmox ($SERVERDECK_PVE_HOST)" setup_pve_host
run_step "Service systemd" write_unit
run_step "URL locale (mDNS)" setup_mdns

# --- résultat -------------------------------------------------------------

NAME="$(hostname)"
IP="$(hostname -I | awk '{print $1}')"
URL_IP="http://$IP:$PORT"
URL_MDNS=""
if [ "$MDNS" = "1" ] && command -v avahi-resolve >/dev/null; then
  URL_MDNS="http://$NAME.local:$PORT"
fi

BOXW=52

box_line() {
  local text="$1"
  if [ "${#text}" -gt "$BOXW" ]; then text="${text:0:$BOXW}"; fi
  printf '  %s│%s %-*s %s│%s\n' "$OR" "$R" "$BOXW" "$text" "$OR" "$R"
}

row() {
  local line
  printf -v line '%-14s %s' "$1" "$2"
  box_line "$line"
}

printf '\n'
printf '  %s✔%s Installation terminée en %ss\n\n' "$GR" "$R" "$((SECONDS - START_ALL))"
printf '  %s╭──────────────────────────────────────────────────────╮%s\n' "$OR" "$R"
printf '  %s│%s %s%-*s%s %s│%s\n' "$OR" "$R" "$B" "$BOXW" "ServerDeck est en ligne" "$R" "$OR" "$R"
printf '  %s│%s %-*s %s│%s\n' "$OR" "$R" "$BOXW" "" "$OR" "$R"
row "URL" "$URL_IP"
[ -n "$URL_MDNS" ] && row "URL locale" "$URL_MDNS"
box_line ""
if [ -n "${NEW_PASSWORD:-}" ]; then
  row "mot de passe" "$NEW_PASSWORD"
fi
[ -n "${TOTP_SECRET:-}" ] && row "TOTP" "$TOTP_SECRET"
box_line ""
row "connexion" "identifiants Proxmox"
printf '  %s╰──────────────────────────────────────────────────────╯%s\n' "$OR" "$R"

if [ -n "${TOTP_URI:-}" ]; then
  printf '\n  %sURI TOTP (à ajouter dans ton application d'"'"'authentification) :%s\n' "$D" "$R"
  printf '  %s\n' "$TOTP_URI"
fi

if command -v qrencode >/dev/null || apt-get install -y -qq qrencode >/dev/null 2>&1; then
  printf '\n'
  qrencode -t ANSIUTF8 "$URL_IP" 2>/dev/null | sed 's/^/  /' || true
fi

printf '\n'
say "Service    systemctl status serverdeck"
say "Journaux   journalctl -u serverdeck -f"
say "Sessions   sudo -u $APP_USER tmux -L serverdeck ls"
printf '\n'
say "Empreinte  $(du -sh "$APP_DIR" 2>/dev/null | cut -f1) sur disque · installation en $((SECONDS - START_ALL)) s"
printf '\n'
printf '  %sSécurité : n'"'"'expose pas ce port sur Internet.%s\n' "$RD" "$R"
printf '  %sTailscale (recommandé) ou reverse proxy TLS avec le TOTP activé.%s\n\n' "$D" "$R"
