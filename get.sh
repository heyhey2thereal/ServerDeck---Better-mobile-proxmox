#!/usr/bin/env bash
# Installation en une ligne, sans jeton (le dépôt doit être public) :
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/get.sh)"
#
# Options (variables d'environnement) :
#   SERVERDECK_VERSION=v0.3.0   installer une version précise (défaut : dernière release)
#   SERVERDECK_TARBALL=/tmp/x.tar.gz   utiliser une archive locale (hors ligne)
#   SERVERDECK_NO_INSTALL=1     télécharger et extraire, sans lancer install.sh
set -eu

REPO="${SERVERDECK_REPO:-heyhey2thereal/ServerDeck---Better-mobile-proxmox}"
VERSION="${SERVERDECK_VERSION:-latest}"

if [ -t 1 ]; then
  R=$'\033[0m'; B=$'\033[1m'; D=$'\033[2m'; OR=$'\033[38;5;208m'; RD=$'\033[31m'
else
  R=''; B=''; D=''; OR=''; RD=''
fi

fail() { printf '\n  %s✖ %s%s\n\n' "$RD" "$*" "$R" >&2; exit 1; }

printf '\n  %s%sServerDeck%s %s— récupération des fichiers%s\n\n' "$B" "$OR" "$R" "$D" "$R"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -n "${SERVERDECK_TARBALL:-}" ]; then
  [ -f "$SERVERDECK_TARBALL" ] || fail "archive introuvable : $SERVERDECK_TARBALL"
  printf '  %s·%s archive locale %s\n' "$D" "$R" "$SERVERDECK_TARBALL"
  tar -xzf "$SERVERDECK_TARBALL" -C "$WORK"
else
  command -v curl >/dev/null || fail "curl est requis (apt-get install -y curl)"
  if [ "$VERSION" = "latest" ]; then
    printf '  %s·%s recherche de la dernière version…\n' "$D" "$R"
    TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
    [ -n "$TAG" ] || fail "impossible de trouver une release (dépôt privé ou aucune release). Utilise SERVERDECK_VERSION=vX.Y.Z."
  else
    TAG="$VERSION"
  fi
  printf '  %s·%s téléchargement de %s…\n' "$D" "$R" "$TAG"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/tags/$TAG" -o "$WORK/src.tar.gz" \
    || fail "téléchargement impossible : le dépôt est-il public ? (ou utilise SERVERDECK_TARBALL)"
  tar -xzf "$WORK/src.tar.gz" -C "$WORK"
  printf '  %s✔%s %s récupéré\n' "$OR" "$R" "$TAG"
fi

DIR="$(find "$WORK" -maxdepth 1 -mindepth 1 -type d | head -1)"
[ -n "$DIR" ] && [ -f "$DIR/install.sh" ] || fail "archive invalide (install.sh absent)"

if [ "${SERVERDECK_NO_INSTALL:-0}" = "1" ]; then
  printf '\n  %s·%s fichiers extraits dans %s\n\n' "$D" "$R" "$DIR"
  exit 0
fi

printf '\n'
exec bash "$DIR/install.sh" "$@"
