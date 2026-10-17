#!/bin/bash
# start-gmat-prep-mac.sh: starts GMAT prep on the Mac with its LLM tasks on
# the local LLM server (scripts/local-llm/setup-llm-server.sh). It opens a
# restricted SSH tunnel to the server, starts the app, sets the app's LLM
# settings through the app's own API, and stops both on Ctrl+C.
#
# It runs on the bash 3.2 that macOS ships and uses only tools a Mac has,
# plus Bun, which the app needs anyway. See docs/local-llm.md.

set -Eeuo pipefail

SCRIPT_VERSION="1.0.0"
MIN_BUN_VERSION="1.4.2"

# The model names the server's llama-swap config uses, and the tasks each
# one serves. Generation, approaches and lessons stay on the cloud model.
MODEL_FAST="qwen3.5-4b"
MODEL_REASON="qwen3.6-35b-a3b"
FAST_TASKS="tagging statement-translation tutor-chat"
REASON_TASKS="solving book-map extraction"
CLOUD_TASKS="generation approaches lessons"

CONFIG_DIR="$HOME/.config/gmat-prep"
CONFIG_FILE="$CONFIG_DIR/llm-server.conf"
KNOWN_HOSTS="$CONFIG_DIR/llm-server-known_hosts"
API_KEY_FILE="$CONFIG_DIR/llm-api-key"
RUN_DIR="$CONFIG_DIR/run"
TUNNEL_PID_FILE="$RUN_DIR/tunnel.pid"
APP_PID_FILE="$RUN_DIR/app.pid"
KEY_FILE="$HOME/.ssh/gmat_llm_ed25519"
HOST_KEY_ALIAS="gmat-llm-server"
TUNNEL_USER="gmat-tunnel"
SERVER_TOOL="/opt/gmat-llm/bin/gmat-llm"

# Settings kept in CONFIG_FILE between runs.
SERVER_NAME=""
SERVER_ADDRESS=""
SSH_PORT="22"
ADMIN_USER=""
REMOTE_PORT="18100"
LOCAL_PORT="18100"
CONFIGURED=""

# Options.
MODE="start"
CONFIGURE_URL=""
OPT_PAIR=0
OPT_RECONFIGURE=0
OPT_ALL_LOCAL=0
OPT_NO_BROWSER=0
OPT_NO_TEST=0
OPT_YES=0
OPT_JSON_MODE=""
OPT_CLOUD_BASE_URL=""
GIVEN_OPTIONS=""

# State of this run.
IS_MAC=0
REPO_DIR=""
BUN=""
LOG_DIR=""
APP_LOG=""
APP_URL=""
APP_PID=""
APP_STARTED=0
TUNNEL_PID=""
TUNNEL_STARTED=0
API_KEY=""
COOKIE_JAR=""
WORK_DIR=""
CONTROL_SOCKET=""
CONTROL_DIR=""
CONNECT_TIMES=""
SERVER_MODELS=""
HAVE_TTY=0
CLEANED_UP=0

PINNED_OPTS=(-p 22)
TUNNEL_ERROR=""
TAB=$(printf '\t')

if [ "$(uname -s)" = "Darwin" ]; then IS_MAC=1; fi
if [ -t 0 ] && { : </dev/tty; } 2>/dev/null; then HAVE_TTY=1; fi

# ---------------------------------------------------------------------------
# Output, prompts and cleanup
# ---------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}
step() { printf '\n== %s ==\n' "$*"; }

on_error() {
  local code=$1 line=$2 command=$3
  # A failure inside a command substitution is reported once, by the shell
  # that ran it.
  if [ "$BASH_SUBSHELL" -gt 0 ]; then exit "$code"; fi
  trap - ERR
  printf '\nError: stopped (exit code %s) at line %s: %s\n' "$code" "$line" "$command" >&2
  if [ -n "$APP_LOG" ]; then printf 'The app log is %s.\n' "$APP_LOG" >&2; fi
  exit "$code"
}

# Stops what this run started: the app, then the tunnel.
cleanup() {
  if [ "$CLEANED_UP" = 1 ]; then return 0; fi
  CLEANED_UP=1
  trap - ERR
  if [ "$APP_STARTED" = 1 ] && [ -n "$APP_PID" ]; then
    stop_process "$APP_PID" "the app"
    rm -f "$APP_PID_FILE"
  fi
  if [ "$TUNNEL_STARTED" = 1 ] && [ -n "$TUNNEL_PID" ]; then
    stop_process "$TUNNEL_PID" "the tunnel"
    rm -f "$TUNNEL_PID_FILE"
  fi
  if [ -n "$CONTROL_SOCKET" ] && [ -S "$CONTROL_SOCKET" ]; then
    ssh -S "$CONTROL_SOCKET" -O exit x >/dev/null 2>&1 || true
  fi
  if [ -n "$CONTROL_DIR" ] && [ -d "$CONTROL_DIR" ]; then rm -rf "$CONTROL_DIR"; fi
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi
}

on_signal() {
  printf '\nStopping.\n'
  cleanup
  exit 130
}

# Asks a yes or no question; DEFAULT is y or n. --yes takes the default.
confirm() {
  local question=$1 default=${2:-n} hint="[y/N]" answer=""
  if [ "$default" = y ]; then hint="[Y/n]"; fi
  if [ "$OPT_YES" = 1 ]; then
    printf '%s %s %s (--yes)\n' "$question" "$hint" "$default"
    [ "$default" = y ]
    return
  fi
  if [ "$HAVE_TTY" != 1 ]; then
    die "A question needs an answer but there is no terminal: \"$question\". Run in Terminal, or pass --yes."
  fi
  while true; do
    printf '%s %s ' "$question" "$hint" >/dev/tty
    IFS= read -r answer </dev/tty || answer=""
    if [ -z "$answer" ]; then answer=$default; fi
    case "$answer" in
      y | Y | yes | Yes | YES) return 0 ;;
      n | N | no | No | NO) return 1 ;;
      *) printf 'Please answer y or n.\n' >/dev/tty ;;
    esac
  done
}

# Reads a line from the terminal into the variable named by $1. Without a
# terminal the default is taken when one is given, even an empty one.
ask() {
  local name=$1 question=$2 default=${3:-} has_default=0 answer=""
  if [ $# -ge 3 ]; then has_default=1; fi
  if [ "$HAVE_TTY" != 1 ]; then
    if [ "$has_default" = 1 ]; then
      eval "$name=\$default"
      return 0
    fi
    die "A question needs an answer but there is no terminal: \"$question\"."
  fi
  if [ -n "$default" ]; then
    printf '%s [%s] ' "$question" "$default" >/dev/tty
  else
    printf '%s ' "$question" >/dev/tty
  fi
  IFS= read -r answer </dev/tty || answer=""
  if [ -z "$answer" ]; then answer=$default; fi
  eval "$name=\$answer"
}

# Reads a secret from the terminal without echoing it.
ask_secret() {
  local name=$1 question=$2 answer=""
  [ "$HAVE_TTY" = 1 ] || die "A secret is needed but there is no terminal: \"$question\"."
  printf '%s ' "$question" >/dev/tty
  stty -echo </dev/tty 2>/dev/null || true
  IFS= read -r answer </dev/tty || answer=""
  stty echo </dev/tty 2>/dev/null || true
  printf '\n' >/dev/tty
  eval "$name=\$answer"
}

# Sends SIGTERM to a process, waits up to 15 seconds, then SIGKILL.
stop_process() {
  local pid=$1 what=$2 i=0
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM "$pid" 2>/dev/null || return 0
  while [ "$i" -lt 15 ]; do
    kill -0 "$pid" 2>/dev/null || {
      info "Stopped $what (process $pid)."
      return 0
    }
    sleep 1
    i=$((i + 1))
  done
  kill -KILL "$pid" 2>/dev/null || true
  info "Killed $what (process $pid), which did not stop in 15 seconds."
}

have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<EOF
Usage: scripts/local-llm/start-gmat-prep-mac.sh [options]

Starts GMAT prep with its LLM tasks on your local LLM server: finds the
server on the network, opens a restricted SSH tunnel to it, starts the app,
sets the app's LLM settings and opens the browser. Ctrl+C stops the app and
the tunnel. The first run pairs the Mac with the server.

Options:
  --configure-only [URL]  only set the LLM settings of the app running at URL
                          (default: the running app's address); no tunnel or
                          app is started
  --stop                  stop the app and tunnel an earlier run started
  --server NAME           the server's host name (asked on the first run)
  --address IP            the server's address, if it cannot be found
  --ssh-port N            the server's SSH port (default 22)
  --admin-user NAME       your own SSH login on the server, used to install
                          this Mac's tunnel key and read the API key
  --local-port N          the Mac end of the tunnel (default 18100)
  --remote-port N         the server's LLM endpoint port (default 18100)
  --pair                  pair again: new host key check and key install
  --reconfigure           set the app's LLM settings even if they look current
  --all-local             also send generation, approaches and lessons to the
                          local 35B-A3B model instead of the cloud model
  --cloud-base-url URL    the cloud API to send generation, approaches and
                          lessons to, when the app does not already name one
  --json-mode MODE        json-schema (default), json-object or instructions
  --no-browser            do not open the browser
  --no-test               skip the app's connection test after configuring
  --yes                   take the default answer to every question
  -h, --help              show this help

Environment:
  GMAT_PREP_PORT, GMAT_PREP_DATA_DIR, GMAT_PREP_CONFIG_DIR are passed to the
  app as usual. GMAT_PREP_PASSPHRASE gives the Curator passphrase without a
  prompt, for automation.
EOF
}

# ---------------------------------------------------------------------------
# Arguments and saved settings
# ---------------------------------------------------------------------------

valid_port() {
  case "$1" in
    "" | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1024 ] && [ "$1" -le 65000 ]
}

