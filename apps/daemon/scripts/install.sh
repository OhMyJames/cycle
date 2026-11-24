#!/bin/sh
# Installs the daemon from this folder (the one in the tarball) for the current user:
#
#   <prefix>/share/cycle/{cycle,claude,codex,codex-code-mode-host}   the program and the agents' binaries it drives
#   <prefix>/bin/cycle                           a one-line launcher that runs it
#
# <prefix> is $CYCLE_PREFIX, or ~/.local. Nothing needs root, and nothing is started: the daemon
# starts itself, detached, when a client connects (`cycle proxy`, which is what the app runs over
# ssh). A daemon that is already running keeps running the old files until it is stopped.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
platform=$(uname -s)
machine=$(uname -m)
case "$platform/$machine" in
  Linux/x86_64) package=cycle-linux-x64 ;;
  Linux/aarch64|Linux/arm64) package=cycle-linux-arm64 ;;
  Darwin/arm64|Darwin/x86_64)
    # Local builds on macOS also ship this script beside their binaries.
    [ -f "$here/cycle" ] && [ "$#" -eq 0 ] || { echo "The release installer requires Linux" >&2; exit 1; }
    if [ "$machine" = arm64 ]; then package=cycle-darwin-arm64; else package=cycle-darwin-x64; fi ;;
  *) echo "Unsupported daemon platform: $platform $machine (Linux releases support x86_64 and aarch64)" >&2; exit 1 ;;
esac
# The standalone release installer can use adjacent archives offline or fetch a pinned release.
if [ ! -f "$here/cycle" ] || [ "$#" -gt 0 ]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  cd "$work"
  if [ "$#" -eq 0 ]; then
    cp "$here/$package.tar.gz" "$here/$package.tar.gz.sha256" .
  else
    tag=$1
    case "$tag" in v[0-9]*) ;; *) echo "Expected a release tag such as v0.3.1" >&2; exit 1 ;; esac
    url="https://github.com/OhMyJames/cycle/releases/download/$tag/$package.tar.gz"
    curl -fsSLO "$url"
    curl -fsSLO "$url.sha256"
  fi
  sha256sum -c "$package.tar.gz.sha256"
  tar xzf "$package.tar.gz"
  here="$work/$package"
else
  case "${here##*/}" in
    "$package") ;;
    cycle-linux-*|cycle-darwin-*) echo "This machine needs $package, found ${here##*/}" >&2; exit 1 ;;
  esac
fi
prefix=${CYCLE_PREFIX:-$HOME/.local}
dest=$prefix/share/cycle
mkdir -p "$dest" "$prefix/bin"

# The daemon, and each agent's binary the build ships beside it (a test holds this list to src/harnesses.ts).
mkdir -p "$dest/codex-resources/licenses"
cp "$here/codex-resources/licenses/"* "$dest/codex-resources/licenses/"
if [ "$platform" = Linux ]; then
  cp "$here/codex-resources/bwrap" "$dest/codex-resources/.bwrap.new"
  chmod 755 "$dest/codex-resources/.bwrap.new"
  mv -f "$dest/codex-resources/.bwrap.new" "$dest/codex-resources/bwrap"
fi
for file in cycle claude codex codex-code-mode-host; do
  [ -f "$here/$file" ] || { echo "$here/$file is missing: run this from the unpacked tarball" >&2; exit 1; }
  # Copy beside, then rename over: replacing a file a running daemon is executing would fail otherwise.
  cp "$here/$file" "$dest/.$file.new"
  chmod 755 "$dest/.$file.new"
  mv -f "$dest/.$file.new" "$dest/$file"
done

# A launcher, not a symlink: the daemon finds its agents' binaries beside its own real path.
cat > "$prefix/bin/cycle.new" <<EOF
#!/bin/sh
exec "$dest/cycle" "\$@"
EOF
chmod 755 "$prefix/bin/cycle.new"
mv -f "$prefix/bin/cycle.new" "$prefix/bin/cycle"

echo "Installed: $dest"
echo "Launcher:  $prefix/bin/cycle"
case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *) echo "Note: $prefix/bin is not on this shell's PATH. In the app's host, give the command as the full path: $prefix/bin/cycle proxy" ;;
esac
echo "Next: put Claude's credentials in ${CYCLE_HOME:-~/.cycle}/config.json, or run: $prefix/bin/cycle login"
