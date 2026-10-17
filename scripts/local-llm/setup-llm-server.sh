#!/usr/bin/env bash
# setup-llm-server.sh: sets up the GMAT prep local LLM server on an Ubuntu
# laptop with an NVIDIA GPU, and installs itself as /opt/gmat-llm/bin/gmat-llm
# for everyday management. Run it with sudo. See docs/local-llm.md.
#
# What it runs: llama.cpp's llama-server (built here with CUDA) behind
# llama-swap, one OpenAI-compatible endpoint on 127.0.0.1 that loads the model
# a request names. Nothing model-related listens on the network; the Mac
# reaches the endpoint through a restricted SSH tunnel.

set -Eeuo pipefail
shopt -s nullglob
# Untranslated messages from ufw, apt and the rest, which the script reads,
# and byte-order character ranges in its patterns.
export LC_ALL=C.UTF-8

# ---------------------------------------------------------------------------
# Pinned versions and sources. Every value here was checked against its
# upstream source on 2026-10-17; docs/local-llm.md lists the links.
# ---------------------------------------------------------------------------

readonly GMAT_LLM_SCRIPT_VERSION="1.0.0"

readonly LLAMA_CPP_TAG="b11400"
readonly LLAMA_CPP_BUILD_NUMBER="11400"
readonly LLAMA_CPP_COMMIT="0bb496dbd3af0add77ff82c406a915b41e839d56"
readonly LLAMA_CPP_GIT="https://github.com/ggml-org/llama.cpp"

readonly LLAMA_SWAP_VERSION="265"
readonly LLAMA_SWAP_ASSET="llama-swap_265_linux_amd64.tar.gz"
readonly LLAMA_SWAP_CHECKSUMS="llama-swap_265_checksums.txt"
readonly LLAMA_SWAP_SHA256="cb1f9a94be05afa129d3c17868f1dd2ca710b919333c7b868239dc31575dcfa1"
readonly LLAMA_SWAP_BASE_URL="https://github.com/mostlygeek/llama-swap/releases/download/v265"

# CUDA 12.x runs on any driver from 525 on (minor version compatibility);
# CUDA 13 needs driver 580 or newer, so 12.8 is the safer choice for Turing.
readonly CUDA_HOME_PINNED="/usr/local/cuda-12.8"
readonly CUDA_KEYRING_URL_2204="https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb"
readonly CUDA_KEYRING_SHA256_2204="d93190d50b98ad4699ff40f4f7af50f16a76dac3bb8da1eaaf366d47898ff8df"
readonly CUDA_KEYRING_URL_2404="https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb"
readonly CUDA_KEYRING_SHA256_2404="d2a6b11c096396d868758b86dab1823b25e14d70333f1dfa74da5ddaf6a06dba"
# The smallest set that builds llama.cpp's CUDA backend (about 1 GB to
# download, against about 3.6 GB for cuda-toolkit-12-8).
readonly CUDA_PACKAGES="cuda-nvcc-12-8 cuda-cudart-dev-12-8 libcublas-dev-12-8 cuda-driver-dev-12-8 cuda-cccl-12-8"

# Models, from Hugging Face at pinned repository revisions. File names are
# matched against the repository's file list at run time.
readonly HF_BASE="https://huggingface.co"

readonly FAST_ID="qwen3.5-4b"
readonly FAST_REPO="unsloth/Qwen3.5-4B-GGUF"
readonly FAST_REV="e87f176479d0855a907a41277aca2f8ee7a09523"
readonly FAST_QUANT="Q4_K_M"
readonly FAST_PREFIX="Qwen3.5-4B"

readonly REASON_ID="qwen3.6-35b-a3b"
readonly REASON_REPO="unsloth/Qwen3.6-35B-A3B-GGUF"
readonly REASON_REV="a483e9e6cbd595906af30beda3187c2663a1118c"
readonly REASON_PREFIX="Qwen3.6-35B-A3B"
# Turing has no BF16, so the F16 vision projector.
readonly REASON_MMPROJ_REGEX='^mmproj-F16\.gguf$'

readonly OCR_ID="ocr"
readonly OCR_REPO="ggml-org/GLM-OCR-GGUF"
readonly OCR_REV="65a42de1148dbed2297e922b5dbc7d9b70c36578"
readonly OCR_MODEL_REGEX='^GLM-OCR-Q8_0\.gguf$'
readonly OCR_MMPROJ_REGEX='^mmproj-GLM-OCR-Q8_0\.gguf$'

readonly EMBED_ID="embed"
readonly EMBED_REPO="Qwen/Qwen3-Embedding-0.6B-GGUF"
readonly EMBED_REV="370f27d7550e0def9b39c1f16d3fbaa13aa67728"
readonly EMBED_MODEL_REGEX='^Qwen3-Embedding-0\.6B-Q8_0\.gguf$'

# Approximate sizes in GB, for the disk check before the exact sizes are
# read from Hugging Face.
readonly SIZE_GB_FAST=3
readonly SIZE_GB_REASON_Q3=18
readonly SIZE_GB_REASON_Q2=14
readonly SIZE_GB_OCR=2
readonly SIZE_GB_EMBED=1

# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------

readonly INSTALL_ROOT="/opt/gmat-llm"
readonly BIN_DIR="$INSTALL_ROOT/bin"
readonly SELF_INSTALL_PATH="$BIN_DIR/gmat-llm"
readonly SELF_LINK="/usr/local/bin/gmat-llm"
readonly LLAMA_CPP_ROOT="$INSTALL_ROOT/llama.cpp"
readonly LLAMA_SWAP_ROOT="$INSTALL_ROOT/llama-swap"
readonly STATE_DIR="/var/lib/gmat-llm"
readonly MODELS_DIR="$STATE_DIR/models"
readonly ETC_DIR="/etc/gmat-llm"
readonly SETUP_CONF="$ETC_DIR/setup.conf"
readonly SWAP_CONFIG="$ETC_DIR/llama-swap.yaml"
readonly SWAP_ENV="$ETC_DIR/llama-swap.env"
readonly CLOUD_CONF="$ETC_DIR/cloud.conf"
readonly CLOUD_ENV="$ETC_DIR/cloud.env"
readonly AUTH_KEYS_DIR="$ETC_DIR/ssh"
readonly AUTH_KEYS_FILE="$AUTH_KEYS_DIR/authorized_keys"
readonly LOG_DIR="/var/log/gmat-llm"
readonly BACKUP_ROOT="/var/backups/gmat-llm"
readonly SERVICE_NAME="gmat-llm.service"
readonly SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"
readonly SERVICE_USER="gmat-llm"
readonly TUNNEL_USER="gmat-tunnel"
readonly SSHD_DROPIN="/etc/ssh/sshd_config.d/60-gmat-llm.conf"
readonly SSHD_RESET_DROPIN="/etc/ssh/sshd_config.d/00-gmat-llm-reset.conf"
readonly APT_PIN_FILE="/etc/apt/preferences.d/gmat-llm-nvidia-driver"
readonly LOGIND_DROPIN="/etc/systemd/logind.conf.d/60-gmat-llm-lid.conf"
readonly STATE_RECORD="$ETC_DIR/installed.list"
readonly LOCK_FILE="/run/gmat-llm-setup.lock"
readonly DEFAULT_PORT=18100

# Ports local LLM stacks use by default. The first list is specific to LLM
# software; the second is shared with other programs, so a listener there is
# only stopped when its program is a known LLM program.
readonly LLM_PORTS_STRONG="11434 9931 1234 5001 7860 7861 4000 30000 39281"
readonly LLM_PORTS_COMMON="8080 8000 8001 8081 3000 5000"
# Lowercase patterns that identify LLM software in unit files, process
# command lines, container images and folder names.
readonly LLM_PATTERN='ollama|llama-server|llama-swap|llama_swap|llama\.cpp|llamacpp|llama_cpp|vllm|lmstudio|lm-studio|lm studio|llmster|open-webui|open_webui|openwebui|litellm|text-generation-webui|text_generation_webui|text-generation-inference|text-generation-launcher|oobabooga|koboldcpp|tabbyapi|localai|local-ai|sglang|exllama|aphrodite|gpt4all|ramalama|llamafile|mlc_llm|mlc-llm'

# ---------------------------------------------------------------------------
# Runtime state
# ---------------------------------------------------------------------------

DRY_RUN=0
ASSUME_YES=0
PROFILE="standard"
PORT="$DEFAULT_PORT"
REASON_QUANT="UD-Q3_K_XL"
REASON_QUANT_SET=0
CTX_FAST=16384
CTX_REASON=16384
N_CPU_MOE=""
REASONING="off"
KEEP_AWAKE=0
SKIP_CLEANUP=0
BUILD_JOBS=""
CURRENT_STEP="start"
LOG_FILE=""
BACKUP_DIR=""
HAVE_TTY=0
OS_VERSION=""
INVOKING_USER=""
SSH_SESSION_PEER=""
SSH_SESSION_PORT=""
GPU_NAME=""
GPU_DRIVER=""
GPU_VRAM_MIB=0
GPU_CC=""
GPU_CUDA_ARCH="75"
DRIVER_CUDA=""
MEM_TOTAL_KIB=0
NVCC=""
APT_UPDATED=0
CONFIG_CHANGED=0
API_KEY_NEW=""
# Hidden test switches, read once. GMAT_LLM_SOURCE_ONLY=1 loads the functions
# without running anything (for tests). GMAT_LLM_FAKE_HARDWARE=1 pretends a
# Turing GPU is present so a --dry-run can show the later steps on a machine
# without one; it is refused without --dry-run.
FAKE_HARDWARE="${GMAT_LLM_FAKE_HARDWARE:-0}"

# ---------------------------------------------------------------------------
# Output and prompts
# ---------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

step() {
  CURRENT_STEP="$1"
  printf '\n== %s ==\n' "$1"
}

# Writes to the terminal only, never to the log: for secrets.
to_tty() {
  if ((HAVE_TTY)); then
    printf '%s\n' "$*" >/dev/tty
  else
    printf '%s\n' "$*"
  fi
}

on_error() {
  local code=$1 line=$2 command=$3
  # A failure inside a command substitution is reported once, by the shell
  # that ran it.
  if ((BASH_SUBSHELL > 0)); then exit "$code"; fi
  trap - ERR
  printf '\nError: the step "%s" failed (exit code %s) at line %s:\n  %s\n' "$CURRENT_STEP" "$code" "$line" "$command" >&2
  if [[ -n "$LOG_FILE" ]]; then
    printf 'The full log is %s. Fix the cause and run the script again; finished steps are skipped.\n' "$LOG_FILE" >&2
  fi
  exit "$code"
}

on_interrupt() {
  trap - INT TERM
  printf '\nStopped during "%s". Run the script again to carry on; downloads resume where they stopped.\n' "$CURRENT_STEP" >&2
  exit 130
}

# confirm QUESTION DEFAULT(y|n): returns 0 for yes. --yes takes the default,
# so a question whose safe answer is no stays no. A dry run takes the default
# and says so.
confirm() {
  local question=$1 default=${2:-n} hint answer
  if [[ "$default" == y ]]; then hint="[Y/n]"; else hint="[y/N]"; fi
  if ((DRY_RUN)); then
    printf '[dry-run] would ask: %s %s, taking "%s"\n' "$question" "$hint" "$default"
    [[ "$default" == y ]]
    return
  fi
  if ((ASSUME_YES)); then
    printf '%s %s %s (--yes)\n' "$question" "$hint" "$default"
    [[ "$default" == y ]]
    return
  fi
  if ((!HAVE_TTY)); then
    die "A question needs an answer but there is no terminal: \"$question\". Run in a terminal, or pass --yes to take the default answers."
  fi
  while true; do
    printf '%s %s ' "$question" "$hint" >/dev/tty
    IFS= read -r answer </dev/tty || answer=""
    printf '%s\n' "${answer:-($default)}" >>"${LOG_FILE:-/dev/null}"
    case "${answer:-$default}" in
      y | Y | yes | Yes | YES) return 0 ;;
      n | N | no | No | NO) return 1 ;;
      *) printf 'Please answer y or n.\n' >/dev/tty ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Changes go through these helpers, so --dry-run shows every one and makes
# none.
# ---------------------------------------------------------------------------

quote_cmd() {
  local out="" arg
  for arg in "$@"; do out+=" $(printf '%q' "$arg")"; done
  printf '%s' "${out# }"
}

run() {
  if ((DRY_RUN)); then
    printf '[dry-run] would run: %s\n' "$(quote_cmd "$@")"
    return 0
  fi
  "$@"
}

# write_file PATH MODE OWNER:GROUP, content on stdin.
write_file() {
  local path=$1 mode=$2 owner=$3 tmp dir
  if ((DRY_RUN)); then
    printf '[dry-run] would write %s (mode %s, owner %s):\n' "$path" "$mode" "$owner"
    sed 's/^/    | /'
    return 0
  fi
  dir=$(dirname "$path")
  mkdir -p "$dir"
  tmp=$(mktemp "$dir/.gmat-llm.XXXXXX")
  cat >"$tmp"
  chmod "$mode" "$tmp"
  chown "$owner" "$tmp"
  mv -f "$tmp" "$path"
}

# Like write_file, but a dry run does not print the content.
write_secret_file() {
  local path=$1 mode=$2 owner=$3
  if ((DRY_RUN)); then
    cat >/dev/null
    printf '[dry-run] would write %s (mode %s, owner %s): secret content not shown\n' "$path" "$mode" "$owner"
    return 0
  fi
  write_file "$path" "$mode" "$owner"
}

# Whether PATH would change if CONTENT (stdin) were written to it.
file_differs() {
  local path=$1 tmp result=0
  tmp=$(mktemp)
  cat >"$tmp"
  if [[ -f "$path" ]] && cmp -s "$tmp" "$path"; then result=1; fi
  rm -f "$tmp"
  return "$result"
}

ensure_backup_dir() {
  if [[ -z "$BACKUP_DIR" ]]; then
    BACKUP_DIR="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
  fi
  if ((!DRY_RUN)) && [[ ! -d "$BACKUP_DIR" ]]; then
    mkdir -p "$BACKUP_DIR"
    chmod 700 "$BACKUP_ROOT" "$BACKUP_DIR"
  fi
}

# Copies a file or folder into this run's backup folder, keeping its path.
backup_path() {
  local path=$1
  [[ -e "$path" || -L "$path" ]] || return 0
  ensure_backup_dir
  if ((DRY_RUN)); then
    printf '[dry-run] would back up %s to %s%s\n' "$path" "$BACKUP_DIR" "$path"
    return 0
  fi
  cp -a --parents "$path" "$BACKUP_DIR/"
  info "Backed up $path to $BACKUP_DIR$path"
}