parse_args() {
  local option=""
  while [ $# -gt 0 ]; do
    option=$1
    case "$option" in
      --configure-only)
        MODE="configure"
        if [ $# -ge 2 ]; then
          case "$2" in
            http://* | https://*)
              CONFIGURE_URL=$2
              shift
              ;;
          esac
        fi
        shift
        ;;
      --stop)
        MODE="stop"
        shift
        ;;
      --server | --address | --ssh-port | --admin-user | --local-port | --remote-port | --json-mode | --cloud-base-url)
        [ $# -ge 2 ] || die "$option needs a value (see --help)."
        GIVEN_OPTIONS="$GIVEN_OPTIONS ${option#--} "
        case "$option" in
          --server) SERVER_NAME=$2 ;;
          --address) SERVER_ADDRESS=$2 ;;
          --ssh-port) SSH_PORT=$2 ;;
          --admin-user) ADMIN_USER=$2 ;;
          --local-port) LOCAL_PORT=$2 ;;
          --remote-port) REMOTE_PORT=$2 ;;
          --json-mode) OPT_JSON_MODE=$2 ;;
          --cloud-base-url) OPT_CLOUD_BASE_URL=$2 ;;
        esac
        shift 2
        ;;
      --pair)
        OPT_PAIR=1
        shift
        ;;
      --reconfigure)
        OPT_RECONFIGURE=1
        shift
        ;;
      --all-local)
        OPT_ALL_LOCAL=1
        shift
        ;;
      --no-browser)
        OPT_NO_BROWSER=1
        shift
        ;;
      --no-test)
        OPT_NO_TEST=1
        shift
        ;;
      --yes | -y)
        OPT_YES=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "Unknown option: $option (see --help)" ;;
    esac
  done
  valid_port "$LOCAL_PORT" || die "--local-port must be a number from 1024 to 65000."
  valid_port "$REMOTE_PORT" || die "--remote-port must be a number from 1024 to 65000."
  case "$SSH_PORT" in "" | *[!0-9]*) die "--ssh-port must be a number." ;; esac
  case "$OPT_JSON_MODE" in "" | json-schema | json-object | instructions) ;; *) die "--json-mode must be json-schema, json-object or instructions." ;; esac
  case "$SERVER_NAME" in *[!A-Za-z0-9.-]*) die "--server must be a host name." ;; esac
  case "$SERVER_ADDRESS" in *[!0-9A-Za-z.:-]*) die "--address must be an IP address or host name." ;; esac
  case "$ADMIN_USER" in *[!A-Za-z0-9._-]*) die "--admin-user must be a user name." ;; esac
}

given() {
  case "$GIVEN_OPTIONS" in *" $1 "*) return 0 ;; esac
  return 1
}

# Reads KEY=value lines this script wrote, accepting known keys only.
load_config() {
  local key="" value=""
  [ -f "$CONFIG_FILE" ] || return 0
  while IFS='=' read -r key value; do
    case "$value" in *[!A-Za-z0-9._:,/@-]*) continue ;; esac
    # An option given on the command line wins over the saved value.
    case "$key" in
      SERVER_NAME) given server || SERVER_NAME=$value ;;
      SERVER_ADDRESS) given address || SERVER_ADDRESS=$value ;;
      SSH_PORT) given ssh-port || SSH_PORT=${value:-22} ;;
      ADMIN_USER) given admin-user || ADMIN_USER=$value ;;
      REMOTE_PORT) given remote-port || REMOTE_PORT=${value:-18100} ;;
      LOCAL_PORT) given local-port || LOCAL_PORT=${value:-18100} ;;
      CONFIGURED) CONFIGURED=$value ;;
    esac
  done <"$CONFIG_FILE"
}

save_config() {
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  {
    printf '# Written by start-gmat-prep-mac.sh %s.\n' "$SCRIPT_VERSION"
    printf 'SERVER_NAME=%s\n' "$SERVER_NAME"
    printf 'SERVER_ADDRESS=%s\n' "$SERVER_ADDRESS"
    printf 'SSH_PORT=%s\n' "$SSH_PORT"
    printf 'ADMIN_USER=%s\n' "$ADMIN_USER"
    printf 'REMOTE_PORT=%s\n' "$REMOTE_PORT"
    printf 'LOCAL_PORT=%s\n' "$LOCAL_PORT"
    printf 'CONFIGURED=%s\n' "$CONFIGURED"
  } >"$CONFIG_FILE.tmp"
  mv -f "$CONFIG_FILE.tmp" "$CONFIG_FILE"
}

# ---------------------------------------------------------------------------
# Step 1: the repo, Bun, dependencies and the web build
# ---------------------------------------------------------------------------

find_repo() {
  local dir=""
  dir=$(cd "$(dirname "$0")/../.." && pwd -P)
  [ -f "$dir/package.json" ] && [ -f "$dir/src/server/main.ts" ] || die "This script must stay in scripts/local-llm of the gmat-prep repo; $dir is not the repo."
  grep -q '"name": "gmat-prep"' "$dir/package.json" || die "$dir does not look like the gmat-prep repo."
  REPO_DIR=$dir
}

# Whether version $1 is at least version $2 (dotted numbers).
version_at_least() {
  local have=$1 want=$2 h="" w="" i=1
  while [ "$i" -le 3 ]; do
    h=$(printf '%s' "$have" | cut -d. -f"$i")
    w=$(printf '%s' "$want" | cut -d. -f"$i")
    h=${h%%[!0-9]*}
    w=${w%%[!0-9]*}
    h=${h:-0}
    w=${w:-0}
    if [ "$h" -gt "$w" ]; then return 0; fi
    if [ "$h" -lt "$w" ]; then return 1; fi
    i=$((i + 1))
  done
  return 0
}

ensure_bun() {
  local version=""
  if have bun; then
    BUN=$(command -v bun)
  elif [ -x "$HOME/.bun/bin/bun" ]; then
    BUN="$HOME/.bun/bin/bun"
  fi
  if [ -z "$BUN" ]; then
    say "Bun is not installed. The app runs on Bun $MIN_BUN_VERSION or later."
    confirm "Install Bun $MIN_BUN_VERSION with Bun's official installer (curl -fsSL https://bun.com/install | bash -s bun-v$MIN_BUN_VERSION)?" y || die "Install Bun from https://bun.com and run this script again."
    curl -fsSL https://bun.com/install | bash -s "bun-v$MIN_BUN_VERSION"
    BUN="$HOME/.bun/bin/bun"
    [ -x "$BUN" ] || die "The Bun installer did not leave $BUN."
  fi
  version=$("$BUN" --version 2>/dev/null || true)
  version_at_least "$version" "$MIN_BUN_VERSION" || die "Bun $version is older than $MIN_BUN_VERSION; update it with: bun upgrade"
  info "Bun $version ($BUN)"
  PATH="$(dirname "$BUN"):$PATH"
  export PATH
}

# Whether any file under the given paths is newer than the marker file.
newer_than() {
  local marker=$1 path="" found=""
  shift
  [ -e "$marker" ] || return 0
  for path in "$@"; do
    [ -e "$path" ] || continue
    found=$(find "$path" -newer "$marker" -type f 2>/dev/null | sed -n 1p)
    if [ -n "$found" ]; then return 0; fi
  done
  return 1
}

