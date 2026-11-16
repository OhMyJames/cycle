#!/bin/bash
# A stand-in for Docker's `sbx`, for the commands Cycle gives it, as its CLI reference has them:
#   sbx ls -q
#   sbx --no-input create --name NAME [--cpus N] [--memory SIZE] [--env-file FILE] [-t TAG --pull never]
#       claude WORKSPACE [HOST:TARGET...]
#   sbx exec [-i] [-w DIR] [-e KEY=VALUE...] NAME COMMAND [ARG...]
#   sbx rm --force NAME
#   sbx template ls -q | save NAME TAG | rm TAG
#   sbx policy allow network --sandbox NAME HOSTS
#   sbx policy rm network --sandbox NAME --force --resource HOSTS
#   sbx secret ls --global -q | set SERVICE --force   (the secret on its input)
# A "sandbox" here is a folder that is the agent's home, with each shared folder linked into it, and
# a command runs on this machine with that home and only the environment the sandbox was made with
# and `-e` gave it. A saved sandbox is a copy of that home. Where the real one keeps a sign-in
# outside the sandbox, this one points Claude Code at the scripted model.
set -u
state="$SBX_FAKE_STATE"
mkdir -p "$state/templates"
[ "${1:-}" = "--no-input" ] && shift
command="${1:-}"
shift
echo "$command $*" >> "$state/asked"
case "$command" in
  ls)
    [ -f "$state/names" ] && cat "$state/names"
    exit 0
    ;;
  create)
    name="" template="" made=()
    while :; do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        --cpus|--memory) made+=("$1 $2"); shift 2 ;;
        --env-file) while read -r pair; do made+=("env $pair"); done < "$2"; shift 2 ;;
        -t) template="$2"; shift 2 ;;
        --pull) shift 2 ;;
        claude) shift; break ;;
        *) echo "fake sbx: unknown create option $1" >&2; exit 125 ;;
      esac
    done
    [ -n "$name" ] || { echo "expected --name" >&2; exit 125; }
    workspace="$1"
    shift
    home="$state/$name/home"
    mkdir -p "$home"
    if [ -n "$template" ]; then
      [ -d "$state/templates/$template" ] || { echo "no such template: $template" >&2; exit 125; }
      cp -R "$state/templates/$template/." "$home/"
    fi
    # Each shared folder is a link where the sandbox sees it. A real sandbox runs the agent at the
    # path inside; this one runs it here, so the folder's own name for it is linked as well.
    : > "$state/$name/mounts"
    project_host=""
    for shared in "$@"; do
      host="${shared%%:*}"
      where="${shared#*:}"
      printf '%s\t%s\n' "$host" "$where" >> "$state/$name/mounts"
      [ -z "$project_host" ] && project_host="$host"
      target="$home/${where#/home/agent/}"
      mkdir -p "$(dirname "$target")"
      ln -sfn "$host" "$target"
    done
    kept=""
    while IFS=$'\t' read -r host where; do
      case "$where" in /home/agent/.claude/projects/*) kept="$home/${where#/home/agent/}" ;; esac
    done < "$state/$name/mounts"
    if [ -n "$project_host" ] && [ -n "$kept" ]; then
      # Claude Code names the folder by the path it resolves, which a link here is not.
      own=$(cd "$project_host" 2>/dev/null && pwd -P || printf '%s' "$project_host")
      own=$(printf '%s' "$own" | sed 's/[^a-zA-Z0-9]/-/g')
      mkdir -p "$home/.claude/projects"
      ln -sfn "$kept" "$home/.claude/projects/$own"
    fi
    echo "$workspace" > "$state/$name/workspace"
    printf '%s\n' "${made[@]:-}" > "$state/$name/made"
    echo "$name" >> "$state/names"
    exit 0
    ;;
  rm)
    [ "$1" = "--force" ] && shift
    rm -rf "${state:?}/$1"
    grep -vx "$1" "$state/names" > "$state/names.new" || true
    mv "$state/names.new" "$state/names"
    exit 0
    ;;
  template)
    case "$1" in
      ls) ls "$state/templates"; exit 0 ;;
      save)
        mkdir -p "$state/templates/$3"
        # What is shared into a sandbox is not the sandbox's own, and is not saved with it.
        (cd "$state/$2/home" && tar cf - --exclude ./.claude/projects .) | (cd "$state/templates/$3" && tar xf -)
        exit 0
        ;;
      rm) rm -rf "${state:?}/templates/$2"; exit 0 ;;
    esac
    ;;
  policy)
    # allow network --sandbox NAME HOSTS  |  rm network --sandbox NAME --force --resource HOSTS
    [ -d "$state/$4" ] || { echo "no such sandbox: $4" >&2; exit 125; }
    echo "$1 ${!#}" >> "$state/$4/network"
    exit 0
    ;;
  secret)
    case "$1" in
      ls) [ -f "$state/secrets" ] && cut -d' ' -f1 "$state/secrets"; exit 0 ;;
      set) echo "$2 $(cat)" >> "$state/secrets"; exit 0 ;;
    esac
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
    inside="$workdir"
    # The agent's path inside is translated to where that folder is here.
    if [ -n "$workdir" ] && [ -f "$state/$name/mounts" ]; then
      while IFS=$'\t' read -r host where; do
        case "$workdir" in
          "$where"|"$where"/*) workdir="$host${workdir#"$where"}"; break ;;
        esac
      done < "$state/$name/mounts"
    fi
    echo "$name $inside $1" >> "$state/execs"
    cd "$workdir" || exit 125
    home="$state/$name/home"
    while read -r kind pair; do
      [ "$kind" = "env" ] && given+=("$pair")
    done < "$state/$name/made"
    exec env -i PATH="$SBX_FAKE_PATH" HOME="$home" CLAUDE_CONFIG_DIR="$home/.claude" \
      ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 "${given[@]}" "$@"
    ;;
esac
echo "fake sbx: unknown command $command $*" >&2
exit 125