# Refuses to delete system folders, home folders themselves and relative
# paths.
assert_safe_to_delete() {
  local path=$1 normalized depth
  [[ "$path" == /* ]] || die "Refusing to delete a relative path: $path"
  [[ "$path" != *"/../"* && "$path" != *"/.." && "$path" != *"/./"* ]] || die "Refusing to delete a path with . or ..: $path"
  normalized=${path%/}
  case "$normalized" in
    "" | /bin | /boot | /dev | /etc | /home | /lib | /lib32 | /lib64 | /media | /mnt | /opt | /proc | /root | /run | /sbin | /snap | /srv | /sys | /tmp | /usr | /var | /var/lib | /var/log | /var/backups | /usr/local | /usr/lib | /usr/share | /usr/bin | /usr/sbin | /usr/local/bin | /usr/local/lib | /etc/systemd | /etc/systemd/system | /etc/ssh)
      die "Refusing to delete the system folder $path"
      ;;
  esac
  depth=$(awk -F/ '{print NF-1}' <<<"$normalized")
  ((depth >= 2)) || die "Refusing to delete the top-level folder $path"
  if [[ "$normalized" == /home/* ]] && ((depth < 3)); then
    die "Refusing to delete the home folder $path"
  fi
}

remove_path() {
  local path=$1
  [[ -e "$path" || -L "$path" ]] || return 0
  assert_safe_to_delete "$path"
  run rm -rf --one-file-system -- "$path"
}

record_installed() {
  local item=$1
  ((DRY_RUN)) && return 0
  mkdir -p "$ETC_DIR"
  touch "$STATE_RECORD"
  grep -qxF -- "$item" "$STATE_RECORD" || printf '%s\n' "$item" >>"$STATE_RECORD"
}

was_installed() {
  [[ -f "$STATE_RECORD" ]] && grep -qxF -- "$1" "$STATE_RECORD"
}

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

# The first line of the input. sed reads all of it, so the writer never gets
# SIGPIPE, which pipefail would turn into a failure.
first_line() { sed -n 1p; }

# Indents its input, for listing what was found.
indent() { sed 's/^/    /'; }

human_bytes() {
  awk -v b="${1:-0}" 'BEGIN {
    split("B KB MB GB TB", u, " "); i = 1
    while (b >= 1000 && i < 5) { b /= 1000; i++ }
    if (i == 1) printf "%d %s", b, u[i]; else printf "%.1f %s", b, u[i]
  }'
}

dir_size_bytes() {
  local n
  n=$(du -sb --one-file-system -- "$1" 2>/dev/null | awk 'NR == 1 {print $1}' || true)
  printf '%s' "${n:-0}"
}

# Whether dpkg has the package installed.
pkg_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'
}

# Installed packages whose names match the given shell patterns.
installed_matching() {
  dpkg-query -W -f='${Status}\t${Package}\n' "$@" 2>/dev/null | awk -F'\t' '$1 == "install ok installed" {print $2}' || true
}

free_bytes_for() {
  local path=$1
  while [[ ! -e "$path" ]]; do path=$(dirname "$path"); done
  df -PB1 -- "$path" | awk 'NR == 2 {print $4}'
}

# Users with a login: root and accounts with UID 1000 to 59999.
human_users() {
  getent passwd | awk -F: '$3 == 0 || ($3 >= 1000 && $3 < 60000) {print $1 ":" $6}'
}

is_llm_text() {
  grep -qiE -- "$LLM_PATTERN" <<<"$1"
}

port_class() {
  local port=$1 p
  for p in $LLM_PORTS_STRONG; do [[ "$p" == "$port" ]] && { printf 'strong'; return 0; }; done
  for p in $LLM_PORTS_COMMON; do [[ "$p" == "$port" ]] && { printf 'common'; return 0; }; done
  printf 'other'
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && (($1 >= 1024 && $1 <= 65000))
}

json_get() {
  # json_get EXPRESSION < JSON: prints a value from JSON read on stdin, where
  # EXPRESSION is a dotted path such as data.0.id.
  python3 -I -c '
import json, sys
value = json.load(sys.stdin)
for part in sys.argv[1].split("."):
    if part == "":
        continue
    if isinstance(value, list):
        value = value[int(part)]
    else:
        value = value[part]
if isinstance(value, (dict, list)):
    print(json.dumps(value))
elif value is None:
    print("")
else:
    print(value)
' "$1"
}

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage:
  sudo $0 [options]          set up the server (safe to run again)
  sudo gmat-llm COMMAND [args]     manage it once it is set up

Setup options:
  --profile NAME     minimal (the 4B model only), standard (4B and 35B-A3B,
                     the default) or full (adds document OCR and embeddings)
  --dry-run          print every change without making any
  --yes              take the default answer to every question; questions
                     about things not identified as LLM software default to no
  --port N           port of the local endpoint on 127.0.0.1 (default $DEFAULT_PORT)
  --quant NAME       quantization of the 35B-A3B model: UD-Q3_K_XL (default)
                     or UD-Q2_K_XL (smaller, for less memory)
  --n-cpu-moe N      keep the experts of N layers of the 35B-A3B model in
                     system RAM instead of working it out from free VRAM
  --ctx-fast N       context of the 4B model (default 16384)
  --ctx-reason N     context of the 35B-A3B model (default 16384)
  --reasoning on|off let the Qwen models think before answering (default off,
                     which keeps replies within the app's 180 second limit)
  --keep-awake       keep the laptop running when its lid is closed
  --skip-cleanup     do not look for old LLM setups
  --jobs N           parallel build jobs for llama.cpp (default: from CPU and RAM)
  -h, --help         show this help

Commands (gmat-llm):
  status                 the service, models, memory, clients and firewall
  add-client 'KEY'       allow a Mac's public key to open the tunnel
  remove-client [MATCH]  list tunnel keys, or remove those whose fingerprint
                         or comment contains MATCH ("all" removes every key)
  show-api-key           print the endpoint's API key
  set-cloud              send cloud models through the endpoint (see the docs)
  clear-cloud            stop sending cloud models through the endpoint
  restart                restart the endpoint
  logs [-f]              show the endpoint's log
  test                   check that every model answers
  uninstall              remove what setup installed, asking first
  setup [options]        run the setup again
EOF
}

# ---------------------------------------------------------------------------
# Settings kept between runs
# ---------------------------------------------------------------------------

# Reads KEY=VALUE lines from a file this script wrote, accepting only known
# keys and plain values.
load_setup_conf() {
  local key value
  [[ -f "$SETUP_CONF" ]] || return 0
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[A-Z_]+$ ]] || continue
    [[ "$value" =~ ^[A-Za-z0-9._,:-]*$ ]] || continue
    case "$key" in
      PROFILE) PROFILE=$value ;;
      PORT) PORT=$value ;;
      REASON_QUANT) REASON_QUANT=$value ;;
      CTX_FAST) CTX_FAST=$value ;;
      CTX_REASON) CTX_REASON=$value ;;
      REASONING) REASONING=$value ;;
      N_CPU_MOE_SAVED) SAVED_N_CPU_MOE=$value ;;
      NGL_SAVED) SAVED_NGL=$value ;;
    esac
  done <"$SETUP_CONF"
}

SAVED_N_CPU_MOE=""
SAVED_NGL=""

save_setup_conf() {
  write_file "$SETUP_CONF" 0644 root:root <<EOF
# Choices of the last gmat-llm setup run. Re-run setup to change them.
PROFILE=$PROFILE
PORT=$PORT
REASON_QUANT=$REASON_QUANT
CTX_FAST=$CTX_FAST
CTX_REASON=$CTX_REASON
REASONING=$REASONING
N_CPU_MOE_SAVED=${SAVED_N_CPU_MOE}
NGL_SAVED=${SAVED_NGL}
EOF
}

profile_models() {
  case "$PROFILE" in
    minimal) printf '%s\n' fast ;;
    standard) printf '%s\n' fast reason ;;
    full) printf '%s\n' fast reason ocr embed ;;
  esac
}

profile_has() {
  local key=$1 m
  for m in $(profile_models); do [[ "$m" == "$key" ]] && return 0; done
  return 1
}

model_id() {
  case "$1" in
    fast) printf '%s' "$FAST_ID" ;;
    reason) printf '%s' "$REASON_ID" ;;
    ocr) printf '%s' "$OCR_ID" ;;
    embed) printf '%s' "$EMBED_ID" ;;
  esac
}

model_tasks() {
  case "$1" in
    fast) printf 'tagging, statement-translation, tutor-chat' ;;
    reason) printf 'solving, book-map, extraction (reads images)' ;;
    ocr) printf 'document OCR (no app task uses it yet)' ;;
    embed) printf 'embeddings (no app task uses them yet)' ;;
  esac
}

# ===========================================================================
# Step 1: preflight
# ===========================================================================

# Finds the sshd process the current shell descends from, if any, and the
# address of the computer on the other end.
detect_ssh_session() {
  local pid=$$ comm ppid line
  while [[ "$pid" =~ ^[0-9]+$ ]] && ((pid > 1)); do
    comm=$(ps -o comm= -p "$pid" 2>/dev/null || true)
    if [[ "$comm" == sshd* ]]; then
      line=$(ss -tnpH state established 2>/dev/null | grep -F "pid=$pid," | head -n 1 || true)
      if [[ -n "$line" ]]; then
        SSH_SESSION_PEER=$(awk '{print $4}' <<<"$line")
        SSH_SESSION_PORT=$(awk '{print $3}' <<<"$line")
        SSH_SESSION_PORT=${SSH_SESSION_PORT##*:}
      else
        SSH_SESSION_PEER="unknown"
      fi
      return 0
    fi
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    [[ -n "$ppid" && "$ppid" != "$pid" ]] || break
    pid=$ppid
  done
  return 0
}

session_comes_through_tunnel() {
  case "$SSH_SESSION_PEER" in
    127.* | "[::1]"* | ::1*) return 0 ;;
  esac
  return 1
}

check_os() {
  local id="" version=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck source=/dev/null # the system's own file
    id=$(. /etc/os-release && printf '%s' "${ID:-}")
    # shellcheck source=/dev/null
    version=$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")
  fi
  if [[ "$id" != "ubuntu" ]] || [[ "$version" != "22.04" && "$version" != "24.04" ]]; then
    die "This script supports Ubuntu 22.04 and 24.04 only; this computer runs ${id:-an unknown system} ${version}."
  fi
  OS_VERSION=$version
  info "Ubuntu $OS_VERSION"
  local arch
  arch=$(uname -m)
  [[ "$arch" == x86_64 ]] || die "This script supports x86_64 only; this computer is $arch."
  info "Architecture $arch"
  if [[ ! -d /run/systemd/system ]]; then
    if ((FAKE_HARDWARE)); then
      warn "systemd is not running (allowed only for a pretend-hardware dry run)."
    else
      die "systemd is not running here (a container?); the server runs as a systemd service on the laptop itself."
    fi
  fi
}

check_privileges() {
  if ((EUID != 0)); then
    if ((DRY_RUN)); then
      warn "Not running as root: the dry run cannot see every process, container or file. Run it with sudo for a full picture."
    else
      die "Run this script with sudo."
    fi
  fi
  INVOKING_USER="${SUDO_USER:-}"
  if [[ -n "$INVOKING_USER" ]]; then info "Invoked by $INVOKING_USER through sudo"; fi
}

read_gpu() {
  local query
  if ((FAKE_HARDWARE)); then
    GPU_NAME="NVIDIA GeForce RTX 2060 (pretend, for a dry run)"
    GPU_DRIVER="580.95.05"
    GPU_VRAM_MIB=6144
    GPU_CC="7.5"
    DRIVER_CUDA="13.0"
    return 0
  fi
  have nvidia-smi || return 1
  query=$(nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits 2>/dev/null) || return 1
  query=$(first_line <<<"$query")
  [[ -n "$query" ]] || return 1
  GPU_NAME=$(awk -F', ' '{print $1}' <<<"$query")
  GPU_DRIVER=$(awk -F', ' '{print $2}' <<<"$query")
  GPU_VRAM_MIB=$(awk -F', ' '{print int($3)}' <<<"$query")
  GPU_CC=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | first_line | tr -d ' ' || true)
  DRIVER_CUDA=$(nvidia-smi 2>/dev/null | grep -o 'CUDA Version: [0-9.]*' | first_line | awk '{print $3}' || true)
  return 0
}

offer_driver_install() {
  say "No working NVIDIA driver was found (nvidia-smi is missing or cannot reach the driver)."
  if grep -q '^nouveau ' /proc/modules 2>/dev/null; then
    info "The open nouveau driver is loaded; CUDA needs NVIDIA's driver instead."
  fi
  if [[ -n "$(installed_matching 'nvidia-driver-*' 'nvidia-headless-*')" ]]; then
    say "NVIDIA driver packages are installed but the driver is not running. Reboot first."
    say "If it still fails after a reboot and Secure Boot is on (mokutil --sb-state), enroll the key the driver install asked for, or turn Secure Boot off."
    exit 1
  fi
  if ! have ubuntu-drivers; then
    apt_update_once
    run env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y ubuntu-drivers-common
  fi
  if have ubuntu-drivers; then
    say "Drivers Ubuntu offers for this GPU:"
    ubuntu-drivers list --gpgpu 2>/dev/null | sed 's/^/  /' || true
  fi
  if confirm "Install the recommended NVIDIA server driver now (ubuntu-drivers install --gpgpu)?" y; then
    run ubuntu-drivers install --gpgpu
    local version=""
    if ((!DRY_RUN)); then
      version=$(installed_matching 'nvidia-headless-*-server' 'nvidia-driver-*-server' |
        sed -n 's/^nvidia-\(headless\|driver\)-\([0-9]*\)-server$/\2/p' | sort -n | tail -n 1 || true)
    fi
    if [[ -n "$version" ]]; then
      run env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y "nvidia-utils-$version-server"
    else
      say "Install nvidia-smi too: sudo apt-get install nvidia-utils-<version>-server, with the version ubuntu-drivers installed."
    fi
    say ""
    say "The driver is installed. Reboot (sudo reboot), then run this script again."
  else
    say "Install the driver yourself (sudo ubuntu-drivers install --gpgpu), reboot, then run this script again."
  fi
  exit 0
}

check_gpu() {
  if ((!FAKE_HARDWARE)); then
    local has_nvidia=0 vendors=(/sys/bus/pci/devices/*/vendor) pci=""
    if have lspci; then pci=$(lspci -nn 2>/dev/null || true); fi
    if grep -qiE 'nvidia|\[10de:' <<<"$pci"; then
      has_nvidia=1
    elif ((${#vendors[@]} > 0)) && grep -qs '0x10de' "${vendors[@]}"; then
      has_nvidia=1
    fi
    if ! have nvidia-smi && ((has_nvidia == 0)); then
      die "No NVIDIA GPU was found: nvidia-smi is missing and no NVIDIA PCI device is present. Run this script on the GPU laptop."
    fi
  fi
  if ! read_gpu; then
    offer_driver_install
  fi
  info "GPU: $GPU_NAME, $GPU_VRAM_MIB MiB, driver $GPU_DRIVER, supports CUDA ${DRIVER_CUDA:-unknown}"
  if [[ "$GPU_CC" =~ ^([0-9]+)\.([0-9]+)$ ]]; then
    GPU_CUDA_ARCH="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
    info "Compute capability $GPU_CC; llama.cpp is built for sm_$GPU_CUDA_ARCH"
  else
    GPU_CUDA_ARCH="75"
    warn "The driver did not report the compute capability; building for 7.5 (RTX 20 series)."
  fi
  if [[ "$GPU_CUDA_ARCH" != 75 ]]; then
    warn "This GPU is not the Turing (7.5) card the design assumed; the build follows the detected capability."
  fi
  if [[ "$DRIVER_CUDA" =~ ^([0-9]+)\. ]] && ((BASH_REMATCH[1] < 12)); then
    say "The driver supports CUDA $DRIVER_CUDA only; CUDA 12 needs driver 525 or newer."
    if confirm "Install a newer driver with ubuntu-drivers now?" y; then
      run ubuntu-drivers install --gpgpu
      say "Reboot (sudo reboot), then run this script again."
      exit 0
    fi
    die "A driver of version 525 or newer is needed."
  fi
  if ((GPU_VRAM_MIB > 0 && GPU_VRAM_MIB < 5500)) && profile_has reason; then
    warn "The GPU has $GPU_VRAM_MIB MiB; the 35B-A3B model will keep almost all of its experts in system RAM."
  fi
}

check_memory_and_disk() {
  MEM_TOTAL_KIB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  local mem_gib avail_kib models_gb software_gb models_dev software_dev free_models free_software
  mem_gib=$(awk -v k="$MEM_TOTAL_KIB" 'BEGIN {printf "%.1f", k / 1048576}')
  avail_kib=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  info "RAM: $mem_gib GiB in total, $(awk -v k="$avail_kib" 'BEGIN {printf "%.1f", k / 1048576}') GiB available now"
  if profile_has reason && ((MEM_TOTAL_KIB < 14 * 1048576)) && [[ "$REASON_QUANT" == "UD-Q3_K_XL" ]]; then
    warn "Less than 14 GiB of RAM: the 3-bit 35B-A3B model will not fit. Use --quant UD-Q2_K_XL or --profile minimal."
  fi
  models_gb=$(estimate_models_gb)
  # llama.cpp's source and build, the CUDA toolkit and apt's package cache.
  software_gb=6
  models_dev=$(device_of "$MODELS_DIR")
  software_dev=$(device_of /usr/local)
  free_models=$(free_bytes_for "$MODELS_DIR")
  free_software=$(free_bytes_for /usr/local)
  if [[ "$models_dev" == "$software_dev" ]]; then
    models_gb=$((models_gb + software_gb))
    software_gb=0
  fi
  info "Disk: about $models_gb GB needed for $MODELS_DIR, $(human_bytes "$free_models") free there"
  local problem=""
  if ((free_models < models_gb * 1000000000)); then
    problem="Not enough free disk space: the $PROFILE profile needs about $models_gb GB on the disk that holds $MODELS_DIR. Free some space or choose a smaller profile."
  elif ((software_gb > 0)) && ((free_software < software_gb * 1000000000)); then
    problem="Not enough free disk space for llama.cpp and the CUDA toolkit: $software_gb GB needed under /opt and /usr/local, $(human_bytes "$free_software") free."
  fi
  if [[ -n "$problem" ]]; then
    if ((FAKE_HARDWARE)); then warn "$problem (going on: pretend-hardware dry run)"; else die "$problem"; fi
  fi
}

# The filesystem holding a path, or its nearest existing parent.
device_of() {
  local path=$1
  while [[ ! -e "$path" ]]; do path=$(dirname "$path"); done
  stat -c %d -- "$path"
}

estimate_models_gb() {
  local total=0 key existing
  for key in $(profile_models); do
    case "$key" in
      fast) total=$((total + SIZE_GB_FAST)) ;;
      reason)
        if [[ "$REASON_QUANT" == "UD-Q2_K_XL" ]]; then total=$((total + SIZE_GB_REASON_Q2)); else total=$((total + SIZE_GB_REASON_Q3)); fi
        ;;
      ocr) total=$((total + SIZE_GB_OCR)) ;;
      embed) total=$((total + SIZE_GB_EMBED)) ;;
    esac
  done
  # Model files already in place need no new space.
  existing=$(($(dir_size_bytes "$MODELS_DIR") / 1000000000))
  total=$((total - existing))
  ((total < 1)) && total=1
  printf '%s' "$total"
}

check_internet() {
  local url code failed=0
  for url in "$HF_BASE/api/models/$FAST_REPO" "https://github.com" "https://developer.download.nvidia.com/compute/cuda/repos/" "http://archive.ubuntu.com/ubuntu/"; do
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 --head "$url" 2>/dev/null || true)
    if [[ "$code" =~ ^[23] ]]; then
      info "Reaches $url"
    elif [[ "$code" =~ ^[1-9] ]]; then
      info "Reaches $url (HTTP $code)"
    else
      warn "Cannot reach $url (HTTP ${code:-no answer})"
      failed=1
    fi
  done
  if ((failed)); then
    warn "Some downloads will fail without these sites. Check the hotspot's connection."
  fi
}

check_network() {
  local route iface gateway addr
  route=$(ip -4 route show default 2>/dev/null | head -n 1 || true)
  iface=$(awk '{for (i = 1; i <= NF; i++) if ($i == "dev") print $(i+1)}' <<<"$route")
  gateway=$(awk '{for (i = 1; i <= NF; i++) if ($i == "via") print $(i+1)}' <<<"$route")
  if [[ -z "$iface" ]]; then
    warn "No default route: this computer is not on a network."
    return 0
  fi
  addr=$(ip -4 -o addr show dev "$iface" scope global 2>/dev/null | awk '{print $4}' | head -n 1 || true)
  info "Network: $iface, address ${addr:-none}, gateway ${gateway:-none}"
  case "$addr" in
    172.20.10.*) info "This looks like an iPhone Personal Hotspot (172.20.10.0/28); its addresses change between sessions, which the Mac script handles." ;;
  esac
  info "Host name: $(hostname), published on the network as $(hostname).local once avahi-daemon runs"
  if [[ -n "$SSH_SESSION_PEER" ]]; then
    info "You are connected over SSH from $SSH_SESSION_PEER; SSH stays open throughout."
  fi
}

preflight() {
  step "1. Preflight checks"
  check_os
  local entry tool
  # Each tool and the package that provides it; all are on Ubuntu Server.
  for entry in curl:curl ss:iproute2 ip:iproute2 awk:mawk sed:sed python3:python3 systemctl:systemd dpkg-query:dpkg getent:libc-bin flock:util-linux sha256sum:coreutils; do
    tool=${entry%%:*}
    have "$tool" || die "The command $tool is missing; install it (sudo apt-get install ${entry#*:}) and run again."
  done
  check_privileges
  detect_ssh_session
  check_gpu
  check_memory_and_disk
  check_internet
  check_network
}

# ===========================================================================
# Step 2: clean out old local LLM setups
# ===========================================================================

is_own_unit() {
  [[ "$1" == gmat-llm* ]]
}

# Lists system service units whose name or command line names LLM software,
# one "unit<TAB>file<TAB>summary" per line.
find_llm_system_units() {
  local unit file content exec
  while read -r unit _; do
    [[ "$unit" == *.service && "$unit" != *@.service ]] || continue
    is_own_unit "$unit" && continue
    file=$(systemctl show -p FragmentPath --value "$unit" 2>/dev/null || true)
    [[ -n "$file" && -f "$file" ]] || continue
    content=$(cat "$file" 2>/dev/null || true)
    exec=$(grep -E '^[[:space:]]*ExecStart=' <<<"$content" | head -n 1 | sed 's/^[[:space:]]*ExecStart=//' || true)
    if is_llm_text "$unit" || is_llm_text "$exec"; then
      printf '%s\t%s\t%s\n' "$unit" "$file" "${exec:0:120}"
    fi
  done < <(systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null)
}