prepare_app() {
  step "1. The app"
  find_repo
  info "Repo: $REPO_DIR"
  ensure_bun
  if [ ! -d "$REPO_DIR/node_modules" ] || newer_than "$REPO_DIR/node_modules/.gmat-prep-installed" "$REPO_DIR/package.json" "$REPO_DIR/bun.lock"; then
    say "Installing the app's dependencies (bun install)."
    (cd "$REPO_DIR" && "$BUN" install)
    : >"$REPO_DIR/node_modules/.gmat-prep-installed"
  else
    info "Dependencies are installed."
  fi
  if [ ! -f "$REPO_DIR/web/dist/index.html" ] || newer_than "$REPO_DIR/web/dist/index.html" "$REPO_DIR/web/src" "$REPO_DIR/web/index.html" "$REPO_DIR/web/public" "$REPO_DIR/web/vite.config.ts" "$REPO_DIR/src/api" "$REPO_DIR/package.json" "$REPO_DIR/bun.lock"; then
    say "Building the web app (bun run build:web)."
    (cd "$REPO_DIR" && "$BUN" run build:web)
  else
    info "The web app is built."
  fi
}

# ---------------------------------------------------------------------------
# Step 2: old tunnels and forwarding on this Mac
# ---------------------------------------------------------------------------

# Ports local LLM stacks use by default (Ollama, llama.cpp, LM Studio, vLLM,
# Open WebUI, LiteLLM, text-generation-webui, KoboldCpp, SGLang, Jan).
LLM_PORTS="11434 9931 8080 8000 8001 8081 1234 3000 4000 5000 5001 7860 7861 30000 39281"

forward_has_llm_port() {
  local text=$1 port="" p=""
  for port in $(printf '%s' "$text" | grep -oE '[0-9]{2,5}' || true); do
    for p in $LLM_PORTS; do
      if [ "$port" = "$p" ]; then return 0; fi
    done
  done
  return 1
}

# The forwarding options in an ssh or autossh command line, or nothing.
forward_options() {
  local line=$1 word="" next="" out="" rest="" letter="" i=0
  set -f
  # shellcheck disable=SC2086 # split into words without globbing (set -f)
  set -- $line
  set +f
  shift
  for word in "$@"; do
    if [ -n "$next" ]; then
      case "$next" in
        L | R | D) out="$out $next $word" ;;
        o) case "$word" in [Ll]ocal[Ff]orward* | [Rr]emote[Ff]orward* | [Dd]ynamic[Ff]orward*) out="$out -o $word" ;; esac ;;
      esac
      next=""
      continue
    fi
    case "$word" in
      --* | -) continue ;;
      -*) ;;
      *) continue ;;
    esac
    rest=${word#-}
    i=0
    while [ "$i" -lt "${#rest}" ]; do
      letter=${rest:$i:1}
      case "$letter" in
        N) out="$out -N" ;;
        B | b | c | D | E | e | F | I | i | J | L | l | m | O | o | p | Q | R | S | W | w)
          if [ $((i + 1)) -lt "${#rest}" ]; then
            case "$letter" in
              L | R | D) out="$out $letter ${rest:$((i + 1))}" ;;
              o) case "${rest:$((i + 1))}" in [Ll]ocal[Ff]orward* | [Rr]emote[Ff]orward* | [Dd]ynamic[Ff]orward*) out="$out -o ${rest:$((i + 1))}" ;; esac ;;
            esac
          else
            next=$letter
          fi
          break
          ;;
      esac
      i=$((i + 1))
    done
  done
  printf '%s' "${out# }"
}

is_own_tunnel() {
  case "$1" in *"$KEY_FILE"*) return 0 ;; esac
  return 1
}

stop_old_tunnel_processes() {
  local line="" pid="" user="" cmd="" prog="" opts="" default="" found=0
  while read -r pid user cmd; do
    [ -n "$pid" ] || continue
    prog=$(basename "$(printf '%s' "$cmd" | awk '{print $1}')")
    case "$prog" in ssh | autossh) ;; *) continue ;; esac
    is_own_tunnel "$cmd" && continue
    opts=$(forward_options "$cmd")
    [ -n "$opts" ] || continue
    found=1
    if forward_has_llm_port "$opts"; then default=y; else default=n; fi
    say "SSH tunnel process $pid ($user): $cmd"
    if [ "$default" = y ]; then
      if confirm "It forwards a port local LLM tools use. Stop it?" y; then stop_process "$pid" "the old tunnel"; fi
    else
      if confirm "It is not identified as an LLM tunnel. Stop it anyway?" n; then stop_process "$pid" "the old tunnel"; fi
    fi
  done <<EOF
$(ps -axo pid=,user=,command= 2>/dev/null || true)
EOF
  if [ "$found" = 0 ]; then info "No SSH tunnel processes."; fi
}

# LaunchAgents that run ssh or autossh keep old tunnels coming back.
stop_old_launch_agents() {
  local plist="" label="" args="" backup="" found=0
  [ "$IS_MAC" = 1 ] || return 0
  for plist in "$HOME"/Library/LaunchAgents/*.plist; do
    [ -f "$plist" ] || continue
    args=$(plutil -p "$plist" 2>/dev/null || true)
    case "$args" in *'"ssh'* | *'/ssh"'* | *autossh*) ;; *) continue ;; esac
    label=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$plist" 2>/dev/null || basename "$plist" .plist)
    case "$label" in *gmat-prep*) continue ;; esac
    found=1
    say "LaunchAgent $label ($plist) runs ssh:"
    printf '%s\n' "$args" | sed -n '/ProgramArguments/,/]/p' | sed 's/^/    /'
    if confirm "Stop it and move its file to the backup folder, so it does not start at login?" "$(if forward_has_llm_port "$args"; then printf y; else printf n; fi)"; then
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
      backup="$CONFIG_DIR/backup/$(date +%Y%m%d-%H%M%S)"
      mkdir -p "$backup"
      mv -f "$plist" "$backup/"
      info "Stopped $label; its file is in $backup (move it back to ~/Library/LaunchAgents to restore it)."
    fi
  done
  if [ "$found" = 0 ]; then info "No LaunchAgents that run ssh."; fi
  for plist in /Library/LaunchAgents/*.plist /Library/LaunchDaemons/*.plist; do
    [ -f "$plist" ] || continue
    if grep -q autossh "$plist" 2>/dev/null; then
      warn "$plist runs autossh for all users; remove it with sudo if it belongs to an old LLM setup."
    fi
  done
}

show_lines() {
  local file=$1 num=""
  for num in $2; do sed -n "${num}p" "$file" | sed 's/^/    /'; done
}

# Comments out LocalForward, RemoteForward and DynamicForward lines in the
# SSH client config. Lines that forward a port LLM tools use are commented
# out after asking (default yes); other lines only if you say so.
comment_out_forward_lines() {
  local cfg="" listing="" num="" text="" llm_nums="" other_nums="" chosen="" backup="" found=0
  for cfg in "$HOME/.ssh/config" "$HOME"/.ssh/config.d/*; do
    [ -f "$cfg" ] || continue
    case "$cfg" in *.backup-*) continue ;; esac
    listing=$(grep -niE '^[[:space:]]*(LocalForward|RemoteForward|DynamicForward)[[:space:]=]' "$cfg" 2>/dev/null || true)
    [ -n "$listing" ] || continue
    found=1
    llm_nums=""
    other_nums=""
    chosen=""
    while IFS=: read -r num text; do
      [ -n "$num" ] || continue
      if forward_has_llm_port "$text"; then llm_nums="$llm_nums $num"; else other_nums="$other_nums $num"; fi
    done <<EOF
$listing
EOF
    if [ -n "$llm_nums" ]; then
      say "Forwarding lines in $cfg that use ports local LLM tools use:"
      show_lines "$cfg" "$llm_nums"
      if confirm "Comment these lines out (the file is backed up first)?" y; then chosen="$chosen$llm_nums"; fi
    fi
    if [ -n "$other_nums" ]; then
      say "Other forwarding lines in $cfg:"
      show_lines "$cfg" "$other_nums"
      if confirm "They are not identified as LLM forwarding. Comment them out as well?" n; then chosen="$chosen$other_nums"; fi
    fi
    [ -n "$chosen" ] || continue
    backup="$cfg.backup-$(date +%Y%m%d-%H%M%S)"
    cp -p "$cfg" "$backup"
    awk -v nums="$chosen" '
      BEGIN { n = split(nums, list, " "); for (i = 1; i <= n; i++) pick[list[i]] = 1 }
      (FNR in pick) { print "# disabled by start-gmat-prep-mac.sh: " $0; next }
      { print }' "$backup" >"$WORK_DIR/ssh-config"
    # Written in place, so a config that is a link into a dotfiles folder
    # stays a link and keeps its permissions.
    cat "$WORK_DIR/ssh-config" >"$cfg"
    rm -f "$WORK_DIR/ssh-config"
    info "Commented them out; the old file is $backup."
  done
  if [ "$found" = 0 ]; then info "No forwarding lines in ~/.ssh/config."; fi
}

stop_old_forwarding() {
  step "2. Old SSH tunnels on this Mac"
  stop_old_tunnel_processes
  stop_old_launch_agents
  comment_out_forward_lines
}

# ---------------------------------------------------------------------------
# Step 3: finding and pairing with the server
# ---------------------------------------------------------------------------

# ufw on the server refuses a sixth SSH connection from one address within
# 30 seconds, so connections are spaced out when needed.
before_connect() {
  local now="" kept="" t="" count=0 oldest=""
  now=$(date +%s)
  for t in $CONNECT_TIMES; do
    if [ $((now - t)) -lt 30 ]; then
      kept="$kept $t"
      count=$((count + 1))
      [ -n "$oldest" ] || oldest=$t
    fi
  done
  if [ "$count" -ge 4 ] && [ -n "$oldest" ]; then
    info "Waiting $((31 - (now - oldest))) seconds so the server's SSH rate limit is not hit."
    sleep $((31 - (now - oldest)))
  fi
  CONNECT_TIMES="$kept $(date +%s)"
}

pinned_key() {
  [ -f "$KNOWN_HOSTS" ] || return 0
  awk -v alias="$HOST_KEY_ALIAS" '$1 == alias && $2 == "ssh-ed25519" {print $3; exit}' "$KNOWN_HOSTS"
}

# The ED25519 host key an address offers on the SSH port, or nothing.
host_key_of() {
  local address=$1
  before_connect
  ssh-keyscan -T 3 -p "$SSH_PORT" -t ed25519 "$address" 2>/dev/null | awk '$2 == "ssh-ed25519" {print $3; exit}' || true
}

key_fingerprint() {
  local tmp=""
  tmp="$WORK_DIR/key.pub"
  printf 'ssh-ed25519 %s\n' "$1" >"$tmp"
  ssh-keygen -l -f "$tmp" 2>/dev/null | awk '{print $2}'
}

# Converts a dotted IPv4 address to a number, and back.
ip_to_int() {
  local a="" b="" c="" d=""
  IFS=. read -r a b c d <<EOF
$1
EOF
  printf '%s' $(((a << 24) + (b << 16) + (c << 8) + d))
}

int_to_ip() {
  local n=$1
  printf '%s.%s.%s.%s' $(((n >> 24) & 255)) $(((n >> 16) & 255)) $(((n >> 8) & 255)) $((n & 255))
}

# Prints "address prefix" of the interface the default route uses.
local_network() {
  local iface="" addr="" mask="" prefix=0 n=0 bits=0
  if [ "$IS_MAC" = 1 ]; then
    iface=$(route -n get default 2>/dev/null | awk '/interface:/ {print $2}' || true)
    [ -n "$iface" ] || return 0
    addr=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
    mask=$(ifconfig "$iface" 2>/dev/null | awk '/inet / {for (i = 1; i <= NF; i++) if ($i == "netmask") print $(i + 1)}' | sed -n 1p || true)
    case "$mask" in
      0x*)
        n=$((mask))
        while [ "$n" -gt 0 ]; do
          bits=$((bits + (n & 1)))
          n=$((n >> 1))
        done
        prefix=$bits
        ;;
      *) prefix=24 ;;
    esac
  else
    iface=$(ip -4 -o route show default 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") print $(i + 1)}' | sed -n 1p || true)
    [ -n "$iface" ] || return 0
    mask=$(ip -4 -o addr show dev "$iface" scope global 2>/dev/null | awk '{print $4}' | sed -n 1p || true)
    case "$mask" in */*) ;; *) return 0 ;; esac
    addr=${mask%/*}
    prefix=${mask#*/}
  fi
  [ -n "$addr" ] || return 0
  printf '%s %s\n' "$addr" "$prefix"
}

