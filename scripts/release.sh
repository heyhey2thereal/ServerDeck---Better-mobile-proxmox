#!/usr/bin/env bash
# Crée une release : étiquette le commit courant, pousse le tag et publie
# l'archive source en pièce jointe.
#
#   scripts/release.sh v0.3.0
#
# Prérequis : être sur la branche principale, arbre propre, `gh` authentifié.
set -eu

VERSION="${1:?usage: scripts/release.sh vX.Y.Z}"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOTES="$ROOT/docs/releases/$VERSION.md"
ASSET="$ROOT/dist/serverdeck-${VERSION#v}.tar.gz"

[ -z "$(git -C "$ROOT" status --porcelain)" ] || { echo "arbre de travail non propre" >&2; exit 1; }
[ -f "$NOTES" ] || { echo "notes manquantes : $NOTES" >&2; exit 1; }

mkdir -p "$ROOT/dist"
git -C "$ROOT" archive --format=tar.gz --prefix="serverdeck-${VERSION#v}/" -o "$ASSET" HEAD

git -C "$ROOT" tag -a "$VERSION" -m "ServerDeck $VERSION"
git -C "$ROOT" push origin HEAD
git -C "$ROOT" push origin "$VERSION"

gh release create "$VERSION" \
  --repo "$REPO" \
  --title "ServerDeck $VERSION" \
  --notes-file "$NOTES" \
  "$ASSET"

echo "release $VERSION publiée sur $REPO"
