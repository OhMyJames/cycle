#!/bin/bash
# A stand-in for Docker's `sbx`, for the commands Cycle gives it, as its CLI reference has them:
#   sbx ls -q
#   sbx --no-input create --name NAME claude WORKSPACE [HOST:TARGET...]
#   sbx exec -i [-w DIR] [-e KEY=VALUE...] NAME COMMAND [ARG...]
# A "sandbox" here is a folder that is the agent's home, with each shared folder linked into it, and
# a command runs on this machine with that home and only the environment `-e` gave it. Where the
# real one keeps a sign-in outside the sandbox, this one points Claude Code at the scripted model.
set -u
state="$SBX_FAKE_STATE"
mkdir -p "$state"
[ "${1:-}" = "--no-input" ] && shift
command="${1:-}"
shift
case "$command" in
  ls)
    [ -f "$state/names" ] && cat "$state/names"
    exit 0
    ;;
  create)
    [ "$1" = "--name" ] || { echo "expected --name" >&2; exit 125; }
    name="$2"
    shift 3
    workspace="$1"
    shift
    home="$state/$name/home"
    mkdir -p "$home"
    for shared in "$@"; do
      target="$home/${shared#*:/home/agent/}"
      mkdir -p "$(dirname "$target")"
      ln -s "${shared%%:*}" "$target"
    done
    echo "$workspace" > "$state/$name/workspace"
    echo "$name" >> "$state/names"
    exit 0
    ;;
  exec)
    given=()
    workdir=""
    while :; do
      case "$1" in
        -i) shift ;;
        -w) workdir="$2"; shift 2 ;;
        -e) given+=("$2"); shift 2 ;;
        *) break ;;
      esac
    done
    name="$1"
    shift
    [ -d "$state/$name" ] || { echo "no such sandbox: $name" >&2; exit 125; }
    echo "$name $workdir $1" >> "$state/execs"
    cd "$workdir" || exit 125
    home="$state/$name/home"
    exec env -i PATH="$SBX_FAKE_PATH" HOME="$home" CLAUDE_CONFIG_DIR="$home/.claude" \
      ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 "${given[@]}" "$@"
    ;;
  *)
    echo "fake sbx: unknown command $command" >&2
    exit 125
    ;;
esac