# Whether a TCP port answers, waiting at most a second.
port_answers() {
  if [ "$IS_MAC" = 1 ]; then
    nc -z -G 1 -w 1 "$1" "$2" >/dev/null 2>&1
  else
    nc -z -w 1 "$1" "$2" >/dev/null 2>&1
  fi
}

# Addresses on this Mac's network with the SSH port open.
scan_network() {
  local net="" addr="" prefix="" ip=0 mask=0 first=0 last=0 n=0 count=0 own="" results=""
  net=$(local_network || true)
  [ -n "$net" ] || return 0
  addr=${net% *}
  prefix=${net#* }
  # Larger networks are scanned around this Mac's address only.
  if [ "$prefix" -lt 22 ]; then prefix=24; fi
  ip=$(ip_to_int "$addr")
  mask=$(((0xffffffff << (32 - prefix)) & 0xffffffff))
  first=$(((ip & mask) + 1))
  last=$(((ip & mask) + (1 << (32 - prefix)) - 2))
  own=$addr
  results="$WORK_DIR/scan"
  : >"$results"
  info "Scanning $(int_to_ip $((ip & mask)))/$prefix for SSH on port $SSH_PORT."
  n=$first
  while [ "$n" -le "$last" ]; do
    if [ "$(int_to_ip "$n")" != "$own" ]; then
      (if port_answers "$(int_to_ip "$n")" "$SSH_PORT"; then printf '%s\n' "$(int_to_ip "$n")" >>"$results"; fi) &
      count=$((count + 1))
      if [ "$count" -ge 64 ]; then
        wait
        count=0
      fi
    fi
    n=$((n + 1))
  done
  wait
  sort -t. -k4,4n "$results"
}

# Finds the server's address by its pinned host key: the last address, then
# NAME.local, then a scan of this network. Sets SERVER_ADDRESS, or returns 1.
locate_server() {
  local pinned="" key="" candidate=""
  pinned=$(pinned_key)
  [ -n "$pinned" ] || return 1
  for candidate in "$SERVER_ADDRESS" "${SERVER_NAME:+$SERVER_NAME.local}"; do
    [ -n "$candidate" ] || continue
    key=$(host_key_of "$candidate")
    if [ -n "$key" ] && [ "$key" = "$pinned" ]; then
      SERVER_ADDRESS=$candidate
      info "Found the server at $candidate."
      return 0
    fi
    if [ -n "$key" ]; then warn "$candidate answers with a different host key; skipping it."; fi
  done
  say "Looking for the server on this network."
  for candidate in $(scan_network); do
    key=$(host_key_of "$candidate")
    if [ -n "$key" ] && [ "$key" = "$pinned" ]; then
      SERVER_ADDRESS=$candidate
      info "Found the server at $candidate."
      return 0
    fi
  done
  return 1
}

find_server() {
  [ -n "$(pinned_key)" ] || die "The server's host key is not pinned yet; run with --pair."
  locate_server || die "The server was not found. Check that it is on, on the same hotspot, and that sshd runs; or give its address with --address IP."
}

# First pairing: finds candidate servers, shows their host keys, and pins the
# one the owner confirms.
pin_host_key() {
  local candidates="" candidate="" key="" fp="" chosen="" chosen_key=""
  if [ -z "$SERVER_NAME" ] && [ -z "$SERVER_ADDRESS" ]; then
    ask SERVER_NAME "The server's host name (setup printed it, as in NAME.local):"
    case "$SERVER_NAME" in *.local) SERVER_NAME=${SERVER_NAME%.local} ;; esac
  fi
  for candidate in "$SERVER_ADDRESS" "${SERVER_NAME:+$SERVER_NAME.local}"; do
    [ -n "$candidate" ] || continue
    key=$(host_key_of "$candidate")
    if [ -n "$key" ]; then
      candidates="$candidates $candidate=$key"
      break
    fi
  done
  if [ -z "$candidates" ]; then
    say "$SERVER_NAME.local did not answer; looking for SSH servers on this network."
    for candidate in $(scan_network); do
      key=$(host_key_of "$candidate")
      [ -n "$key" ] && candidates="$candidates $candidate=$key"
    done
  fi
  [ -n "$candidates" ] || die "No SSH server was found. Check the server is on and on the same network, or pass --address IP."
  for candidate in $candidates; do
    key=${candidate#*=}
    fp=$(key_fingerprint "$key")
    say "SSH server at ${candidate%%=*}, host key $fp"
    if confirm "Is this the fingerprint the server's setup printed (SSH host key, ED25519)?" n; then
      chosen=${candidate%%=*}
      chosen_key=$key
      break
    fi
  done
  [ -n "$chosen" ] || die "No server was confirmed. Compare against 'sudo gmat-llm status' on the server."
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  printf '%s ssh-ed25519 %s\n' "$HOST_KEY_ALIAS" "$chosen_key" >"$KNOWN_HOSTS"
  chmod 600 "$KNOWN_HOSTS"
  SERVER_ADDRESS=$chosen
  info "Pinned the server's host key in $KNOWN_HOSTS."
}

ensure_tunnel_key() {
  if [ -f "$KEY_FILE" ] && [ -f "$KEY_FILE.pub" ]; then
    info "Tunnel key: $KEY_FILE"
    return 0
  fi
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  # No passphrase: the script opens the tunnel without asking, and the
  # server lets this key do nothing but forward one port.
  ssh-keygen -q -t ed25519 -N '' -C "gmat-prep-mac@$(hostname -s 2>/dev/null || hostname)" -f "$KEY_FILE"
  info "Made the tunnel key $KEY_FILE."
}

# Options shared by every connection to the server: the pinned host key only.
set_pinned_options() {
  PINNED_OPTS=(-o "HostKeyAlias=$HOST_KEY_ALIAS" -o "UserKnownHostsFile=$KNOWN_HOSTS" -o "GlobalKnownHostsFile=/dev/null" -o "StrictHostKeyChecking=yes" -o "CheckHostIP=no" -o "ConnectTimeout=10" -p "$SSH_PORT")
}

# Runs a command on the server over your own SSH login, through one shared
# connection, so the SSH rate limit counts it once.
admin_ssh() {
  local tty_flag=$1
  shift
  set_pinned_options
  [ -n "$CONTROL_SOCKET" ] || die "Internal error: no SSH control socket path."
  # The socket path is fixed when the script starts, so a master started
  # from a subshell (a pipeline) is the same one the cleanup closes.
  if [ ! -S "$CONTROL_SOCKET" ]; then
    before_connect
    ssh "${PINNED_OPTS[@]}" -o ClearAllForwardings=yes -o ControlMaster=yes -o "ControlPath=$CONTROL_SOCKET" -o ControlPersist=120 -fN "$ADMIN_USER@$SERVER_ADDRESS" ||
      return 1
  fi
  ssh "${PINNED_OPTS[@]}" -o "ControlPath=$CONTROL_SOCKET" "$tty_flag" "$ADMIN_USER@$SERVER_ADDRESS" "$@"
}

# Installs this Mac's tunnel key on the server and reads the API key back,
# over the owner's SSH login, or tells the owner what to run there.
install_key_on_server() {
  local pub="" out="" key=""
  pub=$(cat "$KEY_FILE.pub")
  if [ -z "$ADMIN_USER" ]; then
    ask ADMIN_USER "Your own SSH login name on the server, to install the key with sudo (leave empty if you have none):" ""
  fi
  if [ -n "$ADMIN_USER" ]; then
    say "Installing the tunnel key over $ADMIN_USER@$SERVER_ADDRESS (sudo will ask for your server password)."
    if admin_ssh -t "sudo $SERVER_TOOL add-client '$pub' && umask 077 && sudo $SERVER_TOOL show-api-key > ~/.gmat-llm-api-key.tmp"; then
      out=$(admin_ssh -T 'cat ~/.gmat-llm-api-key.tmp; rm -f ~/.gmat-llm-api-key.tmp' || true)
      key=$(printf '%s\n' "$out" | tr -d '\r' | sed -n 's/^GMAT_LLM_API_KEY=//p' | sed -n 1p)
    else
      warn "The commands over SSH did not finish."
    fi
  fi
  if [ -z "$key" ]; then
    say ""
    say "Run these on the server, then come back here:"
    say "  sudo $SERVER_TOOL add-client '$pub'"
    say "  sudo $SERVER_TOOL show-api-key"
    ask_secret key "Paste the key it shows after GMAT_LLM_API_KEY= :"
    key=$(printf '%s' "$key" | tr -d '\r\n ' | sed 's/^GMAT_LLM_API_KEY=//')
  fi
  case "$key" in gmat-*) ;; *) die "That does not look like the server's API key (it starts with gmat-)." ;; esac
  store_api_key "$key"
}

