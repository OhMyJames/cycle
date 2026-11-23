#!/usr/bin/env bash
# Writes the Apple signing secrets into this repository's GitHub Actions secrets, from the files and
# values on the machine that holds them. Run it there:
#
#   scripts/set-apple-secrets.sh path/to/DeveloperID.p12 path/to/AuthKey_XXXX.p8
#
# It asks for the rest. Nothing is echoed, written to a file or kept in shell history: values go to
# `gh secret set` on its standard input. Needs `gh` logged in with rights on the repository.
set -euo pipefail

REPO="${CYCLE_REPO:-OhMyJames/cycle}"
P12="${1:?usage: $0 <DeveloperID.p12> <AuthKey.p8>}"
P8="${2:?usage: $0 <DeveloperID.p12> <AuthKey.p8>}"
[ -r "$P12" ] || { echo "cannot read $P12" >&2; exit 1; }
[ -r "$P8" ] || { echo "cannot read $P8" >&2; exit 1; }
command -v gh > /dev/null || { echo "gh is not installed" >&2; exit 1; }

ask() { # ask <prompt> <secret?>
  local value
  if [ "${2:-}" = secret ]; then read -r -s -p "$1: " value; echo >&2; else read -r -p "$1: " value; fi
  [ -n "$value" ] || { echo "empty" >&2; exit 1; }
  printf '%s' "$value"
}

base64 < "$P12" | tr -d '\n' | gh secret set APPLE_CERTIFICATE_P12 -R "$REPO"
ask "The .p12's password" secret | gh secret set APPLE_CERTIFICATE_PASSWORD -R "$REPO"
gh secret set APPLE_API_KEY -R "$REPO" < "$P8"
ask "App Store Connect API key id" | gh secret set APPLE_API_KEY_ID -R "$REPO"
ask "App Store Connect issuer id" | gh secret set APPLE_API_ISSUER -R "$REPO"
ask "Apple team id" | gh secret set APPLE_TEAM_ID -R "$REPO"

echo "Done. Names now set on $REPO:" >&2
gh secret list -R "$REPO"