# Lists user service unit files of every login user that name LLM software,
# one "user<TAB>unit<TAB>file" per line.
find_llm_user_units() {
  local entry user home file unit exec
  while IFS= read -r entry; do
    user=${entry%%:*}
    home=${entry#*:}
    for file in "$home"/.config/systemd/user/*.service; do
      unit=$(basename "$file")
      exec=$(grep -E '^[[:space:]]*ExecStart=' "$file" 2>/dev/null | head -n 1 || true)
      if is_llm_text "$unit" || is_llm_text "$exec"; then
        printf '%s\t%s\t%s\n' "$user" "$unit" "$file"
      fi
    done
  done < <(human_users)
}

cleanup_units() {
  local list unit file summary user any=0
  list=$(find_llm_system_units)
  if [[ -n "$list" ]]; then
    any=1
    say "System services of earlier LLM setups:"
    while IFS=$'\t' read -r unit file summary; do
      info "$unit ($(systemctl is-active "$unit" 2>/dev/null || true), $file): $summary"
    done <<<"$list"
    if confirm "Stop and disable these services, and remove their unit files from /etc/systemd/system?" y; then
      while IFS=$'\t' read -r unit file summary; do
        run systemctl disable --now "$unit" || warn "Could not stop $unit"
        if [[ "$file" == /etc/systemd/system/* ]]; then
          backup_path "$file"
          remove_path "$file"
          if [[ -d "$file.d" ]]; then
            backup_path "$file.d"
            remove_path "$file.d"
          fi
        else
          info "$file belongs to an installed package; the service stays disabled."
        fi
      done <<<"$list"
      run systemctl daemon-reload
    fi
  fi
  list=$(find_llm_user_units)
  if [[ -n "$list" ]]; then
    any=1
    say "User services of earlier LLM setups:"
    while IFS=$'\t' read -r user unit file; do info "$user: $unit ($file)"; done <<<"$list"
    if confirm "Stop and disable these user services and move their unit files to the backup folder?" y; then
      while IFS=$'\t' read -r user unit file; do
        run systemctl --user -M "$user@" disable --now "$unit" 2>/dev/null || info "The user manager of $user is not running; removing the unit file is enough."
        backup_path "$file"
        remove_path "$file"
        local link
        for link in "$(dirname "$file")"/*.wants/"$unit"; do remove_path "$link"; done
      done <<<"$list"
    fi
  fi
  ((any)) || info "No services of earlier LLM setups."
}

container_tool() {
  if have docker && docker info >/dev/null 2>&1; then
    printf 'docker'
  elif have podman && podman info >/dev/null 2>&1; then
    printf 'podman'
  fi
}

cleanup_containers() {
  local tool containers images volumes line
  tool=$(container_tool)
  if [[ -z "$tool" ]]; then
    info "No Docker or Podman engine running."
    return 0
  fi
  containers=$($tool ps -a --format '{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}' 2>/dev/null | while IFS=$'\t' read -r id image name status; do
    if is_llm_text "$image" || is_llm_text "$name"; then printf '%s\t%s\t%s\t%s\n' "$id" "$image" "$name" "$status"; fi
  done || true)
  if [[ -n "$containers" ]]; then
    say "$tool containers of LLM software:"
    while IFS=$'\t' read -r id image name status; do info "$name ($image, $status)"; done <<<"$containers"
    if confirm "Stop and remove these containers?" y; then
      while IFS=$'\t' read -r id _; do run "$tool" rm -f "$id"; done <<<"$containers"
    fi
  fi
  images=$($tool images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}' 2>/dev/null | while IFS=$'\t' read -r ref id size; do
    if is_llm_text "$ref"; then printf '%s\t%s\t%s\n' "$ref" "$id" "$size"; fi
  done || true)
  if [[ -n "$images" ]]; then
    say "$tool images of LLM software:"
    while IFS=$'\t' read -r ref id size; do info "$ref ($size)"; done <<<"$images"
    if confirm "Remove these images?" y; then
      while IFS=$'\t' read -r ref id _; do run "$tool" rmi -f "$id" || warn "Could not remove $ref"; done <<<"$images"
    fi
  fi
  volumes=$($tool volume ls --format '{{.Name}}' 2>/dev/null | while read -r name; do
    if is_llm_text "$name"; then
      line=$($tool volume inspect --format '{{.Mountpoint}}' "$name" 2>/dev/null || true)
      printf '%s\t%s\n' "$name" "$(human_bytes "$(dir_size_bytes "$line")")"
    fi
  done || true)
  if [[ -n "$volumes" ]]; then
    say "$tool volumes of LLM software (these hold models and chat data):"
    while IFS=$'\t' read -r name size; do info "$name ($size)"; done <<<"$volumes"
    if confirm "Remove these volumes?" y; then
      while IFS=$'\t' read -r name _; do run "$tool" volume rm "$name" || warn "Could not remove volume $name (still in use?)"; done <<<"$volumes"
    fi
  fi
  if [[ -z "$containers$images$volumes" ]]; then info "No containers, images or volumes of LLM software."; fi
}

# Processes listening on LLM ports whose program is LLM software, one
# "pid<TAB>port<TAB>command" per line. Our own service is left out.
find_llm_listeners() {
  local listeners line port pid cmd cgroup
  listeners=$(ss -ltnpH 2>/dev/null || true)
  while read -r line; do
    [[ -n "$line" ]] || continue
    port=$(awk '{print $4}' <<<"$line")
    port=${port##*:}
    [[ "$(port_class "$port")" != other ]] || continue
    while read -r pid; do
      [[ -n "$pid" ]] || continue
      cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
      cgroup=$(cat "/proc/$pid/cgroup" 2>/dev/null || true)
      [[ "$cgroup" == *"$SERVICE_NAME"* ]] && continue
      [[ "$cmd" == "$INSTALL_ROOT"* ]] && continue
      if is_llm_text "$cmd"; then printf '%s\t%s\t%s\n' "$pid" "$port" "${cmd:0:150}"; fi
    done < <(grep -o 'pid=[0-9]*' <<<"$line" | cut -d= -f2 | sort -u)
  done <<<"$listeners" | sort -u
}

stop_pid() {
  local pid=$1 i
  run kill -TERM "$pid" 2>/dev/null || return 0
  ((DRY_RUN)) && return 0
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  warn "Process $pid did not stop within 10 seconds; killing it."
  kill -KILL "$pid" 2>/dev/null || true
}

cleanup_listeners() {
  local list pid port cmd
  list=$(find_llm_listeners)
  if [[ -z "$list" ]]; then
    info "No LLM programs listening on LLM ports."
    return 0
  fi
  say "LLM programs listening on LLM ports:"
  while IFS=$'\t' read -r pid port cmd; do info "process $pid on port $port: $cmd"; done <<<"$list"
  if confirm "Stop these processes (by process ID)?" y; then
    while IFS=$'\t' read -r pid port cmd; do stop_pid "$pid"; done <<<"$list"
  fi
}

cleanup_ollama() {
  local bin found=0 paths=() p entry home size
  for bin in /usr/local/bin/ollama /usr/bin/ollama /bin/ollama; do
    [[ -e "$bin" ]] && paths+=("$bin")
  done
  for p in /usr/local/lib/ollama /usr/lib/ollama /usr/share/ollama /etc/systemd/system/ollama.service; do
    [[ -e "$p" ]] && paths+=("$p")
  done
  while IFS= read -r entry; do
    home=${entry#*:}
    [[ -d "$home/.ollama" ]] && paths+=("$home/.ollama")
  done < <(human_users)
  if getent passwd ollama >/dev/null 2>&1; then found=1; fi
  if ((${#paths[@]} == 0 && found == 0)); then
    info "No Ollama installation."
    return 0
  fi
  say "Ollama (binary, libraries, models and its service user):"
  for p in "${paths[@]}"; do
    size=$(human_bytes "$(dir_size_bytes "$p")")
    info "$p ($size)"
  done
  ((found)) && info "the ollama user and group"
  if confirm "Remove Ollama, its models and its user, as Ollama's uninstall guide does?" y; then
    if systemctl cat ollama.service >/dev/null 2>&1; then
      run systemctl disable --now ollama.service || true
    fi
    for p in "${paths[@]}"; do
      [[ "$p" == *.service ]] && backup_path "$p"
      remove_path "$p"
    done
    run systemctl daemon-reload
    if getent passwd ollama >/dev/null 2>&1; then run userdel ollama || warn "Could not remove the ollama user"; fi
    if getent group ollama >/dev/null 2>&1; then run groupdel ollama || warn "Could not remove the ollama group"; fi
  fi
}

# Model stores and caches of LLM tools in each login user's home folder.
cleanup_caches() {
  local entry user home rel path list="" size total=0 bytes
  while IFS= read -r entry; do
    user=${entry%%:*}
    home=${entry#*:}
    [[ -d "$home" ]] || continue
    # The Hugging Face hub cache, llama.cpp's -hf download cache, LM Studio's
    # home and model folder (new and old), and vLLM's cache.
    for rel in .cache/huggingface .cache/llama.cpp .lmstudio .cache/lm-studio .cache/vllm; do
      path="$home/$rel"
      if [[ -e "$path" ]]; then
        bytes=$(dir_size_bytes "$path")
        total=$((total + bytes))
        list+="$path"$'\t'"$bytes"$'\n'
      fi
    done
  done < <(human_users)
  if [[ -z "$list" ]]; then
    info "No Hugging Face, llama.cpp, LM Studio or vLLM caches."
    return 0
  fi
  say "Model caches and LLM app data in home folders ($(human_bytes "$total") in total):"
  while IFS=$'\t' read -r path size; do [[ -n "$path" ]] && info "$path ($(human_bytes "$size"))"; done <<<"$list"
  if confirm "Remove these caches and their models?" y; then
    while IFS=$'\t' read -r path size; do [[ -n "$path" ]] && remove_path "$path"; done <<<"$list"
  fi
}

# GGUF model files outside the caches above, grouped by folder.
cleanup_gguf_folders() {
  local roots=() r dirs dir bytes total=0 list=""
  for r in /home /root /opt /srv /data /mnt /media /usr/local/share /var/lib; do [[ -d "$r" ]] && roots+=("$r"); done
  ((${#roots[@]} > 0)) || return 0
  dirs=$(find "${roots[@]}" -xdev -maxdepth 7 \( -path "$STATE_DIR" -o -path "$INSTALL_ROOT" -o -path /var/lib/docker -o -path /var/lib/containers -o -name node_modules -o -name .git \) -prune -o -type f -iname '*.gguf' -size +20M -printf '%h\n' 2>/dev/null | sort -u || true)
  [[ -n "$dirs" ]] || {
    info "No other GGUF model files."
    return 0
  }
  while IFS= read -r dir; do
    [[ -n "$dir" ]] || continue
    bytes=$(find "$dir" -maxdepth 1 -type f -iname '*.gguf' -printf '%s\n' 2>/dev/null | awk '{s += $1} END {print s + 0}')
    total=$((total + bytes))
    list+="$dir"$'\t'"$bytes"$'\n'
  done <<<"$dirs"
  say "Other folders with GGUF model files ($(human_bytes "$total") in total):"
  while IFS=$'\t' read -r dir bytes; do [[ -n "$dir" ]] && info "$dir ($(human_bytes "$bytes") of .gguf files)"; done <<<"$list"
  if confirm "Delete the .gguf files in these folders (other files stay)?" y; then
    while IFS=$'\t' read -r dir bytes; do
      [[ -n "$dir" ]] || continue
      assert_safe_to_delete "$dir/x"
      if ((DRY_RUN)); then
        printf '[dry-run] would delete the .gguf files in %s\n' "$dir"
      else
        find "$dir" -maxdepth 1 -type f -iname '*.gguf' -delete
        rmdir --ignore-fail-on-non-empty "$dir" 2>/dev/null || true
      fi
    done <<<"$list"
  fi
}

# Old llama.cpp source trees and builds, and llama.cpp programs in
# /usr/local/bin.
cleanup_llama_builds() {
  local roots=() r trees tree list="" bytes bins=() b
  for r in /home /root /opt /srv /usr/local/src; do [[ -d "$r" ]] && roots+=("$r"); done
  ((${#roots[@]} > 0)) || return 0
  trees=$(find "${roots[@]}" -xdev -maxdepth 5 \( -path "$INSTALL_ROOT" -o -name node_modules -o -name .cache \) -prune -o -type f -name CMakeLists.txt -path '*/ggml/CMakeLists.txt' -printf '%h\n' 2>/dev/null | sed 's#/ggml$##' | sort -u || true)
  while IFS= read -r tree; do
    [[ -n "$tree" && -f "$tree/CMakeLists.txt" ]] || continue
    grep -q 'project("llama.cpp"' "$tree/CMakeLists.txt" 2>/dev/null || continue
    bytes=$(dir_size_bytes "$tree")
    list+="$tree"$'\t'"$bytes"$'\n'
  done <<<"$trees"
  for b in /usr/local/bin/llama-* /usr/local/bin/llama /usr/local/lib/libllama* /usr/local/lib/libggml*; do
    [[ -e "$b" ]] && bins+=("$b")
  done
  if [[ -z "$list" && ${#bins[@]} -eq 0 ]]; then
    info "No old llama.cpp builds."
    return 0
  fi
  say "Old llama.cpp source trees, builds and installed programs:"
  while IFS=$'\t' read -r tree bytes; do [[ -n "$tree" ]] && info "$tree ($(human_bytes "$bytes"))"; done <<<"$list"
  for b in "${bins[@]}"; do info "$b"; done
  if confirm "Remove them?" y; then
    while IFS=$'\t' read -r tree bytes; do [[ -n "$tree" ]] && remove_path "$tree"; done <<<"$list"
    for b in "${bins[@]}"; do remove_path "$b"; done
  fi
}

# Python virtual environments that hold vLLM, Open WebUI, LiteLLM and the like.
cleanup_venvs() {
  local roots=() r hits venv list="" bytes
  for r in /home /root /opt /srv; do [[ -d "$r" ]] && roots+=("$r"); done
  ((${#roots[@]} > 0)) || return 0
  # pipx keeps its environments ten levels below /home.
  hits=$(find "${roots[@]}" -xdev -maxdepth 10 \( -name node_modules -o -name .git -o -name .cache -o -name snap \) -prune -o -type d \( -name vllm -o -name open_webui -o -name litellm -o -name sglang -o -name text_generation_server -o -name exllamav2 -o -name llama_cpp \) -path '*/site-packages/*' -print 2>/dev/null || true)
  while IFS= read -r venv; do
    [[ -n "$venv" ]] || continue
    venv=${venv%%/lib/python*}
    # A virtual environment, or a conda environment under envs/ (never a
    # conda base installation).
    if [[ -f "$venv/pyvenv.cfg" ]] || { [[ -d "$venv/conda-meta" ]] && [[ "$venv" == */envs/* ]]; }; then
      list+="$venv"$'\n'
    fi
  done <<<"$hits"
  list=$(sort -u <<<"$list" | sed '/^$/d' || true)
  if [[ -z "$list" ]]; then
    info "No Python environments of LLM software."
    return 0
  fi
  say "Python environments with LLM software:"
  while IFS= read -r venv; do
    bytes=$(dir_size_bytes "$venv")
    info "$venv ($(human_bytes "$bytes"))"
  done <<<"$list"
  if confirm "Remove these environments?" y; then
    while IFS= read -r venv; do remove_path "$venv"; done <<<"$list"
  fi
}

# Describes the forwarding in an ssh command line: "L:8080" and the like,
# space-separated, or nothing when there is none.
ssh_forward_specs() {
  local tokens=() token rest letter i next_is="" specs="" value
  # read -a splits on whitespace without expanding * or ? in the words.
  read -r -a tokens <<<"$1"
  # The first word is the program itself.
  for token in "${tokens[@]:1}"; do
    if [[ -n "$next_is" ]]; then
      specs+=$(forward_spec_for "$next_is" "$token")
      next_is=""
      continue
    fi
    [[ "$token" == -* && "$token" != --* && "$token" != - ]] || continue
    rest=${token#-}
    for ((i = 0; i < ${#rest}; i++)); do
      letter=${rest:i:1}
      case "$letter" in
        N) specs+=" N" ;;
        # Options that take an argument, in the same word or the next one.
        B | b | c | D | E | e | F | I | i | J | L | l | m | O | o | p | Q | R | S | W | w)
          value=${rest:i+1}
          if [[ -n "$value" ]]; then
            specs+=$(forward_spec_for "$letter" "$value")
          else
            next_is=$letter
          fi
          break
          ;;
      esac
    done
  done
  printf '%s' "${specs# }"
}

# The forwarding an option and its argument describe, with a leading space,
# or nothing.
forward_spec_for() {
  local letter=$1 value=$2
  case "$letter" in
    L | R | D) printf ' %s:%s' "$letter" "$value" ;;
    w) printf ' w' ;;
    o)
      case "$value" in
        [Ll]ocal[Ff]orward* | [Rr]emote[Ff]orward* | [Dd]ynamic[Ff]orward*) printf ' O:%s' "$value" ;;
      esac
      ;;
  esac
}

# The ports a forwarding description names, one per line.
spec_ports() {
  grep -oE '[0-9]{2,5}' <<<"$1" || true
}

specs_are_llm() {
  local port
  for port in $(spec_ports "$1"); do
    [[ "$(port_class "$port")" != other ]] && return 0
  done
  return 1
}

# A reverse forward to this computer's SSH port may carry the session that
# runs this script.
specs_may_carry_session() {
  local spec=$1 port
  session_comes_through_tunnel || return 1
  [[ "$spec" == *R:* || "$spec" == *[Rr]emote[Ff]orward* ]] || return 1
  for port in $(spec_ports "$spec"); do
    [[ "$port" == 22 || "$port" == "${SSH_SESSION_PORT:-22}" ]] && return 0
  done
  return 1
}

cleanup_tunnel_processes() {
  local pid user cmd specs llm list=""
  while read -r pid user cmd; do
    [[ -n "$pid" ]] || continue
    case "$(basename "${cmd%% *}")" in ssh | autossh) ;; *) continue ;; esac
    specs=$(ssh_forward_specs "$cmd")
    [[ -n "$specs" ]] || continue
    list+="$pid"$'\t'"$user"$'\t'"$specs"$'\t'"$cmd"$'\n'
  done < <(ps -eo pid=,user=,args= 2>/dev/null)
  if [[ -z "$list" ]]; then
    info "No SSH tunnel processes."
    return 0
  fi
  say "SSH tunnel processes:"
  while IFS=$'\t' read -r pid user specs cmd; do
    [[ -n "$pid" ]] || continue
    if specs_may_carry_session "$specs"; then
      info "process $pid ($user): $cmd"
      warn "This reverse tunnel may carry the SSH session running this script; it is left alone. Stop it yourself later if it is from an old LLM setup."
      continue
    fi
    if specs_are_llm "$specs"; then llm="LLM ports"; else llm="not identified as an LLM tunnel"; fi
    info "process $pid ($user, $llm): $cmd"
    if [[ "$llm" == "LLM ports" ]]; then
      if confirm "Stop process $pid?" y; then stop_pid "$pid"; fi
    else
      if confirm "Stop process $pid anyway?" n; then stop_pid "$pid"; fi
    fi
  done <<<"$list"
}

cleanup_tunnel_units() {
  local unit file exec specs list="" entry user home
  while read -r unit _; do
    [[ "$unit" == *.service ]] || continue
    is_own_unit "$unit" && continue
    file=$(systemctl show -p FragmentPath --value "$unit" 2>/dev/null || true)
    [[ -n "$file" && -f "$file" ]] || continue
    exec=$(grep -E '^[[:space:]]*ExecStart=' "$file" | head -n 1 | sed 's/^[[:space:]]*ExecStart=[-@+!:]*//' || true)
    case "$(basename "${exec%% *}")" in ssh | autossh) ;; *) continue ;; esac
    specs=$(ssh_forward_specs "$exec")
    [[ -n "$specs" || "$exec" == *autossh* ]] || continue
    list+="system"$'\t'"$unit"$'\t'"$file"$'\t'"$specs"$'\n'
  done < <(systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null)
  while IFS= read -r entry; do
    user=${entry%%:*}
    home=${entry#*:}
    for file in "$home"/.config/systemd/user/*.service; do
      exec=$(grep -E '^[[:space:]]*ExecStart=' "$file" | head -n 1 | sed 's/^[[:space:]]*ExecStart=[-@+!:]*//' || true)
      case "$(basename "${exec%% *}")" in ssh | autossh) ;; *) continue ;; esac
      specs=$(ssh_forward_specs "$exec")
      list+="$user"$'\t'"$(basename "$file")"$'\t'"$file"$'\t'"$specs"$'\n'
    done
  done < <(human_users)
  if [[ -z "$list" ]]; then
    info "No autossh or SSH tunnel services."
    return 0
  fi
  say "Services that run SSH tunnels:"
  while IFS=$'\t' read -r user unit file specs; do
    [[ -n "$unit" ]] || continue
    local default=n label="not identified as an LLM tunnel"
    if specs_are_llm "$specs"; then default=y label="LLM ports"; fi
    if specs_may_carry_session "$specs"; then
      info "$unit ($user, $file): $specs"
      warn "This service runs a reverse tunnel that may carry the SSH session running this script; it is left alone."
      continue
    fi
    info "$unit ($user, $label, $file): ${specs:-autossh}"
    if confirm "Stop and disable $unit?" "$default"; then
      if [[ "$user" == system ]]; then
        run systemctl disable --now "$unit" || true
        if [[ "$file" == /etc/systemd/system/* ]]; then
          backup_path "$file"
          remove_path "$file"
        fi
        run systemctl daemon-reload
      else
        run systemctl --user -M "$user@" disable --now "$unit" 2>/dev/null || true
        backup_path "$file"
        remove_path "$file"
      fi
    fi
  done <<<"$list"
}

# Comments out LocalForward, RemoteForward and DynamicForward lines in the
# SSH client config of root and each login user, after a backup.
cleanup_ssh_client_configs() {
  local entry user home cfg lines any=0
  while IFS= read -r entry; do
    user=${entry%%:*}
    home=${entry#*:}
    for cfg in "$home/.ssh/config" "$home"/.ssh/config.d/*; do
      [[ -f "$cfg" ]] || continue
      # ssh_config keywords are case-insensitive.
      lines=$(grep -iE '^[[:space:]]*(LocalForward|RemoteForward|DynamicForward)[[:space:]=]' "$cfg" 2>/dev/null || true)
      [[ -n "$lines" ]] || continue
      any=1
      say "Forwarding lines in $cfg:"
      printf '%s\n' "$lines" | indent
      local default=n
      if specs_are_llm "$lines"; then default=y; fi
      if confirm "Back up $cfg and comment these lines out?" "$default"; then
        backup_path "$cfg"
        if ((DRY_RUN)); then
          printf '[dry-run] would comment out the forwarding lines in %s\n' "$cfg"
        else
          local tmp
          tmp=$(mktemp "$cfg.gmat-llm.XXXXXX")
          sed -E 's/^([[:space:]]*)((Local|Remote|Dynamic)Forward)([[:space:]=])/\1# disabled by gmat-llm setup: \2\4/I' "$cfg" >"$tmp"
          chmod --reference="$cfg" "$tmp"
          chown --reference="$cfg" "$tmp"
          mv -f "$tmp" "$cfg"
          info "Commented out the forwarding lines in $cfg"
        fi
      fi
    done
  done < <(human_users)
  ((any)) || info "No forwarding lines in SSH client configs."
}

# Server-side forwarding settings an old setup may have added. Drop-ins that
# name LLM software are disabled; settings elsewhere are overridden by a
# reset drop-in that sshd reads first. sshd is reloaded, never restarted.
cleanup_sshd_forwarding() {
  local files=() f hits llm_dropins=() other="" need_reset_gateway=0 need_reset_tunnel=0 changed=0
  [[ -f /etc/ssh/sshd_config ]] || {
    info "No OpenSSH server config."
    return 0
  }
  files+=(/etc/ssh/sshd_config)
  for f in /etc/ssh/sshd_config.d/*.conf; do
    [[ "$f" == "$SSHD_DROPIN" || "$f" == "$SSHD_RESET_DROPIN" ]] && continue
    files+=("$f")
  done
  for f in "${files[@]}"; do
    hits=$(grep -niE '^[[:space:]]*(GatewayPorts|PermitTunnel|AllowTcpForwarding|PermitOpen|PermitListen|AllowStreamLocalForwarding|Match)[[:space:]]' "$f" 2>/dev/null || true)
    [[ -n "$hits" ]] || continue
    # A drop-in is identified as LLM-related when it names LLM software, or
    # "llm" is in its file name.
    if [[ "$f" != /etc/ssh/sshd_config ]] && { is_llm_text "$(cat "$f")" || [[ "$(basename "$f" | tr '[:upper:]' '[:lower:]')" == *llm* ]]; }; then
      llm_dropins+=("$f")
      continue
    fi
    other+="$f:"$'\n'"$(printf '%s\n' "$hits" | indent)"$'\n'
    grep -qiE '^[[:space:]]*GatewayPorts[[:space:]]+(yes|clientspecified)' "$f" && need_reset_gateway=1
    grep -qiE '^[[:space:]]*PermitTunnel[[:space:]]+(yes|point-to-point|ethernet)' "$f" && need_reset_tunnel=1
  done
  if ((${#llm_dropins[@]} > 0)); then
    say "sshd drop-ins that look like they came from an old LLM or tunnel setup:"
    for f in "${llm_dropins[@]}"; do
      info "$f:"
      sed 's/^/      /' "$f"
    done
    if confirm "Back up and disable these drop-ins?" y; then
      for f in "${llm_dropins[@]}"; do
        backup_path "$f"
        run mv -f "$f" "$f.disabled-by-gmat-llm"
      done
      changed=1
    fi
  fi
  if [[ -n "$other" ]]; then
    say "Forwarding settings in the SSH server config (not identified as LLM-related, so not edited):"
    printf '%s' "$other"
  fi
  if ((need_reset_gateway || need_reset_tunnel)); then
    say "GatewayPorts or PermitTunnel are turned on above, which lets forwarded ports or tunnels reach the network."
    if confirm "Turn them back off with a drop-in sshd reads first ($SSHD_RESET_DROPIN)?" y; then
      {
        printf '# Written by gmat-llm setup. sshd uses the first value it reads, and this file\n'
        printf '# is read before the others, so it turns off forwarding an old setup turned on.\n'
        printf '# Remove it to go back.\n'
        ((need_reset_gateway)) && printf 'GatewayPorts no\n'
        ((need_reset_tunnel)) && printf 'PermitTunnel no\n'
      } | write_file "$SSHD_RESET_DROPIN" 0644 root:root
      record_installed "file:$SSHD_RESET_DROPIN"
      changed=1
    fi
  fi
  if ((changed)); then
    if sshd_config_ok; then
      reload_sshd
    else
      warn "sshd -t rejected the changed config; putting it back."
      [[ -f "$SSHD_RESET_DROPIN" ]] && run rm -f "$SSHD_RESET_DROPIN"
      for f in "${llm_dropins[@]}"; do
        [[ -f "$f.disabled-by-gmat-llm" ]] && run mv -f "$f.disabled-by-gmat-llm" "$f"
      done
    fi
  fi
  if ((${#llm_dropins[@]} == 0)) && [[ -z "$other" ]]; then info "No forwarding settings in the SSH server config."; fi
}

sshd_binary() {
  if [[ -x /usr/sbin/sshd ]]; then printf '/usr/sbin/sshd'; else command -v sshd || true; fi
}

sshd_config_ok() {
  local sshd
  sshd=$(sshd_binary)
  if ((DRY_RUN)); then
    printf '[dry-run] would check the SSH server config with: %s -t\n' "${sshd:-sshd}"
    return 0
  fi
  [[ -n "$sshd" ]] || return 1
  mkdir -p /run/sshd
  "$sshd" -t
}

# Reloads sshd so it reads its config again. Running sessions stay open.
reload_sshd() {
  local unit
  for unit in ssh.service sshd.service; do
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      run systemctl reload "$unit"
      info "Reloaded $unit (open sessions are not affected)."
      return 0
    fi
  done
  info "The SSH server is not running as a service right now; it reads the new config when it next starts."
}

# Rules for LLM ports from earlier setups.
cleanup_ufw_rules() {
  have ufw || {
    info "ufw is not installed yet."
    return 0
  }
  local rules rule spec port class default words=()
  rules=$(ufw show added 2>/dev/null || true)
  rules=$(grep -E '^ufw ' <<<"$rules" || true)
  [[ -n "$rules" ]] || {
    info "No ufw rules yet."
    return 0
  }
  local found=0
  while IFS= read -r rule; do
    [[ "$rule" == *"gmat-llm"* ]] && continue
    # ufw delete takes the rule without its comment.
    spec=${rule#ufw }
    spec=${spec%% comment *}
    while read -r port; do
      [[ -n "$port" ]] || continue
      class=$(port_class "$port")
      [[ "$class" == other ]] && continue
      found=1
      if [[ "$class" == strong ]]; then default=y; else default=n; fi
      info "ufw rule: $rule (port $port)"
      if confirm "Delete this ufw rule?" "$default"; then
        read -r -a words <<<"$spec"
        run ufw --force delete "${words[@]}" || warn "Could not delete: $rule"
      fi
      break
    done < <(grep -oE '(^|[ :])[0-9]{2,5}(/tcp|/udp)?( |$)' <<<"$spec" | grep -oE '[0-9]{2,5}' || true)
  done <<<"$rules"
  ((found)) || info "No ufw rules for LLM ports."
}

cleanup_old_setup() {
  step "2. Clean out earlier local LLM setups"
  if ((SKIP_CLEANUP)); then
    info "Skipped (--skip-cleanup)."
    return 0
  fi
  say "Looking for services, containers, processes, models and SSH tunnels of earlier setups."
  say "Nothing is removed without a yes, and nothing is removed that is not identified as LLM software."
  cleanup_units
  cleanup_containers
  cleanup_listeners
  cleanup_ollama
  cleanup_caches
  cleanup_gguf_folders
  cleanup_llama_builds
  cleanup_venvs
  cleanup_tunnel_units
  cleanup_tunnel_processes
  cleanup_ssh_client_configs
  cleanup_sshd_forwarding
  cleanup_ufw_rules
}

# ===========================================================================
# Step 3: install what is needed
# ===========================================================================

apt_update_once() {
  ((APT_UPDATED)) && return 0
  run apt-get -o DPkg::Lock::Timeout=300 update
  APT_UPDATED=1
}

# Bytes apt would download to install the given packages, or nothing when
# apt cannot tell (for example before apt update in a dry run).
apt_download_bytes() {
  local uris
  uris=$(apt-get -o DPkg::Lock::Timeout=300 --print-uris -qq install "$@" 2>/dev/null) || return 0
  awk '{s += $3} END {print s + 0}' <<<"$uris"
}

# "1.2 GB to download", or a note that the size is not known yet.
download_note() {
  if [[ -n "$1" ]]; then printf '%s to download' "$(human_bytes "$1")"; else printf 'download size shown by apt'; fi
}

missing_packages() {
  local pkg
  for pkg in "$@"; do
    pkg_installed "$pkg" || printf '%s\n' "$pkg"
  done
}

install_base_packages() {
  local wanted=(build-essential cmake ninja-build git curl ca-certificates pkg-config libssl-dev python3 avahi-daemon ufw pciutils openssh-server)
  local missing bytes
  missing=$(missing_packages "${wanted[@]}" | tr '\n' ' ')
  if [[ -z "${missing// /}" ]]; then
    info "Build tools, avahi-daemon and ufw are installed."
    return 0
  fi
  apt_update_once
  # shellcheck disable=SC2086 # package names, one word each
  bytes=$(apt_download_bytes $missing)
  say "Packages to install: $missing($(download_note "$bytes"))"
  confirm "Install them?" y || die "These packages are needed."
  # shellcheck disable=SC2086
  run env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends $missing
  local pkg
  for pkg in $missing; do record_installed "apt:$pkg"; done
}

nvcc_version() {
  "$1" --version 2>/dev/null | sed -n 's/.*release \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1
}

# Compiles and runs a tiny CUDA program that launches a kernel and creates a
# cuBLAS handle, so the toolkit, the host compiler and the driver are known to
# work together.
nvcc_works() {
  local nvcc=$1 dir result=1
  # A pretend GPU cannot run the test program.
  ((FAKE_HARDWARE)) && return 1
  [[ -x "$nvcc" ]] || return 1
  dir=$(mktemp -d)
  cat >"$dir/check.cu" <<'EOF'
#include <cstdio>
#include <cuda_runtime.h>
#include <cublas_v2.h>
__global__ void add(int *x) { *x += 41; }
int main() {
  int *d = nullptr; int h = 1;
  if (cudaMalloc(&d, sizeof(int)) != cudaSuccess) { printf("cudaMalloc failed\n"); return 1; }
  cudaMemcpy(d, &h, sizeof(int), cudaMemcpyHostToDevice);
  add<<<1, 1>>>(d);
  if (cudaDeviceSynchronize() != cudaSuccess) { printf("the kernel did not run\n"); return 1; }
  cudaMemcpy(&h, d, sizeof(int), cudaMemcpyDeviceToHost);
  cublasHandle_t handle;
  if (cublasCreate(&handle) != CUBLAS_STATUS_SUCCESS) { printf("cublasCreate failed\n"); return 1; }
  cublasDestroy(handle);
  printf("%d\n", h);
  return h == 42 ? 0 : 1;
}
EOF
  if "$nvcc" -arch="sm_$GPU_CUDA_ARCH" -o "$dir/check" "$dir/check.cu" -lcublas >"$dir/build.log" 2>&1; then
    if "$dir/check" >"$dir/run.log" 2>&1; then
      result=0
    else
      warn "A test CUDA program built with $nvcc did not run: $(tr '\n' ' ' <"$dir/run.log")"
    fi
  else
    warn "$nvcc could not build a test CUDA program: $(tail -n 3 "$dir/build.log" | tr '\n' ' ')"
  fi
  rm -rf "$dir"
  return "$result"
}

# A CUDA 12.4 or newer 12.x compiler that builds and runs a test program.
# Its path is the only thing written to standard output.
find_suitable_nvcc() {
  local candidate version major minor seen=" "
  for candidate in "$CUDA_HOME_PINNED/bin/nvcc" /usr/local/cuda-12.9/bin/nvcc /usr/local/cuda-12.6/bin/nvcc /usr/local/cuda-12.5/bin/nvcc /usr/local/cuda-12.4/bin/nvcc /usr/local/cuda/bin/nvcc "$(command -v nvcc 2>/dev/null || true)"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    candidate=$(readlink -f "$candidate")
    [[ "$seen" == *" $candidate "* ]] && continue
    seen+="$candidate "
    version=$(nvcc_version "$candidate")
    major=${version%%.*}
    minor=${version#*.}
    if [[ "$major" != 12 || ! "$minor" =~ ^[0-9]+$ ]] || ((minor < 4)); then
      info "Skipping $candidate (CUDA ${version:-unknown}; 12.4 to 12.x is needed)" >&2
      continue
    fi
    if nvcc_works "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# NVIDIA's repository carries driver packages too, and its keyring package
# pins the whole repository above Ubuntu's. This pin keeps the driver coming
# from Ubuntu, so only the CUDA toolkit comes from NVIDIA.
write_driver_pin() {
  local pkg origin_nvidia=0 sources
  for pkg in $(installed_matching 'nvidia-driver-*' 'nvidia-headless-*' 'libnvidia-compute-*'); do
    # The source lines under the installed (***) version; a version line is
    # indented by five spaces, a source line by eight.
    sources=$(apt-cache policy "$pkg" 2>/dev/null | awk '/^ \*\*\* / {found = 1; next} found && /^     [^ ]/ {exit} found {print}' || true)
    if [[ "$sources" == *developer.download.nvidia.com* ]]; then origin_nvidia=1; fi
  done
  if ((origin_nvidia)); then
    warn "The installed NVIDIA driver came from NVIDIA's repository, so no driver pin is written; apt keeps following that repository for the driver."
    return 0
  fi
  write_file "$APT_PIN_FILE" 0644 root:root <<'EOF'
# Written by gmat-llm setup. Keeps the NVIDIA driver coming from Ubuntu's
# archive: NVIDIA's CUDA repository is used for the CUDA toolkit only.
Package: nvidia-* libnvidia-* xserver-xorg-video-nvidia* libxnvctrl* cuda-drivers* cuda-compat* libcuda1* linux-modules-nvidia-* linux-signatures-nvidia-* linux-objects-nvidia-*
Pin: release l=NVIDIA CUDA
Pin-Priority: -1
EOF
  record_installed "file:$APT_PIN_FILE"
}

# An older setup may have added NVIDIA's repository another way (an apt-key
# key and its own .list file). Two entries for the same repository with
# different keys make apt update fail, so those entries are turned off.
disable_conflicting_cuda_sources() {
  local f own="/etc/apt/sources.list.d/cuda-ubuntu${OS_VERSION//./}-x86_64.list" found=()
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [[ -f "$f" && "$f" != "$own" ]] || continue
    if grep -qE '^[^#]*developer\.download\.nvidia\.com/compute/cuda/repos' "$f"; then found+=("$f"); fi
  done
  ((${#found[@]} > 0)) || return 0
  say "Other apt entries for NVIDIA's CUDA repository, from an earlier setup:"
  for f in "${found[@]}"; do
    info "$f:"
    grep -E 'developer\.download\.nvidia\.com' "$f" | indent
  done
  if confirm "Back them up and turn them off, so they do not clash with the cuda-keyring entry?" y; then
    for f in "${found[@]}"; do
      backup_path "$f"
      if [[ "$f" == /etc/apt/sources.list ]]; then
        if ((DRY_RUN)); then
          printf '[dry-run] would comment out the NVIDIA lines in /etc/apt/sources.list\n'
        else
          sed -i -E 's|^([^#]*developer\.download\.nvidia\.com/compute/cuda/repos.*)$|# disabled by gmat-llm setup: \1|' "$f"
        fi
      else
        run mv -f "$f" "$f.disabled-by-gmat-llm"
      fi
    done
  else
    warn "apt update may fail with \"Conflicting values set for option Signed-By\" until these entries are removed."
  fi
}

install_cuda_toolkit() {
  NVCC=""
  if NVCC=$(find_suitable_nvcc); then
    info "Using the CUDA compiler $NVCC (CUDA $(nvcc_version "$NVCC"))"
    return 0
  fi
  local url sha deb tmpdir bytes
  if [[ "$OS_VERSION" == "22.04" ]]; then
    url=$CUDA_KEYRING_URL_2204
    sha=$CUDA_KEYRING_SHA256_2204
  else
    url=$CUDA_KEYRING_URL_2404
    sha=$CUDA_KEYRING_SHA256_2404
  fi
  say "No suitable CUDA compiler. Installing CUDA 12.8 from NVIDIA's repository: $CUDA_PACKAGES"
  disable_conflicting_cuda_sources
  if ! pkg_installed cuda-keyring; then
    tmpdir=$(mktemp -d)
    deb="$tmpdir/cuda-keyring.deb"
    run curl -fsSL --retry 5 -o "$deb" "$url"
    if ((!DRY_RUN)); then
      [[ "$(sha256sum "$deb" | awk '{print $1}')" == "$sha" ]] || die "The cuda-keyring package from $url does not match its pinned SHA-256."
    fi
    run dpkg -i "$deb"
    rm -rf "$tmpdir"
    record_installed "apt:cuda-keyring"
  fi
  write_driver_pin
  APT_UPDATED=0
  apt_update_once
  if ((!DRY_RUN)); then
    # shellcheck disable=SC2086
    bytes=$(apt_download_bytes $CUDA_PACKAGES)
    say "The CUDA toolkit packages: $(download_note "$bytes")."
  else
    say "The CUDA toolkit packages need about 1 GB of downloads."
  fi
  confirm "Download and install them?" y || die "llama.cpp needs the CUDA toolkit to use the GPU."
  # shellcheck disable=SC2086
  run env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends $CUDA_PACKAGES
  local pkg
  for pkg in $CUDA_PACKAGES; do record_installed "apt:$pkg"; done
  NVCC="$CUDA_HOME_PINNED/bin/nvcc"
  if ((DRY_RUN)); then return 0; fi
  nvcc_works "$NVCC" || die "The CUDA toolkit installed but a test program failed; see the warning above."
  info "CUDA $(nvcc_version "$NVCC") works with this driver."
}

build_jobs() {
  if [[ -n "$BUILD_JOBS" ]]; then
    printf '%s' "$BUILD_JOBS"
    return 0
  fi
  local cpus mem_gib jobs
  cpus=$(nproc)
  mem_gib=$(awk '/^MemAvailable:/ {print int($2 / 1048576)}' /proc/meminfo)
  # nvcc needs up to about 2.5 GB per job for llama.cpp's CUDA files.
  jobs=$((mem_gib * 2 / 5))
  ((jobs > cpus)) && jobs=$cpus
  ((jobs < 1)) && jobs=1
  printf '%s' "$jobs"
}

llama_build_info() {
  printf 'tag=%s commit=%s nvcc=%s cuda=%s arch=%s\n' "$LLAMA_CPP_TAG" "$LLAMA_CPP_COMMIT" "$NVCC" "$(nvcc_version "$NVCC" 2>/dev/null || true)" "$GPU_CUDA_ARCH"
}

llama_bin() {
  printf '%s/current/build/bin/%s' "$LLAMA_CPP_ROOT" "$1"
}

# The folder that holds libcudart and libcublas for a CUDA compiler. CMake
# leaves it out of the build's library search path, so llama-server would
# otherwise depend on whichever CUDA version ldconfig finds first.
cuda_lib_dir() {
  local root dir lib
  root=$(dirname "$(dirname "$1")")
  for dir in "$root/targets/x86_64-linux/lib" "$root/lib64" "$root/lib"; do
    for lib in "$dir"/libcudart.so.*; do
      [[ -e "$lib" ]] && {
        printf '%s' "$dir"
        return 0
      }
    done
  done
  return 0
}

install_llama_cpp() {
  local root="$LLAMA_CPP_ROOT/$LLAMA_CPP_TAG" src build info jobs
  src="$root/src"
  build="$root/build"
  info=$(llama_build_info)
  if [[ -x "$build/bin/llama-server" && -x "$build/bin/llama-fit-params" && -f "$root/build-info" ]] && [[ "$(cat "$root/build-info")" == "$info" ]]; then
    info "llama.cpp $LLAMA_CPP_TAG is built ($build)."
  else
    if [[ -d "$src/.git" ]] && [[ "$(git -C "$src" rev-parse HEAD 2>/dev/null || true)" == "$LLAMA_CPP_COMMIT" ]]; then
      info "The llama.cpp $LLAMA_CPP_TAG source is present."
    else
      say "Downloading the llama.cpp $LLAMA_CPP_TAG source (about 40 MB)."
      remove_path "$src"
      run mkdir -p "$root"
      run git clone --depth 1 --branch "$LLAMA_CPP_TAG" "$LLAMA_CPP_GIT" "$src"
      if ((!DRY_RUN)); then
        [[ "$(git -C "$src" rev-parse HEAD)" == "$LLAMA_CPP_COMMIT" ]] || die "The llama.cpp tag $LLAMA_CPP_TAG does not point to the pinned commit $LLAMA_CPP_COMMIT; stopping."
      fi
    fi
    jobs=$(build_jobs)
    say "Building llama.cpp with CUDA for sm_$GPU_CUDA_ARCH, $jobs compile job(s) at a time. This takes 20 to 60 minutes on a laptop."
    remove_path "$build"
    local rpath_args=() libdir
    libdir=$(cuda_lib_dir "$NVCC")
    # A dry run has not installed the toolkit; NVIDIA's packages put the
    # libraries here.
    if [[ -z "$libdir" && "$NVCC" == "$CUDA_HOME_PINNED/bin/nvcc" ]]; then libdir="$CUDA_HOME_PINNED/targets/x86_64-linux/lib"; fi
    if [[ -n "$libdir" ]]; then rpath_args=(-DCMAKE_BUILD_RPATH="$libdir"); fi
    run cmake -S "$src" -B "$build" -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DGGML_CUDA=ON \
      -DGGML_CUDA_NCCL=OFF \
      -DCMAKE_CUDA_ARCHITECTURES="$GPU_CUDA_ARCH" \
      -DCMAKE_CUDA_COMPILER="$NVCC" \
      -DGGML_NATIVE=ON \
      -DGGML_CCACHE=OFF \
      -DLLAMA_BUILD_NUMBER="$LLAMA_CPP_BUILD_NUMBER" \
      -DLLAMA_USE_PREBUILT_UI=OFF \
      -DLLAMA_BUILD_UI=OFF \
      -DLLAMA_BUILD_TESTS=OFF \
      -DLLAMA_BUILD_EXAMPLES=OFF \
      "${rpath_args[@]}"
    run cmake --build "$build" --target llama-server llama-fit-params -j "$jobs"
    if ((!DRY_RUN)); then
      printf '%s\n' "$info" >"$root/build-info"
    fi
  fi
  run ln -sfn "$root" "$LLAMA_CPP_ROOT/current"
  record_installed "dir:$LLAMA_CPP_ROOT"
  if ((!DRY_RUN)); then
    local missing devices
    missing=$(ldd "$build/bin/llama-server" "$build/bin/libggml-cuda.so" 2>/dev/null | grep 'not found' || true)
    [[ -z "$missing" ]] || die "llama-server cannot find these libraries: $(tr '\n' ' ' <<<"$missing")"
    "$build/bin/llama-server" --version 2>&1 | grep -E 'version|built' | indent || true
    devices=$("$build/bin/llama-server" --list-devices 2>&1 || true)
    if [[ "$devices" != *CUDA0* ]]; then
      die "The llama.cpp build does not see the GPU (llama-server --list-devices shows no CUDA0): $(tr '\n' ' ' <<<"$devices")"
    fi
    info "llama-server sees the GPU: $(grep CUDA0 <<<"$devices" | first_line | sed 's/^ *//')"
  fi
}

install_llama_swap() {
  local dir="$LLAMA_SWAP_ROOT/v$LLAMA_SWAP_VERSION" tmpdir got line
  if [[ -x "$dir/llama-swap" ]] && [[ -f "$dir/.sha256" ]] && [[ "$(cat "$dir/.sha256")" == "$LLAMA_SWAP_SHA256" ]]; then
    info "llama-swap v$LLAMA_SWAP_VERSION is installed."
  else
    say "Downloading llama-swap v$LLAMA_SWAP_VERSION (about 22 MB)."
    tmpdir=$(mktemp -d)
    run curl -fsSL --retry 5 -o "$tmpdir/$LLAMA_SWAP_ASSET" "$LLAMA_SWAP_BASE_URL/$LLAMA_SWAP_ASSET"
    run curl -fsSL --retry 5 -o "$tmpdir/$LLAMA_SWAP_CHECKSUMS" "$LLAMA_SWAP_BASE_URL/$LLAMA_SWAP_CHECKSUMS"
    if ((!DRY_RUN)); then
      got=$(sha256sum "$tmpdir/$LLAMA_SWAP_ASSET" | awk '{print $1}')
      line=$(grep -F "  $LLAMA_SWAP_ASSET" "$tmpdir/$LLAMA_SWAP_CHECKSUMS" | awk '{print $1}' || true)
      [[ "$line" == "$got" ]] || die "$LLAMA_SWAP_ASSET does not match the release's checksum file (got $got, file says ${line:-nothing})."
      [[ "$got" == "$LLAMA_SWAP_SHA256" ]] || die "$LLAMA_SWAP_ASSET matches the release checksum file but not the SHA-256 pinned in this script ($LLAMA_SWAP_SHA256). The release may have been replaced; stopping."
      mkdir -p "$tmpdir/x"
      tar -xzf "$tmpdir/$LLAMA_SWAP_ASSET" -C "$tmpdir/x"
      [[ -f "$tmpdir/x/llama-swap" ]] || die "The llama-swap archive does not hold a llama-swap program."
      mkdir -p "$dir"
      install -m 0755 -o root -g root "$tmpdir/x/llama-swap" "$dir/llama-swap"
      printf '%s\n' "$LLAMA_SWAP_SHA256" >"$dir/.sha256"
    fi
    rm -rf "$tmpdir"
  fi
  run ln -sfn "$dir" "$LLAMA_SWAP_ROOT/current"
  record_installed "dir:$LLAMA_SWAP_ROOT"
  if ((!DRY_RUN)); then info "$("$dir/llama-swap" -version 2>&1 | head -n 1)"; fi
}

install_software() {
  step "3. Install the build tools, CUDA, llama.cpp and llama-swap"
  install_base_packages
  install_cuda_toolkit
  install_llama_cpp
  install_llama_swap
  if ((!DRY_RUN)); then
    systemctl enable --now avahi-daemon.service >/dev/null 2>&1 || warn "Could not start avahi-daemon; the Mac will find this computer by scanning the network instead."
  else
    run systemctl enable --now avahi-daemon.service
  fi
}

# ===========================================================================
# Step 4: download the models
# ===========================================================================

# Prints "path<TAB>size<TAB>sha256" for every file of a repository revision.
hf_list_files() {
  local repo=$1 rev=$2 url body headers next
  url="$HF_BASE/api/models/$repo/tree/$rev?recursive=true"
  while [[ -n "$url" ]]; do
    headers=$(mktemp)
    body=$(curl -fsSL --retry 5 --max-time 60 -D "$headers" "$url") || {
      rm -f "$headers"
      die "Could not read the file list of $repo from Hugging Face."
    }
    python3 -I -c '
import json, sys
for entry in json.loads(sys.stdin.read()):
    if entry.get("type") != "file":
        continue
    lfs = entry.get("lfs") or {}
    print("%s\t%d\t%s" % (entry["path"], int(entry.get("size") or lfs.get("size") or 0), lfs.get("oid", "")))
' <<<"$body"
    next=$(grep -i '^link:' "$headers" | grep -o '<[^>]*>; rel="next"' | sed 's/^<\([^>]*\)>.*/\1/' | head -n 1 || true)
    rm -f "$headers"
    url=$next
  done
}

# Picks the files whose base name matches an extended regular expression,
# which keeps the parts of a split GGUF together. bash's own matching is
# used because mawk on Ubuntu 22.04 lacks {n} repetition.
hf_pick() {
  local regex=$1 path size sha
  while IFS=$'\t' read -r path size sha; do
    [[ -n "$path" ]] || continue
    if [[ "${path##*/}" =~ $regex ]]; then printf '%s\t%s\t%s\n' "$path" "$size" "$sha"; fi
  done
}

# Downloads one file with resume and checks its size and SHA-256. A
# sidecar records a verified file, so a second run does not hash it again.
download_file() {
  local url=$1 dest=$2 size=$3 sha=$4 part sidecar attempt got stamp
  part="$dest.part"
  sidecar="$dest.verified"
  if [[ -f "$dest" ]]; then
    stamp="$(stat -c '%s %Y' "$dest") $sha"
    if [[ -f "$sidecar" ]] && [[ "$(cat "$sidecar")" == "$stamp" ]]; then
      info "$(basename "$dest") is in place and verified."
      return 0
    fi
    if [[ "$(stat -c %s "$dest")" == "$size" ]]; then
      if [[ -z "$sha" ]] || [[ "$(sha256sum "$dest" | awk '{print $1}')" == "$sha" ]]; then
        printf '%s\n' "$stamp" >"$sidecar"
        info "$(basename "$dest") is in place and verified."
        return 0
      fi
    fi
    warn "$(basename "$dest") does not match its expected size or checksum; downloading it again."
    rm -f "$dest" "$sidecar"
  fi
  mkdir -p "$(dirname "$dest")"
  for attempt in 1 2 3 4 5 6 7 8; do
    if [[ -f "$part" ]] && (($(stat -c %s "$part") > size)); then rm -f "$part"; fi
    if [[ -f "$part" ]] && (($(stat -c %s "$part") == size)); then break; fi
    if ((HAVE_TTY)); then
      curl -fL --connect-timeout 30 --retry 3 --retry-delay 5 -C - --progress-bar -o "$part" "$url" 2>/dev/tty && break
    else
      curl -fsSL --connect-timeout 30 --retry 3 --retry-delay 5 -C - -o "$part" "$url" && break
    fi
    warn "The download of $(basename "$dest") stopped (attempt $attempt of 8); resuming in 10 seconds."
    sleep 10
  done
  if [[ ! -f "$part" ]] || (($(stat -c %s "$part") != size)); then
    die "Could not download $(basename "$dest"); run the script again to resume."
  fi
  if [[ -n "$sha" ]]; then
    info "Checking the SHA-256 of $(basename "$dest")"
    got=$(sha256sum "$part" | awk '{print $1}')
    if [[ "$got" != "$sha" ]]; then
      rm -f "$part"
      die "$(basename "$dest") does not match the SHA-256 Hugging Face lists for it; the broken download was deleted. Run the script again."
    fi
  else
    warn "Hugging Face lists no SHA-256 for $(basename "$dest"); only its size was checked."
  fi
  mv -f "$part" "$dest"
  printf '%s\n' "$(stat -c '%s %Y' "$dest") $sha" >"$dest.verified"
}

# Model files to fetch, one "id<TAB>role<TAB>repo<TAB>rev<TAB>path<TAB>size<TAB>sha" per line.
MODEL_PLAN=""

plan_model() {
  local key=$1 id repo rev regex mmproj_regex files picked line count
  id=$(model_id "$key")
  case "$key" in
    fast)
      repo=$FAST_REPO rev=$FAST_REV
      regex="^${FAST_PREFIX//./\\.}-${FAST_QUANT}(-[0-9]{5}-of-[0-9]{5})?\\.gguf$"
      mmproj_regex=""
      ;;
    reason)
      repo=$REASON_REPO rev=$REASON_REV
      regex="^${REASON_PREFIX//./\\.}-${REASON_QUANT}(-[0-9]{5}-of-[0-9]{5})?\\.gguf$"
      mmproj_regex=$REASON_MMPROJ_REGEX
      ;;
    ocr)
      repo=$OCR_REPO rev=$OCR_REV regex=$OCR_MODEL_REGEX mmproj_regex=$OCR_MMPROJ_REGEX
      ;;
    embed)
      repo=$EMBED_REPO rev=$EMBED_REV regex=$EMBED_MODEL_REGEX mmproj_regex=""
      ;;
  esac
  files=$(hf_list_files "$repo" "$rev")
  picked=$(hf_pick "$regex" <<<"$files")
  [[ -n "$picked" ]] || die "No file in $repo matches $regex. The repository may have renamed its files; check $HF_BASE/$repo/tree/$rev"
  count=$(grep -c . <<<"$picked")
  if ((count > 1)) && grep -qvE -- '-[0-9]{5}-of-[0-9]{5}\.gguf' <<<"$picked"; then
    die "More than one file in $repo matches $regex: $(cut -f1 <<<"$picked" | tr '\n' ' ')"
  fi
  while IFS= read -r line; do MODEL_PLAN+="$id"$'\tmodel\t'"$repo"$'\t'"$rev"$'\t'"$line"$'\n'; done <<<"$picked"
  if [[ -n "$mmproj_regex" ]]; then
    picked=$(hf_pick "$mmproj_regex" <<<"$files" | head -n 1)
    [[ -n "$picked" ]] || die "No vision projector in $repo matches $mmproj_regex."
    MODEL_PLAN+="$id"$'\tmmproj\t'"$repo"$'\t'"$rev"$'\t'"$picked"$'\n'
  fi
}

# The local path of a planned file.
plan_dest() {
  local id=$1 path=$2
  printf '%s/%s/%s' "$MODELS_DIR" "$id" "$(basename "$path")"
}

# The first file of a model (the first part of a split GGUF), or its vision
# projector.
model_file() {
  local id=$1 role=$2
  awk -F'\t' -v id="$id" -v role="$role" '$1 == id && $2 == role {print $5}' <<<"$MODEL_PLAN" | sort | head -n 1 |
    while IFS= read -r path; do plan_dest "$id" "$path"; done
}

remaining_bytes() {
  local id role repo rev path size sha dest have total=0
  while IFS=$'\t' read -r id role repo rev path size sha; do
    [[ -n "$id" ]] || continue
    dest=$(plan_dest "$id" "$path")
    if [[ -f "$dest" ]] && [[ "$(stat -c %s "$dest")" == "$size" ]]; then continue; fi
    have=0
    [[ -f "$dest.part" ]] && have=$(stat -c %s "$dest.part")
    total=$((total + size - have))
  done <<<"$MODEL_PLAN"
  printf '%s' "$total"
}

download_models() {
  step "4. Download the models"
  # The service user must exist first, so the model files can be made
  # readable to it.
  ensure_service_user
  MODEL_PLAN=""
  local key id role repo rev path size sha dest bytes free
  if profile_has reason; then choose_reason_quant; fi
  for key in $(profile_models); do plan_model "$key"; done
  say "Files for the $PROFILE profile:"
  while IFS=$'\t' read -r id role repo rev path size sha; do
    [[ -n "$id" ]] && info "$id: $path ($(human_bytes "$size")) from $repo"
  done <<<"$MODEL_PLAN"
  bytes=$(remaining_bytes)
  if ((bytes == 0)); then
    info "Every file is already downloaded."
  else
    free=$(free_bytes_for "$MODELS_DIR")
    if ((free < bytes + 2000000000)); then
      if ((FAKE_HARDWARE)); then
        warn "Not enough disk space: $(human_bytes "$bytes") to download, $(human_bytes "$free") free (going on: pretend-hardware dry run)."
      else
        die "Not enough disk space: $(human_bytes "$bytes") to download, $(human_bytes "$free") free."
      fi
    fi
    say "$(human_bytes "$bytes") to download. On the hotspot this uses cellular data; a stopped download resumes when you run the script again."
    confirm "Download now?" y || die "The models are needed; run the script again when you are ready to download."
  fi
  run mkdir -p "$MODELS_DIR"
  while IFS=$'\t' read -r id role repo rev path size sha; do
    [[ -n "$id" ]] || continue
    dest=$(plan_dest "$id" "$path")
    if ((DRY_RUN)); then
      printf '[dry-run] would download %s/%s/resolve/%s/%s to %s (%s, SHA-256 %s)\n' "$HF_BASE" "$repo" "$rev" "$path" "$dest" "$(human_bytes "$size")" "${sha:-none listed}"
      continue
    fi
    say "Downloading $(basename "$dest") ($(human_bytes "$size"))"
    download_file "$HF_BASE/$repo/resolve/$rev/$path" "$dest" "$size" "$sha"
  done <<<"$MODEL_PLAN"
  if ((!DRY_RUN)); then
    chown -R root:"$SERVICE_USER" "$MODELS_DIR" 2>/dev/null || true
    chmod -R g+rX,o-rwx "$MODELS_DIR" 2>/dev/null || true
  fi
  remove_stale_models
}

# Whether the plan has a file with this base name for this model.
plan_has_file() {
  local id=$1 name=$2
  awk -F'\t' -v id="$id" -v name="$name" '$1 == id { n = split($5, p, "/"); if (p[n] == name) found = 1 } END { exit !found }' <<<"$MODEL_PLAN"
}

plan_has_model() {
  awk -F'\t' -v id="$1" '$1 == id { found = 1 } END { exit !found }' <<<"$MODEL_PLAN"
}

# Model folders and files this script made that the profile no longer uses,
# such as an earlier quantization of the same model.
remove_stale_models() {
  local dir id f name
  [[ -d "$MODELS_DIR" ]] || return 0
  for dir in "$MODELS_DIR"/*/; do
    dir=${dir%/}
    id=$(basename "$dir")
    if plan_has_model "$id"; then
      for f in "$dir"/*.gguf "$dir"/*.gguf.part; do
        name=$(basename "$f")
        plan_has_file "$id" "${name%.part}" && continue
        if confirm "Delete $name ($(human_bytes "$(stat -c %s "$f")")), which the $PROFILE profile no longer uses?" y; then
          remove_path "$f"
          remove_path "$f.verified"
        fi
      done
      continue
    fi
    if confirm "Delete $dir ($(human_bytes "$(dir_size_bytes "$dir")")), a model the $PROFILE profile does not use?" y; then
      remove_path "$dir"
    fi
  done
}

# The 3-bit 35B-A3B model needs about 17 GB of RAM and VRAM together.
choose_reason_quant() {
  local mem_gib
  mem_gib=$((MEM_TOTAL_KIB / 1048576))
  if [[ "$REASON_QUANT" == "UD-Q3_K_XL" ]] && ((REASON_QUANT_SET == 0)) && ((mem_gib < 14)); then
    say "This computer has $mem_gib GiB of RAM, too little for the 3-bit 35B-A3B model."
    if confirm "Use the smaller 2-bit quantization (UD-Q2_K_XL) instead?" y; then
      REASON_QUANT="UD-Q2_K_XL"
    else
      die "Choose --quant UD-Q2_K_XL or --profile minimal."
    fi
  fi
  info "35B-A3B quantization: $REASON_QUANT"
}

# ===========================================================================
# Step 5: llama-swap config and the service
# ===========================================================================

SERVICE_USER_READY=0

ensure_service_user() {
  ((SERVICE_USER_READY)) && return 0
  SERVICE_USER_READY=1
  if ! getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
    run useradd --system --user-group --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    record_installed "user:$SERVICE_USER"
  fi
  if getent group video >/dev/null 2>&1; then run usermod -aG video "$SERVICE_USER"; fi
  run mkdir -p "$STATE_DIR" "$LOG_DIR" "$ETC_DIR"
  run chown "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR"
  run chmod 0750 "$STATE_DIR"
  run chmod 0700 "$LOG_DIR"
  run chmod 0755 "$ETC_DIR"
  record_installed "dir:$STATE_DIR"
  record_installed "dir:$ETC_DIR"
}

# Works out how many layers of the 35B-A3B model keep their experts in
# system RAM, with llama.cpp's own estimate of what fits in free VRAM. The
# vision projector and its image buffers come on top, so they are added to
# the margin, as llama-server does.
compute_n_cpu_moe() {
  local model=$1 mmproj=$2 margin out line ngl overflow mmproj_mib
  if [[ -n "$N_CPU_MOE" ]]; then
    printf '%s %s' "all" "$N_CPU_MOE"
    return 0
  fi
  if ((DRY_RUN)) || [[ ! -f "$model" ]]; then
    printf '%s %s' "all" "auto"
    return 0
  fi
  mmproj_mib=$(($(stat -c %s "$mmproj") / 1048576))
  margin=$((1024 + mmproj_mib + 512))
  out=$("$(llama_bin llama-fit-params)" --model "$model" --ctx-size "$CTX_REASON" --parallel 1 --fit-target "$margin" 2>/dev/null || true)
  line=$(grep -E '^-c [0-9]+ -ngl' <<<"$out" | tail -n 1 || true)
  if [[ -z "$line" ]]; then
    warn "llama-fit-params gave no answer; keeping every expert in system RAM."
    printf '%s %s' "all" "40"
    return 0
  fi
  ngl=$(awk '{print $4}' <<<"$line")
  overflow=$(grep -o 'blk\\\.[0-9]*\\\.' <<<"$line" | sort -u | grep -c . || true)
  ((overflow > 0)) || overflow=0
  printf '%s %s' "$ngl" "$overflow"
}

# Host memory llama.cpp expects the model to use with these settings, in MiB.
host_mib_needed() {
  local model=$1 ngl=$2 ncmoe=$3 out
  out=$("$(llama_bin llama-fit-params)" --model "$model" --ctx-size "$CTX_REASON" --parallel 1 -ngl "$ngl" --n-cpu-moe "$ncmoe" --fit-print on 2>/dev/null || true)
  awk '$1 == "Host" {print $2 + $3 + $4}' <<<"$out" | tail -n 1
}

tune_reason_model() {
  local model=$1 mmproj=$2 result ngl ncmoe host mem_mib
  result=$(compute_n_cpu_moe "$model" "$mmproj")
  ngl=${result%% *}
  ncmoe=${result##* }
  if [[ "$ncmoe" == auto ]]; then
    info "The dry run cannot measure VRAM; the real run works out --n-cpu-moe with llama-fit-params."
    SAVED_NGL="all"
    SAVED_N_CPU_MOE="auto"
    return 0
  fi
  if ((!DRY_RUN)) && [[ -f "$model" ]]; then
    host=$(host_mib_needed "$model" "$ngl" "$ncmoe")
    mem_mib=$((MEM_TOTAL_KIB / 1024))
    if [[ -n "$host" ]]; then
      info "35B-A3B: $ncmoe of 40 layers keep their experts in system RAM; llama.cpp expects $host MiB of RAM and the rest in VRAM."
      if ((host + 1536 > mem_mib)); then
        warn "That leaves less than 1.5 GiB of the $mem_mib MiB of RAM for everything else. If the model fails to load or runs slowly, run setup again with --quant UD-Q2_K_XL."
      fi
    fi
  fi
  SAVED_NGL=$ngl
  SAVED_N_CPU_MOE=$ncmoe
}

# One model's entry in the llama-swap config. llama-swap fills in ${PORT}.
swap_model_entry() {
  local key=$1 id model mmproj server
  id=$(model_id "$key")
  model=$(model_file "$id" model)
  mmproj=$(model_file "$id" mmproj)
  server=$(llama_bin llama-server)
  printf '  "%s":\n' "$id"
  case "$key" in
    fast)
      printf '    name: "Qwen3.5 4B %s"\n' "$FAST_QUANT"
      printf '    description: "Fast all-rounder for %s"\n' "$(model_tasks fast)"
      ;;
    reason)
      printf '    name: "Qwen3.6 35B-A3B %s"\n' "$REASON_QUANT"
      printf '    description: "Reasoning and vision for %s"\n' "solving, book-map, extraction"
      ;;
    ocr)
      printf '    name: "GLM-OCR Q8_0"\n'
      printf '    description: "Document OCR"\n'
      ;;
    embed)
      printf '    name: "Qwen3 Embedding 0.6B Q8_0"\n'
      printf '    description: "Text embeddings"\n'
      ;;
  esac
  printf '    ttl: 1800\n'
  printf '    cmd: |\n'
  printf '      %s\n' "$server"
  printf '      --host 127.0.0.1\n'
  # shellcheck disable=SC2016 # ${PORT} is llama-swap's macro, written as is
  printf '      --port ${PORT}\n'
  printf '      --no-ui\n'
  printf '      --model %s\n' "$model"
  printf '      --alias %s\n' "$id"
  # One request at a time keeps memory use predictable on 6 GB of VRAM.
  printf '      --parallel 1\n'
  case "$key" in
    fast)
      printf '      # every layer on the GPU\n'
      printf '      --n-gpu-layers all\n'
      printf '      --fit off\n'
      printf '      --ctx-size %s\n' "$CTX_FAST"
      printf '      --cache-ram 1024\n'
      printf '      --jinja\n'
      printf '      --reasoning %s\n' "$REASONING"
      printf "      # Qwen's suggested sampling for answers without thinking\n"
      printf '      --temp 0.7\n'
      printf '      --top-p 0.8\n'
      printf '      --top-k 20\n'
      printf '      --min-p 0\n'
      ;;
    reason)
      printf '      --mmproj %s\n' "$mmproj"
      if [[ -n "$SAVED_N_CPU_MOE" && "$SAVED_N_CPU_MOE" != auto ]]; then
        printf '      # attention and shared weights on the GPU; the experts of the first\n'
        printf '      # %s layers stay in system RAM (setup worked this out from free VRAM)\n' "$SAVED_N_CPU_MOE"
        printf '      --n-gpu-layers %s\n' "${SAVED_NGL:-all}"
        printf '      --n-cpu-moe %s\n' "$SAVED_N_CPU_MOE"
        printf '      --fit off\n'
      else
        printf '      # not measured yet: llama.cpp places layers and experts to fit free\n'
        printf '      # VRAM itself (it only adjusts options left unset, so no -ngl here)\n'
        printf '      --fit on\n'
      fi
      printf '      --ctx-size %s\n' "$CTX_REASON"
      printf '      # memory-mapped weights: under memory pressure the kernel can drop\n'
      printf '      # and re-read expert pages instead of killing the process\n'
      printf '      --load-mode mmap\n'
      printf '      # no prompt cache in RAM; the RAM is needed for the experts\n'
      printf '      --cache-ram 0\n'
      printf '      --jinja\n'
      printf '      --reasoning %s\n' "$REASONING"
      printf '      --temp 0.7\n'
      printf '      --top-p 0.8\n'
      printf '      --top-k 20\n'
      printf '      --min-p 0\n'
      ;;
    ocr)
      printf '      --mmproj %s\n' "$mmproj"
      printf '      --n-gpu-layers all\n'
      printf '      --fit off\n'
      printf '      --ctx-size 8192\n'
      printf '      --cache-ram 0\n'
      printf '      --jinja\n'
      printf '      --temp 0\n'
      ;;
    embed)
      printf '      --embeddings\n'
      printf '      --n-gpu-layers all\n'
      printf '      --fit off\n'
      printf '      --ctx-size 8192\n'
      printf '      --ubatch-size 8192\n'
      printf '      --batch-size 8192\n'
      printf '      --cache-ram 0\n'
      ;;
  esac
}

swap_config() {
  local key
  printf '# llama-swap config written by gmat-llm setup %s. Re-running setup\n' "$GMAT_LLM_SCRIPT_VERSION"
  printf '# rewrites it; change the setup options instead of editing this file.\n'
  printf '# Format: https://github.com/mostlygeek/llama-swap/blob/v%s/docs/config.example.yaml\n' "$LLAMA_SWAP_VERSION"
  printf '\n'
  printf '# A model may take minutes to load the first time (the 35B-A3B reads 17 GB).\n'
  printf 'healthCheckTimeout: 900\n'
  printf 'logLevel: info\n'
  printf 'logToStdout: "proxy,upstream"\n'
  printf 'startPort: %s\n' "$((PORT + 1))"
  printf 'globalTTL: 0\n'
  printf 'sendLoadingState: false\n'
  printf '\n'
  printf '# The key comes from %s, which only root can read.\n' "$SWAP_ENV"
  printf 'apiKeys:\n'
  # shellcheck disable=SC2016 # ${env.X} is llama-swap's macro, written as is
  printf '  - "${env.GMAT_LLM_API_KEY}"\n'
  printf '\n'
  printf '# One model runs at a time; a request for another one swaps it in.\n'
  printf 'models:\n'
  for key in $(profile_models); do swap_model_entry "$key"; done
  if [[ -f "$CLOUD_CONF" && -f "$CLOUD_ENV" ]]; then
    local proxy models
    proxy=$(sed -n 's/^CLOUD_PROXY=//p' "$CLOUD_CONF")
    models=$(sed -n 's/^CLOUD_MODELS=//p' "$CLOUD_CONF")
    if [[ -n "$proxy" && -n "$models" ]]; then
      printf '\n'
      printf '# Cloud models the app uses for generation, approaches and lessons. llama-swap\n'
      printf '# passes their requests on with the cloud key from %s.\n' "$CLOUD_ENV"
      printf 'peers:\n'
      printf '  cloud:\n'
      printf '    proxy: "%s"\n' "$proxy"
      # shellcheck disable=SC2016 # llama-swap's macro, written as is
      printf '    apiKey: "${env.GMAT_LLM_CLOUD_API_KEY}"\n'
      printf '    models:\n'
      tr ',' '\n' <<<"$models" | sed '/^$/d' | while IFS= read -r m; do printf '      - "%s"\n' "$m"; done
    fi
  fi
}

memory_max_bytes() {
  local total=$((MEM_TOTAL_KIB * 1024))
  # Leave 1 GiB for sshd, systemd and the rest, so they stay responsive even
  # if the model runs out of memory.
  printf '%s' "$((total - 1073741824))"
}

service_unit() {
  cat <<EOF
# Written by gmat-llm setup. Re-running setup rewrites it.
[Unit]
Description=GMAT prep local LLM endpoint (llama-swap on 127.0.0.1:$PORT)
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
SupplementaryGroups=video
EnvironmentFile=$SWAP_ENV
EnvironmentFile=-$CLOUD_ENV
Environment=HOME=$STATE_DIR
WorkingDirectory=$STATE_DIR
ExecStart=$LLAMA_SWAP_ROOT/current/llama-swap -config $SWAP_CONFIG -listen 127.0.0.1:$PORT
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
KillMode=control-group
# The models count against this limit, so a model that runs out of memory is
# stopped before sshd or the rest of the system are starved.
MemoryMax=$(memory_max_bytes)
OOMScoreAdjust=500
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
ReadWritePaths=$STATE_DIR $LOG_DIR

[Install]
WantedBy=multi-user.target
EOF
}

ensure_api_key() {
  if [[ -f "$SWAP_ENV" ]] && grep -qE '^GMAT_LLM_API_KEY=gmat-[A-Za-z0-9]{40}$' "$SWAP_ENV"; then
    info "The API key exists ($SWAP_ENV)."
    return 0
  fi
  if ((DRY_RUN)); then
    printf '[dry-run] would make a random API key and write it to %s (root only)\n' "$SWAP_ENV"
    return 0
  fi
  local random
  # 48 random bytes give about 62 letters and digits once base64's + / = are
  # dropped; 40 of them are kept (about 238 bits).
  random=$(head -c 48 /dev/urandom | base64 -w 0 | tr -dc 'A-Za-z0-9')
  ((${#random} >= 40)) || die "Could not make a random API key."
  API_KEY_NEW="gmat-${random:0:40}"
  # Letters, digits and one dash: safe in an environment file, a YAML string
  # and an HTTP header.
  printf 'GMAT_LLM_API_KEY=%s\n' "$API_KEY_NEW" | write_secret_file "$SWAP_ENV" 0600 root:root
  info "Made a new API key ($SWAP_ENV, readable by root only)."
}

validate_swap_config() {
  local file=$1 cloud_key=""
  ((DRY_RUN)) && return 0
  # The keys are read as text, not run as shell code.
  if [[ -f "$CLOUD_ENV" ]]; then cloud_key=$(sed -n 's/^GMAT_LLM_CLOUD_API_KEY=//p' "$CLOUD_ENV" | head -n 1); fi
  GMAT_LLM_API_KEY=$(api_key) GMAT_LLM_CLOUD_API_KEY=$cloud_key \
    "$LLAMA_SWAP_ROOT/current/llama-swap" -config "$file" -validate >/dev/null 2>&1
}

# Other programs using the GPU leave less VRAM for the models.
warn_other_gpu_users() {
  local apps
  ((DRY_RUN || FAKE_HARDWARE)) && return 0
  apps=$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader 2>/dev/null || true)
  apps=$(sed '/^$/d' <<<"$apps")
  if [[ -n "$apps" ]]; then
    warn "Other programs are using the GPU, so less VRAM is free for the models:"
    printf '%s\n' "$apps" | indent >&2
  fi
}

write_config_and_service() {
  step "5. Write the llama-swap config and the service"
  ensure_service_user
  ensure_api_key
  if profile_has reason; then
    # Measure free VRAM with no model of ours loaded.
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
      run systemctl stop "$SERVICE_NAME"
    fi
    warn_other_gpu_users
    tune_reason_model "$(model_file "$REASON_ID" model)" "$(model_file "$REASON_ID" mmproj)"
  fi
  local config unit
  config=$(swap_config)
  if printf '%s\n' "$config" | file_differs "$SWAP_CONFIG"; then
    printf '%s\n' "$config" | write_file "$SWAP_CONFIG" 0644 root:root
    CONFIG_CHANGED=1
  else
    info "$SWAP_CONFIG is up to date."
  fi
  if ((!DRY_RUN)); then
    validate_swap_config "$SWAP_CONFIG" || die "llama-swap rejects $SWAP_CONFIG; run: sudo $LLAMA_SWAP_ROOT/current/llama-swap -config $SWAP_CONFIG -validate"
    info "llama-swap accepts the config."
  fi
  unit=$(service_unit)
  if printf '%s\n' "$unit" | file_differs "$SERVICE_FILE"; then
    printf '%s\n' "$unit" | write_file "$SERVICE_FILE" 0644 root:root
    record_installed "file:$SERVICE_FILE"
    run systemctl daemon-reload
    CONFIG_CHANGED=1
  fi
  run systemctl enable "$SERVICE_NAME"
  save_setup_conf
  if ((CONFIG_CHANGED)) || ! systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    run systemctl restart "$SERVICE_NAME"
  fi
  wait_for_endpoint || die "The endpoint did not start; see: sudo journalctl -u $SERVICE_NAME -n 50"
}

wait_for_endpoint() {
  local i
  ((DRY_RUN)) && return 0
  for i in $(seq 1 30); do
    if [[ "$(curl --noproxy '*' -s --max-time 2 "http://127.0.0.1:$PORT/health" || true)" == "OK" ]]; then
      info "llama-swap answers on 127.0.0.1:$PORT."
      return 0
    fi
    sleep 1
  done
  return 1
}

# ===========================================================================
# Step 6: tunnel access, firewall and lid
# ===========================================================================

ensure_tunnel_user() {
  if ! getent passwd "$TUNNEL_USER" >/dev/null 2>&1; then
    run useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$TUNNEL_USER"
    record_installed "user:$TUNNEL_USER"
  fi
  # "*" instead of the locked "!" lets key logins work even where sshd runs
  # without PAM; there is still no password that works.
  run usermod -p '*' "$TUNNEL_USER"
  run mkdir -p "$AUTH_KEYS_DIR"
  run chmod 0755 "$AUTH_KEYS_DIR"
  if [[ ! -f "$AUTH_KEYS_FILE" ]]; then
    printf '# Mac keys allowed to open the GMAT prep LLM tunnel. Manage with gmat-llm add-client.\n' | write_file "$AUTH_KEYS_FILE" 0644 root:root
  fi
}

sshd_dropin() {
  cat <<EOF
# Written by gmat-llm setup. The tunnel user may only forward one local port,
# to the LLM endpoint; it gets no shell, no remote forwarding and no password
# login. Other users are not affected.
Match User $TUNNEL_USER
    AuthorizedKeysFile $AUTH_KEYS_FILE
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:$PORT
    PermitListen none
    GatewayPorts no
    AllowAgentForwarding no
    AllowStreamLocalForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitTTY no
    ForceCommand /usr/sbin/nologin
EOF
}

# The effective sshd settings for a connection by the tunnel user.
sshd_effective_for_tunnel() {
  local sshd
  sshd=$(sshd_binary)
  [[ -n "$sshd" ]] || return 1
  mkdir -p /run/sshd
  "$sshd" -T -C "user=$TUNNEL_USER,host=gmat-llm-check,addr=127.0.0.1" 2>/dev/null
}

setup_ssh_access() {
  ensure_tunnel_user
  if [[ ! -f /etc/ssh/sshd_config ]] && ((DRY_RUN)); then
    printf '[dry-run] openssh-server is installed in step 3; its sshd_config reads sshd_config.d by default\n'
  elif ! grep -qE '^[[:space:]]*Include[[:space:]]+(/etc/ssh/)?sshd_config\.d/\*\.conf' /etc/ssh/sshd_config 2>/dev/null; then
    say "/etc/ssh/sshd_config does not read /etc/ssh/sshd_config.d, where the tunnel rules go."
    if confirm "Back up sshd_config and add 'Include /etc/ssh/sshd_config.d/*.conf' at its top?" y; then
      backup_path /etc/ssh/sshd_config
      if ((DRY_RUN)); then
        printf '[dry-run] would add the Include line at the top of /etc/ssh/sshd_config\n'
      else
        { printf 'Include /etc/ssh/sshd_config.d/*.conf\n\n'; cat /etc/ssh/sshd_config; } >/etc/ssh/sshd_config.gmat-llm.new
        chmod --reference=/etc/ssh/sshd_config /etc/ssh/sshd_config.gmat-llm.new
        mv -f /etc/ssh/sshd_config.gmat-llm.new /etc/ssh/sshd_config
      fi
    else
      die "The tunnel needs the sshd_config.d drop-in; add the Include line and run again."
    fi
  fi
  local content previous=""
  content=$(sshd_dropin)
  [[ -f "$SSHD_DROPIN" ]] && previous=$(cat "$SSHD_DROPIN")
  if [[ "$content" != "$previous" ]]; then
    [[ -f "$SSHD_DROPIN" ]] && backup_path "$SSHD_DROPIN"
    printf '%s\n' "$content" | write_file "$SSHD_DROPIN" 0644 root:root
    record_installed "file:$SSHD_DROPIN"
    if sshd_config_ok; then
      reload_sshd
    else
      warn "sshd -t rejects the new drop-in; removing it again."
      if [[ -n "$previous" ]]; then printf '%s\n' "$previous" | write_file "$SSHD_DROPIN" 0644 root:root; else run rm -f "$SSHD_DROPIN"; fi
      die "The SSH server config did not accept the tunnel rules; nothing was reloaded."
    fi
  else
    info "The SSH rules for $TUNNEL_USER are in place ($SSHD_DROPIN)."
  fi
  if ((!DRY_RUN)); then
    local effective
    effective=$(sshd_effective_for_tunnel || true)
    if grep -q '^allowtcpforwarding local' <<<"$effective" && grep -q "^permitopen 127.0.0.1:$PORT" <<<"$effective" && grep -q '^permitlisten none' <<<"$effective"; then
      info "sshd applies the tunnel rules: local forwarding to 127.0.0.1:$PORT only."
    else
      die "sshd does not apply the rules in $SSHD_DROPIN to $TUNNEL_USER (check with: sudo sshd -T -C user=$TUNNEL_USER,host=x,addr=127.0.0.1)."
    fi
  fi
}

ssh_ports() {
  local sshd ports
  sshd=$(sshd_binary)
  if [[ -n "$sshd" ]]; then
    mkdir -p /run/sshd 2>/dev/null || true
    ports=$("$sshd" -T 2>/dev/null | awk '$1 == "port" {print $2}' | sort -u || true)
  fi
  [[ -n "${ports:-}" ]] || ports=22
  if [[ -n "$SSH_SESSION_PORT" && "$SSH_SESSION_PORT" =~ ^[0-9]+$ ]] && ! grep -qx "$SSH_SESSION_PORT" <<<"$ports"; then
    ports+=$'\n'"$SSH_SESSION_PORT"
  fi
  printf '%s\n' "$ports"
}

# Programs other than sshd and avahi that accept connections from the
# network; the firewall will block them.
warn_network_listeners() {
  local listeners line addr name others=""
  listeners=$(ss -ltnpH 2>/dev/null || true)
  while read -r line; do
    [[ -n "$line" ]] || continue
    addr=$(awk '{print $4}' <<<"$line")
    case "$addr" in 127.* | "[::1]"* | "::1"*) continue ;; esac
    name=$(grep -o '(("[^"]*"' <<<"$line" | first_line | tr -d '("' || true)
    case "$name" in sshd | systemd | avahi-daemon | systemd-resolve) continue ;; esac
    others+="$addr ${name:-unknown}"$'\n'
  done <<<"$listeners"
  if [[ -n "$others" ]]; then
    say "These programs accept connections from the network; after this step the firewall blocks them unless you add a rule (sudo ufw allow PORT/tcp):"
    printf '%s' "$others" | indent
  fi
}

setup_firewall() {
  local port status
  status=$(ufw status 2>/dev/null | first_line || true)
  say "Firewall (ufw): deny incoming by default, SSH open with rate limiting. ${status:-ufw not installed}"
  warn_network_listeners
  for port in $(ssh_ports); do
    run ufw limit "$port/tcp" comment "SSH, kept open by gmat-llm"
    record_installed "ufw:limit $port/tcp"
  done
  run ufw default deny incoming
  run ufw default allow outgoing
  if [[ "$status" != *"Status: active"* ]]; then
    # Open connections, this SSH session included, stay up when ufw starts.
    run ufw --force enable
    record_installed "ufw:enabled"
  fi
  info "mDNS (UDP 5353 to 224.0.0.251) is allowed by ufw's default rules, so $(hostname).local keeps working."
}

setup_keep_awake() {
  ((KEEP_AWAKE)) || return 0
  say "Keeping the laptop running with the lid closed."
  write_file "$LOGIND_DROPIN" 0644 root:root <<'EOF'
# Written by gmat-llm setup (--keep-awake): closing the lid does nothing.
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF
  record_installed "file:$LOGIND_DROPIN"
  # Masked sleep targets take effect at once, without restarting logind.
  run systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
  record_installed "masked-sleep"
}

setup_access() {
  step "6. Tunnel access, API key, firewall"
  setup_ssh_access
  setup_firewall
  setup_keep_awake
}

# ===========================================================================
# Step 7: health checks
# ===========================================================================

api_key() {
  sed -n 's/^GMAT_LLM_API_KEY=//p' "$SWAP_ENV" 2>/dev/null | head -n 1
}

# A 96x48 PNG showing the digits 42, made with the standard library.
test_image_base64() {
  python3 -I -c '
import base64, struct, zlib
glyphs = {
    "4": ["10001", "10001", "10001", "11111", "00001", "00001", "00001"],
    "2": ["11110", "00001", "00001", "01110", "10000", "10000", "11111"],
}
scale, width, height = 6, 96, 48
pixels = [[255] * width for _ in range(height)]
x0 = 12
for ch in "42":
    for gy, row in enumerate(glyphs[ch]):
        for gx, bit in enumerate(row):
            if bit == "1":
                for dy in range(scale):
                    for dx in range(scale):
                        pixels[3 + gy * scale + dy][x0 + gx * scale + dx] = 0
    x0 += 6 * scale + 6
raw = b"".join(b"\x00" + bytes(row) for row in pixels)
def chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
print(base64.b64encode(png).decode())
'
}

# chat_request MODEL KIND: prints a request body; KIND is text, json or image.
chat_request() {
  local model=$1 kind=$2 image=""
  [[ "$kind" == image ]] && image=$(test_image_base64)
  python3 -I -c '
import json, sys
model, kind, image = sys.argv[1], sys.argv[2], sys.argv[3]
if kind == "text":
    body = {"model": model, "max_tokens": 32,
            "messages": [{"role": "user", "content": "Reply with the single word: ready"}]}
elif kind == "json":
    schema = {"type": "object", "properties": {"answer": {"type": "string", "enum": ["A", "B", "C", "D", "E"]}},
              "required": ["answer"], "additionalProperties": False}
    body = {"model": model, "max_tokens": 64,
            "messages": [{"role": "system", "content": "Reply with JSON only."},
                         {"role": "user", "content": "What is 2 + 2? (A) 3 (B) 4 (C) 5 (D) 6 (E) 7"}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "check", "strict": True, "schema": schema}}}
else:
    body = {"model": model, "max_tokens": 32,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "What number is written in this image? Reply with the digits only."},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + image}}]}]}
print(json.dumps(body))
' "$model" "$kind" "$image"
}

# Sends a request through llama-swap and prints the reply body; fails on an
# HTTP error.
endpoint_post() {
  local path=$1 body=$2 timeout=${3:-900} key out code
  key=$(api_key)
  out=$(mktemp)
  code=$(curl --noproxy '*' -sS -o "$out" -w '%{http_code}' --max-time "$timeout" -H "Authorization: Bearer $key" -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:$PORT$path" <<<"$body" || true)
  if [[ "$code" != 200 ]]; then
    printf 'HTTP %s: %s\n' "${code:-none}" "$(head -c 400 "$out")" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

reply_summary() {
  python3 -I -c '
import json, sys
reply = json.load(sys.stdin)
message = reply["choices"][0]["message"]
content = (message.get("content") or "").strip().replace("\n", " ")
timings = reply.get("timings") or {}
print("%s\t%.1f\t%.1f" % (content[:80], timings.get("prompt_per_second") or 0, timings.get("predicted_per_second") or 0))
'
}

model_memory_report() {
  local main pid rss_kib vram avail
  main=$(systemctl show -p MainPID --value "$SERVICE_NAME" 2>/dev/null || true)
  pid=$(pgrep -P "${main:-0}" 2>/dev/null | head -n 1 || true)
  rss_kib=0
  [[ -n "$pid" ]] && rss_kib=$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null || printf 0)
  vram=$(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1 | awk -F', ' '{printf "%s of %s MiB VRAM", $1, $2}' || true)
  avail=$(awk '/^MemAvailable:/ {printf "%.1f GiB of RAM still available", $2 / 1048576}' /proc/meminfo)
  printf '%s; model process uses %s MiB of RAM; %s' "${vram:-VRAM unknown}" "$((rss_kib / 1024))" "$avail"
}

journal_since() {
  journalctl -u "$SERVICE_NAME" --since "@$1" --no-pager -o cat 2>/dev/null || true
}

ran_out_of_memory() {
  grep -qiE 'out of memory|cudaMalloc failed|failed to allocate|unable to allocate|oom-kill|Killed process' <<<"$1"
}

test_one_model() {
  local key=$1 id reply summary content pps tps failures=0 started
  id=$(model_id "$key")
  say "Testing $id ($(model_tasks "$key"))"
  started=$(date +%s)
  if [[ "$key" == embed ]]; then
    reply=$(endpoint_post /v1/embeddings "{\"model\": \"$id\", \"input\": \"GMAT prep\"}" 600) || {
      warn "$id did not answer an embeddings request."
      return 1
    }
    info "embeddings: $(json_get data.0.embedding <<<"$reply" | python3 -I -c 'import json, sys; print(len(json.load(sys.stdin)))') dimensions"
    info "memory: $(model_memory_report)"
    return 0
  fi
  if [[ "$key" != ocr ]]; then
    if reply=$(endpoint_post /v1/chat/completions "$(chat_request "$id" text)" 900); then
      summary=$(reply_summary <<<"$reply")
      IFS=$'\t' read -r content pps tps <<<"$summary"
      info "chat: \"$content\" (prompt $pps tokens/s, generation $tps tokens/s, first answer after $(($(date +%s) - started)) s including loading)"
    else
      failures=$((failures + 1))
      local log
      log=$(journal_since "$started")
      if ran_out_of_memory "$log"; then
        warn "$id ran out of memory while loading."
        return 2
      fi
      warn "$id did not answer a chat request."
      return 1
    fi
    if reply=$(endpoint_post /v1/chat/completions "$(chat_request "$id" json)" 300); then
      content=$(json_get choices.0.message.content <<<"$reply")
      # The check is that the reply is JSON of exactly the requested shape;
      # whether the model got 2 + 2 right is reported but not required.
      local answer
      answer=$(python3 -I -c '
import json, sys
value = json.loads(sys.argv[1])
assert isinstance(value, dict) and set(value) == {"answer"} and value["answer"] in "ABCDE" and len(value["answer"]) == 1
print(value["answer"])
' "$content" 2>/dev/null || true)
      if [[ -n "$answer" ]]; then
        if [[ "$answer" == B ]]; then
          info "JSON schema (response_format json_schema): $content, the right answer"
        else
          info "JSON schema (response_format json_schema): $content, valid JSON of the requested shape (the model picked the wrong option)"
        fi
      else
        warn "$id did not follow the JSON schema: $content"
        failures=$((failures + 1))
      fi
    else
      warn "$id refused a response_format json_schema request; set the app's JSON mode to JSON mode (json-object) instead."
      failures=$((failures + 1))
    fi
  fi
  if [[ "$key" == reason || "$key" == ocr ]]; then
    if reply=$(endpoint_post /v1/chat/completions "$(chat_request "$id" image)" 600); then
      summary=$(reply_summary <<<"$reply")
      IFS=$'\t' read -r content pps tps <<<"$summary"
      if [[ "$content" == *42* ]]; then
        info "vision: read \"$content\" from a test image (prompt $pps tokens/s)"
      else
        warn "$id read \"$content\" from a test image showing 42."
        failures=$((failures + 1))
      fi
    else
      local log
      log=$(journal_since "$started")
      if ran_out_of_memory "$log"; then
        warn "$id ran out of memory reading an image."
        return 2
      fi
      warn "$id did not answer a vision request."
      failures=$((failures + 1))
    fi
  fi
  info "memory: $(model_memory_report)"
  ((failures == 0))
}

# Unauthenticated requests must be refused.
test_api_key_enforced() {
  local code
  code=$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/v1/models" || true)
  if [[ "$code" == 401 ]]; then
    info "Requests without the API key are refused (401)."
  else
    warn "A request without the API key got HTTP $code instead of 401."
    return 1
  fi
}

run_health_checks() {
  local key result failed=0 attempt
  if ((DRY_RUN)); then
    printf '[dry-run] would send a chat request, a response_format json_schema request and, for the vision models, an image to each model through llama-swap, and report tokens per second and memory use\n'
    return 0
  fi
  test_api_key_enforced || failed=1
  for key in $(profile_models); do
    attempt=1
    while true; do
      result=0
      test_one_model "$key" || result=$?
      if ((result == 2)) && [[ "$key" == reason ]] && ((attempt <= 3)); then
        if [[ "$SAVED_N_CPU_MOE" =~ ^[0-9]+$ ]] && ((SAVED_N_CPU_MOE < 40)); then
          SAVED_N_CPU_MOE=$((SAVED_N_CPU_MOE + 3))
          ((SAVED_N_CPU_MOE > 40)) && SAVED_N_CPU_MOE=40
          say "Keeping the experts of $SAVED_N_CPU_MOE layers in system RAM and trying again."
          swap_config | write_file "$SWAP_CONFIG" 0644 root:root
          save_setup_conf
          systemctl restart "$SERVICE_NAME"
          wait_for_endpoint || true
          attempt=$((attempt + 1))
          continue
        fi
      fi
      break
    done
    if ((result != 0)); then
      failed=1
      if ((result == 2)) && [[ "$key" == reason ]]; then
        warn "The 35B-A3B model does not fit even with every expert in system RAM. Run setup again with --quant UD-Q2_K_XL."
      fi
    fi
  done
  return "$failed"
}

health_checks() {
  step "7. Health checks"
  if run_health_checks; then
    ((DRY_RUN)) || info "Every model answered."
  else
    warn "Some checks failed; see above. Logs: sudo gmat-llm logs"
  fi
}

# ===========================================================================
# Step 8: install the management command and print the summary
# ===========================================================================

install_self() {
  local source
  source=$(readlink -f "${BASH_SOURCE[0]}")
  if [[ "$source" != "$SELF_INSTALL_PATH" ]]; then
    run mkdir -p "$BIN_DIR"
    run install -m 0755 -o root -g root "$source" "$SELF_INSTALL_PATH"
  fi
  run ln -sfn "$SELF_INSTALL_PATH" "$SELF_LINK"
  record_installed "file:$SELF_LINK"
  record_installed "dir:$INSTALL_ROOT"
}

host_key_fingerprint() {
  local fp
  fp=$(ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{print $2}' || true)
  printf '%s' "${fp:-not found (no /etc/ssh/ssh_host_ed25519_key.pub)}"
}

print_summary() {
  local key ip_list
  step "8. Summary"
  install_self
  ip_list=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | tr '\n' ' ' || true)
  say "The endpoint: http://127.0.0.1:$PORT/v1 on this computer only (llama-swap, OpenAI-compatible)."
  say "Models and the app tasks they serve:"
  for key in $(profile_models); do info "$(model_id "$key"): $(model_tasks "$key")"; done
  say "Generation, approaches and lessons stay on your cloud model (see docs/local-llm.md)."
  say ""
  say "This computer: $(hostname) ($(hostname).local), addresses ${ip_list:-none}, SSH port(s) $(ssh_ports | tr '\n' ' ')"
  say "SSH host key (ED25519): $(host_key_fingerprint)"
  if [[ -n "$API_KEY_NEW" ]]; then
    say ""
    say "The API key, shown once (later: sudo gmat-llm show-api-key):"
    to_tty "  $API_KEY_NEW"
  fi
  say ""
  say "Pairing the Mac:"
  info "1. On the Mac, in the gmat-prep repo, run: scripts/local-llm/start-gmat-prep-mac.sh"
  info "2. It finds this computer, shows the host key above for you to compare, and installs its own"
  info "   tunnel key over your SSH login, or prints a command like this to run here:"
  info "   sudo gmat-llm add-client 'ssh-ed25519 AAAA... gmat-prep-mac'"
  info "3. It opens the tunnel, starts the app and sets the app's LLM settings."
  say ""
  say "Manage the server with: sudo gmat-llm status | test | logs | restart | add-client | remove-client | uninstall"
  if [[ -n "$BACKUP_DIR" ]]; then say "Backups of changed files: $BACKUP_DIR"; fi
  say "Log of this run: $LOG_FILE"
}

# ===========================================================================
# Management commands
# ===========================================================================

require_root() {
  ((EUID == 0)) || die "Run this with sudo."
}

require_installed() {
  [[ -f "$SETUP_CONF" ]] || die "The server is not set up yet; run the setup first."
  load_setup_conf
  MEM_TOTAL_KIB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
}

cmd_status() {
  require_root
  require_installed
  say "Service $SERVICE_NAME: $(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true) ($(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true))"
  say "Endpoint: http://127.0.0.1:$PORT/v1, health: $(curl --noproxy '*' -s --max-time 3 "http://127.0.0.1:$PORT/health" || printf 'no answer')"
  local key models running
  key=$(api_key)
  models=$(curl --noproxy '*' -s --max-time 5 -H "Authorization: Bearer $key" "http://127.0.0.1:$PORT/v1/models" | python3 -I -c 'import json, sys; print(" ".join(m["id"] for m in json.load(sys.stdin)["data"]))' 2>/dev/null || true)
  running=$(curl --noproxy '*' -s --max-time 5 -H "Authorization: Bearer $key" "http://127.0.0.1:$PORT/running" | python3 -I -c 'import json, sys
data = json.load(sys.stdin)
items = data.get("running", data) if isinstance(data, dict) else data
print(" ".join("%s (%s)" % (r.get("model"), r.get("state")) for r in items))' 2>/dev/null || true)
  say "Models: ${models:-unknown}"
  say "Loaded now: ${running:-none}"
  say "Memory: $(model_memory_report)"
  say "Profile $PROFILE, 35B-A3B quantization $REASON_QUANT, --n-cpu-moe ${SAVED_N_CPU_MOE:-not set}, reasoning $REASONING"
  say "Tunnel keys ($AUTH_KEYS_FILE):"
  list_client_keys | sed 's/^/  /'
  say "SSH host key (ED25519): $(host_key_fingerprint)"
  say "Addresses: $(ip -4 -o addr show scope global 2>/dev/null | awk '{print $2 " " $4}' | tr '\n' ' ')"
  say "Firewall: $(ufw status 2>/dev/null | head -n 1 || printf 'ufw not installed')"
  say "Recent errors:"
  journalctl -u "$SERVICE_NAME" -p err -n 10 --no-pager -o short 2>/dev/null | sed 's/^/  /' || true
}

list_client_keys() {
  local line n=0 tmp
  [[ -f "$AUTH_KEYS_FILE" ]] || {
    printf 'none\n'
    return 0
  }
  tmp=$(mktemp)
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# || -z "$line" ]] && continue
    printf '%s\n' "$line" >"$tmp"
    printf '%s\n' "$(ssh-keygen -l -f "$tmp" 2>/dev/null || printf 'unreadable key line')"
    n=$((n + 1))
  done <"$AUTH_KEYS_FILE"
  rm -f "$tmp"
  ((n > 0)) || printf 'none\n'
}

cmd_add_client() {
  require_root
  require_installed
  local key=${1:-} tmp type blob comment fp
  [[ -n "$key" ]] || die "Give the Mac's public key in quotes: sudo gmat-llm add-client 'ssh-ed25519 AAAA... name'"
  [[ "$key" != *PRIVATE* ]] || die "That is a private key. Give the public key (the .pub file)."
  key=$(tr -d '\r' <<<"$key" | head -n 1)
  read -r type blob comment <<<"$key"
  case "$type" in
    ssh-ed25519 | ecdsa-sha2-nistp256 | ecdsa-sha2-nistp384 | ecdsa-sha2-nistp521 | sk-ssh-ed25519@openssh.com | ssh-rsa) ;;
    *) die "Not an SSH public key: it should start with ssh-ed25519." ;;
  esac
  [[ "$blob" =~ ^[A-Za-z0-9+/=]+$ ]] || die "The key is damaged: its second word is not base64."
  comment=$(tr -cd 'A-Za-z0-9@._ -' <<<"${comment:-gmat-prep-mac}")
  tmp=$(mktemp)
  printf '%s %s %s\n' "$type" "$blob" "$comment" >"$tmp"
  fp=$(ssh-keygen -l -f "$tmp" 2>/dev/null | awk '{print $2}') || true
  rm -f "$tmp"
  [[ -n "$fp" ]] || die "ssh-keygen does not accept the key."
  if [[ "$type" == ssh-rsa ]] && (($(ssh-keygen -l -f <(printf '%s %s\n' "$type" "$blob") | awk '{print $1}') < 3072)); then
    die "RSA keys need at least 3072 bits; make an ed25519 key instead."
  fi
  if [[ -f "$AUTH_KEYS_FILE" ]] && grep -qF -- " $blob" "$AUTH_KEYS_FILE"; then
    say "This key is already allowed ($fp)."
    return 0
  fi
  printf 'restrict,port-forwarding,permitopen="127.0.0.1:%s" %s %s %s\n' "$PORT" "$type" "$blob" "$comment" >>"$AUTH_KEYS_FILE"
  chmod 0644 "$AUTH_KEYS_FILE"
  say "Allowed $fp ($comment) to open the tunnel to 127.0.0.1:$PORT as $TUNNEL_USER."
}

cmd_remove_client() {
  require_root
  require_installed
  local match=${1:-} tmp line kept removed=0 lfp linetmp
  if [[ -z "$match" ]]; then
    say "Tunnel keys:"
    list_client_keys | sed 's/^/  /'
    say "Remove one with: sudo gmat-llm remove-client <part of its fingerprint or name>, or all."
    return 0
  fi
  tmp=$(mktemp)
  linetmp=$(mktemp)
  while IFS= read -r line; do
    kept=1
    if [[ -n "$line" && ! "$line" =~ ^[[:space:]]*# ]]; then
      printf '%s\n' "$line" >"$linetmp"
      lfp=$(ssh-keygen -l -f "$linetmp" 2>/dev/null || true)
      if [[ "$match" == all || "$lfp" == *"$match"* ]]; then
        kept=0
        removed=$((removed + 1))
        say "Removing $lfp"
      fi
    fi
    ((kept)) && printf '%s\n' "$line" >>"$tmp"
  done <"$AUTH_KEYS_FILE"
  rm -f "$linetmp"
  if ((removed == 0)); then
    rm -f "$tmp"
    say "No key matches \"$match\"."
    return 0
  fi
  chmod 0644 "$tmp"
  mv -f "$tmp" "$AUTH_KEYS_FILE"
  say "Removed $removed key(s). Tunnels already open stay open until they end; restart sshd's sessions with a reboot if needed."
}

cmd_show_api_key() {
  require_root
  require_installed
  local key
  key=$(api_key)
  [[ -n "$key" ]] || die "No API key in $SWAP_ENV."
  printf 'GMAT_LLM_API_KEY=%s\n' "$key"
}

# set-cloud --base-url URL --models a,b[,c] [--key-file FILE]: sends the
# cloud models the app uses for generation, approaches and lessons through
# llama-swap to the cloud API. The cloud API key comes from FILE or standard
# input, so it never appears in a command line.
cmd_set_cloud() {
  require_root
  require_installed
  local base_url="" models="" key="" key_file="" proxy
  while (($#)); do
    case "$1" in
      --base-url | --models | --key-file)
        (($# >= 2)) || die "$1 needs a value."
        case "$1" in
          --base-url) base_url=$2 ;;
          --models) models=$2 ;;
          --key-file) key_file=$2 ;;
        esac
        shift 2
        ;;
      *) die "Unknown option for set-cloud: $1" ;;
    esac
  done
  [[ "$base_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] || die "Give the cloud API's https base URL, such as https://api.openai.com/v1 (--base-url)."
  [[ "$base_url" == */v1 || "$base_url" == */v1/ ]] || die "The base URL must end in /v1; llama-swap adds /v1/chat/completions to what comes before it."
  [[ "$models" =~ ^[A-Za-z0-9._:/@-]+(,[A-Za-z0-9._:/@-]+)*$ ]] || die "Give the cloud model names, comma-separated (--models)."
  proxy=${base_url%/}
  proxy=${proxy%/v1}
  if [[ -n "$key_file" ]]; then
    [[ -f "$key_file" ]] || die "No such key file: $key_file"
    key=$(sed -n 1p "$key_file")
  else
    if [[ -t 0 ]]; then printf 'Paste the cloud API key, then press Enter: ' >&2; fi
    IFS= read -r key || true
  fi
  key=$(tr -d '\r\n' <<<"$key")
  # API keys are letters, digits and a few separators. Other characters could
  # change how systemd reads the environment file, so they are refused.
  [[ "$key" =~ ^[A-Za-z0-9._~+/=:-]{8,1000}$ ]] || die "The cloud API key should be 8 or more letters, digits or . _ ~ + / = : - characters."
  printf 'GMAT_LLM_CLOUD_API_KEY=%s\n' "$key" | write_secret_file "$CLOUD_ENV" 0600 root:root
  printf 'CLOUD_PROXY=%s\nCLOUD_MODELS=%s\n' "$proxy" "$models" | write_file "$CLOUD_CONF" 0644 root:root
  swap_config_from_saved
  say "Cloud models $models now go through the endpoint to $proxy."
}

cmd_clear_cloud() {
  require_root
  require_installed
  rm -f "$CLOUD_ENV" "$CLOUD_CONF"
  swap_config_from_saved
  say "Cloud models no longer go through the endpoint."
}

# Rebuilds the model plan from the files setup downloaded, for commands run
# after setup.
load_model_plan_from_disk() {
  MODEL_PLAN=""
  local key id f name role
  for key in $(profile_models); do
    id=$(model_id "$key")
    for f in "$MODELS_DIR/$id"/*.gguf; do
      name=$(basename "$f")
      if [[ "$name" == mmproj* ]]; then role=mmproj; else role=model; fi
      MODEL_PLAN+="$id"$'\t'"$role"$'\t-\t-\t'"$name"$'\t0\t\n'
    done
    [[ -n "$(model_file "$id" model)" ]] || die "The model files of $id are missing from $MODELS_DIR/$id; run the setup again."
  done
}

# Rewrites the llama-swap config from the saved setup choices and restarts
# the service.
swap_config_from_saved() {
  load_model_plan_from_disk
  SAVED_NGL=${SAVED_NGL:-all}
  swap_config | write_file "$SWAP_CONFIG" 0644 root:root
  validate_swap_config "$SWAP_CONFIG" || die "llama-swap rejects the new config."
  systemctl restart "$SERVICE_NAME"
  wait_for_endpoint || die "The endpoint did not come back; see: sudo gmat-llm logs"
}

cmd_restart() {
  require_root
  require_installed
  systemctl restart "$SERVICE_NAME"
  wait_for_endpoint || die "The endpoint did not start; see: sudo gmat-llm logs"
}

cmd_logs() {
  require_root
  if [[ "${1:-}" == -f ]]; then
    journalctl -u "$SERVICE_NAME" -f
  else
    journalctl -u "$SERVICE_NAME" -n 200 --no-pager
  fi
}

cmd_test() {
  require_root
  require_installed
  load_model_plan_from_disk
  wait_for_endpoint || die "The endpoint is not running; start it with: sudo gmat-llm restart"
  if run_health_checks; then say "Every model answered."; else die "Some checks failed; see above."; fi
}

cmd_uninstall() {
  require_root
  local item models_bytes
  say "This removes the GMAT prep LLM server: the service, llama.cpp, llama-swap, the config and keys, the tunnel user and its SSH rules."
  confirm "Go on?" n || exit 0
  systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$SERVICE_FILE"
  systemctl daemon-reload
  if [[ -f "$SSHD_DROPIN" ]]; then
    rm -f "$SSHD_DROPIN"
    if sshd_config_ok; then reload_sshd; fi
  fi
  if [[ -f "$SSHD_RESET_DROPIN" ]] && confirm "Remove $SSHD_RESET_DROPIN too? (it turned off GatewayPorts or PermitTunnel that an old setup had turned on)" n; then
    rm -f "$SSHD_RESET_DROPIN"
    if sshd_config_ok; then reload_sshd; fi
  fi
  getent passwd "$TUNNEL_USER" >/dev/null 2>&1 && userdel "$TUNNEL_USER" 2>/dev/null || true
  getent group "$TUNNEL_USER" >/dev/null 2>&1 && groupdel "$TUNNEL_USER" 2>/dev/null || true
  if [[ -d "$MODELS_DIR" ]]; then
    models_bytes=$(dir_size_bytes "$MODELS_DIR")
    if confirm "Delete the downloaded models ($(human_bytes "$models_bytes"))?" y; then rm -rf --one-file-system "$STATE_DIR"; fi
  fi
  if [[ -f "$STATE_RECORD" ]]; then
    while IFS= read -r item; do
      case "$item" in
        file:"$LOGIND_DROPIN") rm -f "$LOGIND_DROPIN" ;;
        masked-sleep) systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target || true ;;
        file:"$APT_PIN_FILE") rm -f "$APT_PIN_FILE" ;;
      esac
    done <"$STATE_RECORD"
    local cuda_pkgs
    cuda_pkgs=$(grep -E '^apt:(cuda-|libcublas)' "$STATE_RECORD" | sed 's/^apt://' | tr '\n' ' ' || true)
    if [[ -n "${cuda_pkgs// /}" ]] && confirm "Remove the CUDA toolkit packages setup installed ($cuda_pkgs)?" n; then
      # shellcheck disable=SC2086
      DEBIAN_FRONTEND=noninteractive apt-get remove -y $cuda_pkgs || true
      apt-get autoremove -y || true
    fi
  fi
  getent passwd "$SERVICE_USER" >/dev/null 2>&1 && userdel "$SERVICE_USER" 2>/dev/null || true
  getent group "$SERVICE_USER" >/dev/null 2>&1 && groupdel "$SERVICE_USER" 2>/dev/null || true
  say "The firewall stays on with SSH open; turn it off with: sudo ufw disable"
  rm -rf "$ETC_DIR" "$LLAMA_CPP_ROOT" "$LLAMA_SWAP_ROOT"
  rm -f "$SELF_LINK"
  say "Removed. Backups of files setup changed are in $BACKUP_ROOT. The Mac keeps its tunnel key; delete ~/.ssh/gmat_llm_ed25519 there if you like."
  rm -rf "$INSTALL_ROOT"
}

# ===========================================================================
# Main
# ===========================================================================

parse_setup_args() {
  local option
  while (($#)); do
    option=$1
    case "$option" in
      --profile | --port | --quant | --n-cpu-moe | --ctx-fast | --ctx-reason | --reasoning | --jobs)
        (($# >= 2)) || die "$option needs a value (see --help)."
        case "$option" in
          --profile) PROFILE=$2 ;;
          --port) PORT=$2 ;;
          --quant)
            REASON_QUANT=$2
            REASON_QUANT_SET=1
            ;;
          --n-cpu-moe) N_CPU_MOE=$2 ;;
          --ctx-fast) CTX_FAST=$2 ;;
          --ctx-reason) CTX_REASON=$2 ;;
          --reasoning) REASONING=$2 ;;
          --jobs) BUILD_JOBS=$2 ;;
        esac
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --yes | -y)
        ASSUME_YES=1
        shift
        ;;
      --keep-awake)
        KEEP_AWAKE=1
        shift
        ;;
      --skip-cleanup)
        SKIP_CLEANUP=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "Unknown option: $option (see --help)" ;;
    esac
  done
  case "$PROFILE" in minimal | standard | full) ;; *) die "--profile must be minimal, standard or full." ;; esac
  valid_port "$PORT" || die "--port must be a number from 1024 to 65000."
  case "$REASON_QUANT" in UD-Q3_K_XL | UD-Q2_K_XL) ;; *) die "--quant must be UD-Q3_K_XL or UD-Q2_K_XL." ;; esac
  [[ -z "$N_CPU_MOE" || "$N_CPU_MOE" =~ ^[0-9]+$ ]] || die "--n-cpu-moe must be a number."
  if [[ ! "$CTX_FAST" =~ ^[0-9]+$ ]] || ((CTX_FAST < 2048)); then die "--ctx-fast must be a number of at least 2048."; fi
  if [[ ! "$CTX_REASON" =~ ^[0-9]+$ ]] || ((CTX_REASON < 2048)); then die "--ctx-reason must be a number of at least 2048."; fi
  case "$REASONING" in on | off) ;; *) die "--reasoning must be on or off." ;; esac
  [[ -z "$BUILD_JOBS" || "$BUILD_JOBS" =~ ^[1-9][0-9]*$ ]] || die "--jobs must be a positive number."
  if ((FAKE_HARDWARE)) && ((!DRY_RUN)); then die "GMAT_LLM_FAKE_HARDWARE works with --dry-run only."; fi
  if [[ -n "$N_CPU_MOE" ]]; then SAVED_N_CPU_MOE=$N_CPU_MOE; fi
}

start_log() {
  local dir=$LOG_DIR
  if ((EUID != 0)); then dir="${TMPDIR:-/tmp}"; fi
  if ((DRY_RUN)) && ((EUID == 0)) && [[ ! -d "$LOG_DIR" ]]; then dir="${TMPDIR:-/tmp}"; fi
  mkdir -p "$dir"
  LOG_FILE="$dir/setup-$(date +%Y%m%d-%H%M%S)$( ((DRY_RUN)) && printf -- '-dry-run').log"
  (
    umask 077
    : >"$LOG_FILE"
  )
  exec > >(tee -a "$LOG_FILE") 2>&1
  say "gmat-llm setup $GMAT_LLM_SCRIPT_VERSION, $(date -R)$( ((DRY_RUN)) && printf ', dry run: nothing will be changed')"
  say "Log: $LOG_FILE"
}

take_lock() {
  ((DRY_RUN)) && return 0
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "Another gmat-llm setup is running."
}

setup_main() {
  # Choices from the last run are the defaults; options override them.
  load_setup_conf
  REASON_QUANT_SET=0
  N_CPU_MOE=""
  parse_setup_args "$@"
  if ((EUID != 0)) && ((!DRY_RUN)); then
    exec sudo -- "$BASH" "$(readlink -f "${BASH_SOURCE[0]}")" "$@"
  fi
  if [[ -t 0 && -r /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then HAVE_TTY=1; fi
  start_log
  take_lock
  trap 'on_error $? "$LINENO" "$BASH_COMMAND"' ERR
  trap on_interrupt INT TERM
  preflight
  cleanup_old_setup
  install_software
  download_models
  write_config_and_service
  setup_access
  health_checks
  print_summary
}

main() {
  local command=${1:-}
  if [[ -t 0 && -r /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then HAVE_TTY=1; fi
  case "$command" in
    status) shift; cmd_status "$@" ;;
    add-client) shift; cmd_add_client "$@" ;;
    remove-client) shift; cmd_remove_client "$@" ;;
    show-api-key) shift; cmd_show_api_key "$@" ;;
    set-cloud) shift; cmd_set_cloud "$@" ;;
    clear-cloud) shift; cmd_clear_cloud "$@" ;;
    restart) shift; cmd_restart "$@" ;;
    logs) shift; cmd_logs "$@" ;;
    test) shift; cmd_test "$@" ;;
    uninstall) shift; cmd_uninstall "$@" ;;
    setup) shift; setup_main "$@" ;;
    help | -h | --help) usage ;;
    "")
      if [[ "$(basename "$0")" == gmat-llm ]]; then usage; else setup_main; fi
      ;;
    *) setup_main "$@" ;;
  esac
}

if [[ "${GMAT_LLM_SOURCE_ONLY:-0}" != 1 ]]; then
  main "$@"
fi