store_api_key() {
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  (
    umask 077
    printf '%s\n' "$1" >"$API_KEY_FILE.tmp"
  )
  mv -f "$API_KEY_FILE.tmp" "$API_KEY_FILE"
  API_KEY=$1
  info "Saved the API key in $API_KEY_FILE (readable by you only)."
}

load_api_key() {
  if [ -z "$API_KEY" ] && [ -f "$API_KEY_FILE" ]; then
    API_KEY=$(sed -n 1p "$API_KEY_FILE" | tr -d '\r\n ')
  fi
  if [ -z "$API_KEY" ] && [ -n "${GMAT_LLM_API_KEY:-}" ]; then API_KEY=$GMAT_LLM_API_KEY; fi
}

pair() {
  step "3. Pairing with the server"
  ensure_tunnel_key
  if [ -z "$(pinned_key)" ] || [ "$OPT_PAIR" = 1 ]; then
    pin_host_key
  else
    find_server
  fi
  install_key_on_server
  save_config
}

# ---------------------------------------------------------------------------
# Step 4: the tunnel
# ---------------------------------------------------------------------------

local_port_in_use() {
  port_answers 127.0.0.1 "$1"
}

# The tunnel this script started earlier, if it is still running.
running_tunnel() {
  local pid="" cmd=""
  [ -f "$TUNNEL_PID_FILE" ] || return 1
  pid=$(sed -n 1p "$TUNNEL_PID_FILE")
  case "$pid" in "" | *[!0-9]*) return 1 ;; esac
  cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
  is_own_tunnel "$cmd" || return 1
  printf '%s' "$pid"
}

# Opens the tunnel and waits for the endpoint to answer through it. Returns 1
# with the reason in TUNNEL_ERROR instead of stopping the script.
start_tunnel() {
  local i=0 health=""
  TUNNEL_ERROR=""
  if local_port_in_use "$LOCAL_PORT"; then
    TUNNEL_ERROR="Port $LOCAL_PORT on this Mac is in use by another program; stop it or pass --local-port N."
    return 1
  fi
  mkdir -p "$RUN_DIR"
  set_pinned_options
  before_connect
  # -F /dev/null ignores ~/.ssh/config, so no old forwarding or proxy setting
  # applies; the server only accepts this exact forward from this key.
  ssh -F /dev/null -N -T "${PINNED_OPTS[@]}" \
    -i "$KEY_FILE" -o IdentitiesOnly=yes -o BatchMode=yes \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes \
    -o ControlMaster=no -o ControlPath=none \
    -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" \
    "$TUNNEL_USER@$SERVER_ADDRESS" >>"$LOG_DIR/tunnel.log" 2>&1 &
  TUNNEL_PID=$!
  TUNNEL_STARTED=1
  printf '%s\n' "$TUNNEL_PID" >"$TUNNEL_PID_FILE"
  while [ "$i" -lt 20 ]; do
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      TUNNEL_STARTED=0
      rm -f "$TUNNEL_PID_FILE"
      TUNNEL_ERROR="The tunnel closed: $(tail -n 3 "$LOG_DIR/tunnel.log" | tr '\n' ' ') If it says 'Permission denied', run with --pair to install the key again."
      return 1
    fi
    health=$(curl --noproxy '*' -s --max-time 3 "http://127.0.0.1:$LOCAL_PORT/health" 2>/dev/null || true)
    if [ "$health" = "OK" ]; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  TUNNEL_ERROR="The tunnel opened but the LLM endpoint does not answer; on the server run: sudo gmat-llm status"
  stop_process "$TUNNEL_PID" "the tunnel"
  TUNNEL_STARTED=0
  rm -f "$TUNNEL_PID_FILE"
  return 1
}

open_tunnel() {
  local old=""
  step "4. The tunnel"
  old=$(running_tunnel || true)
  if [ -n "$old" ]; then
    info "Stopping the tunnel an earlier run left open (process $old)."
    stop_process "$old" "the old tunnel"
  fi
  start_tunnel || die "$TUNNEL_ERROR"
  info "The tunnel is open: http://127.0.0.1:$LOCAL_PORT reaches the server's LLM endpoint."
}

# The model names the server offers, space-separated; fails without an
# answer.
read_server_models() {
  local out=""
  load_api_key
  [ -n "$API_KEY" ] || return 1
  out=$(curl --noproxy '*' -s --max-time 10 -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:$LOCAL_PORT/v1/models" 2>/dev/null) || return 1
  SERVER_MODELS=$(printf '%s' "$out" | json_eval 'const j = JSON.parse(input); if (!Array.isArray(j.data)) process.exit(1); print(j.data.map((m) => m.id).join(" "))') || return 1
}

check_api() {
  if read_server_models; then
    info "The endpoint accepts the API key and offers: $SERVER_MODELS"
  else
    die "The endpoint refused the API key or did not list its models. Run with --pair to read the key again."
  fi
}

# ---------------------------------------------------------------------------
# JSON, with Bun
# ---------------------------------------------------------------------------

# json_eval CODE: runs JavaScript with the standard input in `input` and a
# print() helper; extra values come in through GP_* environment variables.
json_eval() {
  local code=$1
  "$BUN" -e "const input = await Bun.stdin.text(); const print = (s) => process.stdout.write(String(s) + '\n'); $code"
}

# ---------------------------------------------------------------------------
# Step 5: the app and its LLM settings
# ---------------------------------------------------------------------------

app_data_dir() {
  if [ -n "${GMAT_PREP_DATA_DIR:-}" ]; then
    printf '%s' "$GMAT_PREP_DATA_DIR"
  elif [ "$IS_MAC" = 1 ]; then
    printf '%s' "$HOME/Library/Application Support/gmat-prep"
  else
    printf '%s' "${XDG_DATA_HOME:-$HOME/.local/share}/gmat-prep"
  fi
}

app_config_dir() {
  if [ -n "${GMAT_PREP_CONFIG_DIR:-}" ]; then
    printf '%s' "$GMAT_PREP_CONFIG_DIR"
  elif [ "$IS_MAC" = 1 ]; then
    printf '%s' "$HOME/Library/Preferences/gmat-prep"
  else
    printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/gmat-prep"
  fi
}

# The URL in the app's server.json when its process is alive, optionally only
# for one run id.
running_app_url() {
  local file="" want=${1:-}
  file="$(app_data_dir)/server.json"
  [ -f "$file" ] || return 1
  json_eval 'const j = JSON.parse(input); const want = process.env.GP_RUN; if (want && j.runId !== want) process.exit(1); try { process.kill(j.pid, 0) } catch { process.exit(1) } print(j.url); print(j.pid)' <"$file" 2>/dev/null
}

app_answers() {
  [ "$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 3 "$1/api/curator/status" 2>/dev/null || true)" = 200 ]
}

start_app() {
  local found="" run_id="" i=0
  step "5. The app"
  found=$(running_app_url || true)
  if [ -n "$found" ]; then
    APP_URL=$(printf '%s\n' "$found" | sed -n 1p)
    if app_answers "$APP_URL"; then
      info "GMAT prep is already running at $APP_URL (process $(printf '%s\n' "$found" | sed -n 2p)); using it."
      return 0
    fi
  fi
  run_id="mac-$(date +%s)-$$"
  APP_LOG="$LOG_DIR/app.log"
  say "Starting GMAT prep (log: $APP_LOG)."
  (cd "$REPO_DIR" && GMAT_PREP_RUN_ID="$run_id" exec "$BUN" src/server/main.ts) >>"$APP_LOG" 2>&1 &
  APP_PID=$!
  APP_STARTED=1
  mkdir -p "$RUN_DIR"
  printf '%s\n' "$APP_PID" >"$APP_PID_FILE"
  while [ "$i" -lt 60 ]; do
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      APP_STARTED=0
      rm -f "$APP_PID_FILE"
      die "The app stopped while starting: $(tail -n 5 "$APP_LOG" | tr '\n' ' ')"
    fi
    found=$(GP_RUN="$run_id" running_app_url "$run_id" || true)
    if [ -n "$found" ]; then
      APP_URL=$(printf '%s\n' "$found" | sed -n 1p)
      if app_answers "$APP_URL"; then
        info "GMAT prep is running at $APP_URL."
        return 0
      fi
    fi
    sleep 1
    i=$((i + 1))
  done
  die "The app did not answer within a minute; see $APP_LOG"
}

# api METHOD PATH [BODY]: a request to the app with the Curator cookie. Prints
# the HTTP status, a newline and the body. Requests to this Mac use
# --noproxy '*', so an http_proxy setting cannot send them elsewhere.
api() {
  local method=$1 path=$2 body=${3:-} out=""
  out="$WORK_DIR/response"
  : >"$out"
  if [ -n "$body" ]; then
    printf '%s' "$body" | curl --noproxy '*' -s -o "$out" -w '%{http_code}\n' --max-time 30 -X "$method" -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
      -H 'Content-Type: application/json' --data-binary @- "$APP_URL$path" || printf '000\n'
  else
    curl --noproxy '*' -s -o "$out" -w '%{http_code}\n' --max-time 30 -X "$method" -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$APP_URL$path" || printf '000\n'
  fi
  cat "$out"
}

status_of() { printf '%s\n' "$1" | sed -n 1p; }
body_of() { printf '%s\n' "$1" | sed '1d'; }

json_string() {
  GP_VALUE=$1 json_eval 'print(JSON.stringify({[process.env.GP_FIELD]: process.env.GP_VALUE}))' </dev/null
}

# Unlocks the Curator tools, or sets the passphrase on a fresh install.
unlock_curator() {
  local reply="" status="" body="" pass="" again="" tries=0 left=""
  reply=$(api GET /api/curator/status)
  [ "$(status_of "$reply")" = 200 ] || die "The app at $APP_URL did not answer /api/curator/status."
  body=$(body_of "$reply")
  if [ "$(printf '%s' "$body" | json_eval 'print(JSON.parse(input).passphraseSet)')" = "false" ]; then
    say "The Curator passphrase is not set yet; setting it now. It guards the Curator tools and the LLM settings."
    if [ -n "${GMAT_PREP_PASSPHRASE:-}" ]; then
      pass=$GMAT_PREP_PASSPHRASE
    else
      while true; do
        ask_secret pass "New Curator passphrase (8 to 200 characters):"
        ask_secret again "The same passphrase again:"
        if [ "$pass" != "$again" ]; then
          say "They differ; try again."
        elif [ "${#pass}" -lt 8 ] || [ "${#pass}" -gt 200 ]; then
          say "Use 8 to 200 characters."
        else
          break
        fi
      done
    fi
    reply=$(api POST /api/curator/passphrase "$(GP_FIELD=passphrase json_string "$pass")")
    status=$(status_of "$reply")
    case "$status" in
      204 | 200) info "Set the Curator passphrase; the Curator tools are unlocked." ;;
      409) die "A passphrase was set a moment ago by someone else; run this script again to unlock." ;;
      *) die "Setting the passphrase failed (HTTP $status): $(body_of "$reply")" ;;
    esac
    return 0
  fi
  while true; do
    if [ -n "${GMAT_PREP_PASSPHRASE:-}" ] && [ "$tries" -eq 0 ]; then
      pass=$GMAT_PREP_PASSPHRASE
    else
      ask_secret pass "Curator passphrase:"
    fi
    reply=$(api POST /api/curator/unlock "$(GP_FIELD=passphrase json_string "$pass")")
    status=$(status_of "$reply")
    body=$(body_of "$reply")
    case "$status" in
      204 | 200)
        info "Unlocked the Curator tools."
        return 0
        ;;
      401)
        left=$(printf '%s' "$body" | json_eval 'try { print(JSON.parse(input).attemptsLeft ?? "?") } catch { print("?") }')
        tries=$((tries + 1))
        [ "$HAVE_TTY" = 1 ] || die "The passphrase is wrong."
        say "That passphrase is wrong; $left tries left before the Curator tools lock for 5 minutes."
        ;;
      423) die "The Curator tools are locked for a few minutes after wrong passphrases; try again later." ;;
      409) die "The app has no passphrase yet; open it in the browser and set one, or run this script again." ;;
      *) die "Unlocking failed (HTTP $status): $body" ;;
    esac
  done
}

lock_curator() {
  api POST /api/curator/lock >/dev/null 2>&1 || true
}

# Reads the cloud API key the app holds now, if any.
current_app_api_key() {
  local file=""
  file="$(app_config_dir)/credentials.json"
  [ -f "$file" ] || return 0
  json_eval 'try { print(JSON.parse(input).apiKey ?? "") } catch { print("") }' <"$file" 2>/dev/null || true
}

# Whether a base URL points at this Mac, a private network or a .local name,
# like an old local LLM setup, rather than a cloud provider.
is_local_url() {
  case "$1" in
    http://127.* | https://127.* | http://localhost* | https://localhost* | http://\[::1\]* | *://10.* | *://192.168.* | *.local:* | *.local/*) return 0 ;;
    *://172.1[6-9].* | *://172.2[0-9].* | *://172.3[01].*) return 0 ;;
  esac
  return 1
}

contains_word() {
  local word="" want=$2
  for word in $1; do
    if [ "$word" = "$want" ]; then return 0; fi
  done
  return 1
}

# Sends the cloud models through the server: llama-swap passes them on to
# the cloud API with its key. Runs over the owner's SSH login, or tells the
# owner what to run on the server.
setup_cloud_peer() {
  local base_url=$1 models=$2 key="" ok=0
  key=$(current_app_api_key)
  if [ -z "$key" ] || [ "$key" = "$API_KEY" ]; then
    ask_secret key "The API key of $base_url, for generation, approaches and lessons:"
  fi
  [ -n "$key" ] || die "The cloud API key is needed to keep generation, approaches and lessons on $base_url; or run with --all-local."
  say "Generation, approaches and lessons use $models at $base_url. The app has one API address, so these requests"
  say "go through the tunnel and the server passes them on to $base_url with this key (kept on the server, readable by root only)."
  confirm "Store the cloud key on the server for this?" y || die "Without it those tasks cannot run through the server; run with --all-local to use the local model for them instead."
  if [ -z "$ADMIN_USER" ]; then
    ask ADMIN_USER "Your own SSH login name on the server (leave empty if you have none):" ""
  fi
  if [ -n "$ADMIN_USER" ]; then
    find_server_for_admin
    if printf '%s\n' "$key" | admin_ssh -T 'umask 077 && cat > ~/.gmat-llm-cloud-key.tmp' &&
      admin_ssh -t "sudo $SERVER_TOOL set-cloud --base-url '$base_url' --models '$models' --key-file ~/.gmat-llm-cloud-key.tmp; status=\$?; rm -f ~/.gmat-llm-cloud-key.tmp; exit \$status"; then
      ok=1
    else
      warn "Setting the cloud route on the server did not finish."
    fi
  fi
  if [ "$ok" != 1 ]; then
    say "Run this on the server and paste the cloud API key when it asks:"
    say "  sudo $SERVER_TOOL set-cloud --base-url '$base_url' --models '$models'"
    ask ok "Press Enter when it has finished." ""
  fi
  # The server restarts its endpoint; give it a moment.
  sleep 3
  read_server_models || true
}

find_server_for_admin() {
  if [ -z "$SERVER_ADDRESS" ]; then find_server; fi
}

# Builds the settings to save: local models for the local tasks, the cloud
# tasks kept unless --all-local, a price of 0 for local models and the
# 35B-A3B marked as reading images.
settings_payload() {
  GP_CURRENT=$1 GP_BASE_URL=$2 GP_JSON_MODE=$3 GP_FAST=$MODEL_FAST GP_REASON=$4 GP_FAST_TASKS=$FAST_TASKS \
    GP_REASON_TASKS=$REASON_TASKS GP_CLOUD_TASKS=$CLOUD_TASKS GP_ALL_LOCAL=$OPT_ALL_LOCAL GP_READS_IMAGES=$5 json_eval '
const current = JSON.parse(process.env.GP_CURRENT)
const tasks = current.models.map((m) => m.task)
const local = {}
for (const t of process.env.GP_FAST_TASKS.split(" ")) local[t] = process.env.GP_FAST
for (const t of process.env.GP_REASON_TASKS.split(" ")) local[t] = process.env.GP_REASON
if (process.env.GP_ALL_LOCAL === "1") for (const t of process.env.GP_CLOUD_TASKS.split(" ")) local[t] = process.env.GP_REASON
const localModels = new Set(Object.values(local))
const models = tasks.map((task) => ({ task, model: local[task] ?? (current.models.find((m) => m.task === task)?.model ?? null) }))
const used = [...new Set(models.map((m) => m.model).filter((m) => m !== null))]
const missingPrice = []
const prices = []
for (const model of used) {
  if (localModels.has(model)) { prices.push({ model, inputPerMillion: 0, outputPerMillion: 0 }); continue }
  const price = current.prices.find((p) => p.model === model)
  if (price) prices.push({ model, inputPerMillion: price.inputPerMillion, outputPerMillion: price.outputPerMillion })
  else missingPrice.push(model)
}
const readsImages = used.filter((m) => (localModels.has(m) ? m === process.env.GP_READS_IMAGES : current.readsImages.includes(m)))
if (missingPrice.length > 0) process.stderr.write("Warning: no price is saved for " + missingPrice.join(", ") + "; set it in Settings.\n")
print(JSON.stringify({ baseUrl: process.env.GP_BASE_URL, jsonMode: process.env.GP_JSON_MODE, models, prices, readsImages }))
' </dev/null
}

# What the saved settings were made from, so later runs can tell whether they
# need setting again.
configured_stamp() {
  # A checksum of the API key notices a new key without saving any of it.
  printf '%s,%s,%s,%s' "$LOCAL_PORT" "$OPT_ALL_LOCAL" "$1" "$(printf '%s' "$API_KEY" | cksum | awk '{print $1}')"
}

# Starts the app's own connection test for a task and waits for its result.
connection_test() {
  local task=$1 reply="" status="" id="" i=0 job="" state="" text="" misses=0
  reply=$(api POST /api/curator/jobs/connection-test "{\"task\":\"$task\"}")
  status=$(status_of "$reply")
  if [ "$status" != 200 ]; then
    warn "The app did not start a connection test (HTTP $status): $(body_of "$reply")"
    return 1
  fi
  id=$(body_of "$reply" | json_eval 'try { print(JSON.parse(input).id ?? "") } catch { print("") }' || true)
  if [ -z "$id" ]; then
    warn "The app started a connection test but its reply has no job id."
    return 1
  fi
  info "The app is testing $task; the first request loads the model on the server."
  while [ "$i" -lt 300 ]; do
    reply=$(api GET /api/curator/jobs)
    status=$(status_of "$reply")
    if [ "$status" != 200 ]; then
      misses=$((misses + 1))
      if [ "$misses" -ge 3 ]; then
        warn "The app stopped answering while it tested $task (HTTP $status)."
        return 1
      fi
      job="waiting$TAB"
    else
      misses=0
      job=$(body_of "$reply" | GP_ID="$id" json_eval 'try { const job = JSON.parse(input).find((j) => j.id === process.env.GP_ID); print(job ? job.status + "\t" + (job.result ?? job.note ?? "") : "missing\t") } catch { print("waiting\t") }' || true)
    fi
    state=${job%%"$TAB"*}
    text=${job#*"$TAB"}
    case "$state" in
      done)
        info "Connection test for $task: $text"
        return 0
        ;;
      failed | cancelled | paused | missing)
        warn "Connection test for $task $state: $text"
        return 1
        ;;
    esac
    sleep 2
    i=$((i + 2))
  done
  warn "The connection test for $task did not finish within 5 minutes."
  return 1
}

configure_app() {
  local reply="" status="" current="" base_url="" json_mode="" reason="" reads="" payload="" stamp="" current_base=""
  local cloud_models="" task="" model="" cloud_base="" backup="" old_key=""
  step "6. The app's LLM settings"
  load_api_key
  [ -n "$API_KEY" ] || die "No API key for the server is saved; run the script without --configure-only first, or set GMAT_LLM_API_KEY."
  base_url="http://127.0.0.1:$LOCAL_PORT/v1"
  if [ -z "$SERVER_MODELS" ]; then read_server_models || true; fi
  if [ -n "$SERVER_MODELS" ] && ! contains_word "$SERVER_MODELS" "$MODEL_FAST"; then
    die "The server does not offer $MODEL_FAST (it offers: $SERVER_MODELS)."
  fi
  reason=$MODEL_REASON
  reads=$MODEL_REASON
  if [ -n "$SERVER_MODELS" ] && ! contains_word "$SERVER_MODELS" "$MODEL_REASON"; then
    warn "The server offers no $MODEL_REASON (minimal profile); solving, book-map and extraction use $MODEL_FAST, and no model reads images."
    reason=$MODEL_FAST
    reads=""
  fi
  stamp=$(configured_stamp "$reason")
  if [ "$CONFIGURED" = "$stamp" ] && [ "$OPT_RECONFIGURE" != 1 ] && [ "$MODE" != configure ]; then
    info "The app's LLM settings were set on an earlier run (use --reconfigure to set them again)."
    return 0
  fi
  COOKIE_JAR="$WORK_DIR/cookies"
  : >"$COOKIE_JAR"
  chmod 600 "$COOKIE_JAR"
  unlock_curator
  reply=$(api GET /api/curator/settings/llm)
  [ "$(status_of "$reply")" = 200 ] || die "Reading the LLM settings failed (HTTP $(status_of "$reply"))."
  current=$(body_of "$reply")
  current_base=$(printf '%s' "$current" | json_eval 'print(JSON.parse(input).baseUrl ?? "")')
  json_mode=$OPT_JSON_MODE
  if [ -z "$json_mode" ]; then
    json_mode=$(printf '%s' "$current" | json_eval 'print(JSON.parse(input).jsonMode)')
    # llama-server supports response_format json_schema, the app's default.
    [ -n "$json_mode" ] || json_mode="json-schema"
  fi
  if [ "$json_mode" != json-schema ]; then
    say "The app asks for JSON with mode $json_mode, kept because your cloud API may need it. The local models keep to"
    say "the reply's shape most reliably with json-schema; pass --json-mode json-schema if your cloud API accepts it."
  fi
  if [ "$OPT_ALL_LOCAL" != 1 ]; then
    for task in $CLOUD_TASKS; do
      model=$(printf '%s' "$current" | GP_TASK="$task" json_eval 'print(JSON.parse(input).models.find((m) => m.task === process.env.GP_TASK)?.model ?? "")')
      if [ -n "$model" ] && ! contains_word "$cloud_models" "$model"; then cloud_models="$cloud_models $model"; fi
    done
    cloud_models=${cloud_models# }
    cloud_base=$OPT_CLOUD_BASE_URL
    if [ -z "$cloud_base" ] && [ -n "$current_base" ] && [ "${current_base%/}" != "$base_url" ] && ! is_local_url "$current_base"; then
      cloud_base=$current_base
    fi
    if [ -n "$cloud_models" ]; then
      if [ -n "$cloud_base" ]; then
        setup_cloud_peer "$cloud_base" "$(printf '%s' "$cloud_models" | tr ' ' ',')"
      elif [ "${current_base%/}" = "$base_url" ]; then
        for model in $cloud_models; do
          if ! contains_word "$SERVER_MODELS" "cloud/$model"; then
            warn "The server does not route $model to a cloud API; pass --cloud-base-url URL to set that up, or --all-local."
          fi
        done
      else
        warn "Generation, approaches and lessons use $cloud_models, which the old setup at ${current_base:-no address} served. Pass --cloud-base-url URL to send them to a cloud API through the server, or --all-local."
      fi
    else
      info "Generation, approaches and lessons have no model set; set one in Settings, or run with --all-local."
    fi
  fi
  if [ "${current_base%/}" != "$base_url" ]; then
    # The settings from before this script, kept for going back (they hold no key).
    mkdir -p "$CONFIG_DIR/backup"
    backup="$CONFIG_DIR/backup/app-llm-settings-$(date +%Y%m%d-%H%M%S).json"
    printf '%s\n' "$current" >"$backup"
    chmod 600 "$backup"
    info "The app's earlier LLM settings are saved in $backup."
  fi
  payload=$(settings_payload "$current" "$base_url" "$json_mode" "$reason" "$reads")
  reply=$(api PUT /api/curator/settings/llm "$payload")
  status=$(status_of "$reply")
  [ "$status" = 200 ] || die "Saving the LLM settings failed (HTTP $status): $(body_of "$reply")"
  old_key=$(current_app_api_key)
  reply=$(api PUT /api/curator/settings/api-key "$(GP_FIELD=apiKey json_string "$API_KEY")")
  status=$(status_of "$reply")
  [ "$status" = 200 ] || die "Saving the API key failed (HTTP $status): $(body_of "$reply")"
  if [ -n "$old_key" ] && [ "$old_key" != "$API_KEY" ]; then
    info "The app's API key is now the server's key; the app no longer holds the API key it had before."
  fi
  info "Saved: API address $base_url, JSON mode $json_mode, $MODEL_FAST for $FAST_TASKS, $reason for $REASON_TASKS$(if [ "$OPT_ALL_LOCAL" = 1 ]; then printf ' and %s' "$CLOUD_TASKS"; fi), local models priced at 0."
  if [ "$OPT_NO_TEST" != 1 ]; then connection_test tagging || true; fi
  lock_curator
  CONFIGURED=$stamp
  if [ "$MODE" != configure ]; then save_config; fi
}

open_browser() {
  [ "$OPT_NO_BROWSER" = 1 ] && return 0
  if [ "$IS_MAC" = 1 ]; then
    open "$APP_URL" || true
  elif have xdg-open; then
    xdg-open "$APP_URL" >/dev/null 2>&1 || true
  fi
}

# Keeps the tunnel up until the app ends or Ctrl+C. When the tunnel drops
# (the server slept, or the hotspot changed its address), the app keeps
# running and the tunnel is opened again once the server is found.
wait_for_end() {
  local waited=0 reason=""
  say ""
  say "GMAT prep is running at $APP_URL with the local LLM server. Press Ctrl+C to stop the app and the tunnel."
  while true; do
    if [ "$APP_STARTED" = 1 ] && ! kill -0 "$APP_PID" 2>/dev/null; then
      APP_STARTED=0
      warn "The app stopped; see $APP_LOG"
      return 0
    fi
    if [ "$TUNNEL_STARTED" = 1 ] && ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      TUNNEL_STARTED=0
      rm -f "$TUNNEL_PID_FILE"
      reason=$(tail -n 2 "$LOG_DIR/tunnel.log" 2>/dev/null | tr '\n' ' ' | sed 's/[ .]*$//' || true)
      warn "The tunnel closed${reason:+: $reason}."
      say "The app keeps running; LLM tasks wait until the server is back. Reconnecting."
      waited=0
    fi
    if [ "$TUNNEL_STARTED" != 1 ]; then
      if [ "$waited" -le 0 ]; then
        if locate_server >/dev/null 2>&1 && start_tunnel; then
          info "Reconnected to the server at $SERVER_ADDRESS."
          save_config
        else
          waited=30
        fi
      else
        waited=$((waited - 2))
      fi
    fi
    sleep 2
  done
}

# Stops the app and tunnel an earlier run started.
stop_mode() {
  local pid="" cmd=""
  if pid=$(running_tunnel); then
    stop_process "$pid" "the tunnel"
  else
    info "No tunnel from this script is running."
  fi
  rm -f "$TUNNEL_PID_FILE"
  if [ -f "$APP_PID_FILE" ]; then
    pid=$(sed -n 1p "$APP_PID_FILE")
    case "$pid" in "" | *[!0-9]*) pid=0 ;; esac
    cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
    case "$cmd" in
      *src/server/main.ts*) stop_process "$pid" "the app" ;;
      *) info "No app from this script is running." ;;
    esac
    rm -f "$APP_PID_FILE"
  else
    info "No app from this script is running."
  fi
}

setup_dirs() {
  mkdir -p "$CONFIG_DIR" "$RUN_DIR"
  chmod 700 "$CONFIG_DIR"
  if [ "$IS_MAC" = 1 ]; then LOG_DIR="$HOME/Library/Logs/gmat-prep"; else LOG_DIR="$CONFIG_DIR/logs"; fi
  mkdir -p "$LOG_DIR"
  WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/gmat-prep-mac.XXXXXX")
  chmod 700 "$WORK_DIR"
  # A socket path may be about 100 bytes at most, and ssh adds a random
  # suffix while it sets a socket up, so the SSH control socket lives in a
  # short private folder under /tmp rather than under TMPDIR.
  CONTROL_DIR=$(mktemp -d /tmp/gmat-ssh.XXXXXX)
  chmod 700 "$CONTROL_DIR"
  CONTROL_SOCKET="$CONTROL_DIR/s"
}

main() {
  parse_args "$@"
  load_config
  trap 'on_error $? "$LINENO" "$BASH_COMMAND"' ERR
  trap cleanup EXIT
  trap on_signal INT TERM HUP
  setup_dirs
  case "$MODE" in
    stop)
      stop_mode
      return 0
      ;;
    configure)
      find_repo
      ensure_bun
      if [ -n "$CONFIGURE_URL" ]; then
        APP_URL=${CONFIGURE_URL%/}
      else
        APP_URL=$(running_app_url | sed -n 1p || true)
        [ -n "$APP_URL" ] || APP_URL="http://127.0.0.1:${GMAT_PREP_PORT:-4747}"
      fi
      app_answers "$APP_URL" || die "No GMAT prep app answers at $APP_URL."
      configure_app
      return 0
      ;;
  esac
  say "start-gmat-prep-mac.sh $SCRIPT_VERSION"
  prepare_app
  stop_old_forwarding
  load_api_key
  if [ -z "$(pinned_key)" ] || [ -z "$API_KEY" ] || [ "$OPT_PAIR" = 1 ] || [ ! -f "$KEY_FILE" ]; then
    pair
  else
    step "3. Finding the server"
    find_server
    save_config
  fi
  open_tunnel
  check_api
  start_app
  configure_app
  open_browser
  wait_for_end
}

if [ "${GMAT_PREP_SOURCE_ONLY:-0}" != 1 ]; then
  main "$@"
fi
