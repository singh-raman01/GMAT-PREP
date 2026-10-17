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
# Turing has no BF16, so the F16 vision projector (downloaded with --vision on).
readonly REASON_MMPROJ_REGEX='^mmproj-F16\.gguf$'
# The pinned 35B-A3B model has 40 layers, each with its own experts.
readonly REASON_LAYERS=40

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
# The 35B-A3B files in MiB (16.85 and 12.29 GB on Hugging Face), for the RAM
# estimate before they are downloaded.
readonly SIZE_MIB_REASON_Q3=16065
readonly SIZE_MIB_REASON_Q2=11721
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

# Ports local LLM stacks use by default. The first list is used by LLM
# software only: Ollama 11434, llama-server 9931 (releases after b11400;
# b11400 itself uses 8080), LM Studio 1234, Jan 1337, SGLang 30000, Cortex
# 39281. The second is shared with web frameworks and other programs, so
# anything there defaults to being left alone.
readonly LLM_PORTS_STRONG="11434 9931 1234 1337 30000 39281"
readonly LLM_PORTS_COMMON="8080 8000 8001 8081 3000 4000 5000 5001 7860 7861"
# Lowercase names that identify LLM software in unit names, command lines and
# folder names. They are matched as whole words (see is_llm_text), so
# local-airflow or film-studio do not count.
readonly LLM_PATTERN='ollama|llama-server|llama-swap|llama_swap|llama\.cpp|llamacpp|llama_cpp|vllm|lmstudio|lm-studio|lm studio|llmster|open-webui|open_webui|openwebui|litellm|text-generation-webui|text_generation_webui|text-generation-inference|text-generation-launcher|oobabooga|koboldcpp|tabbyapi|localai|local-ai|sglang|exllama|exllamav2|aphrodite|gpt4all|ramalama|llamafile|mlc_llm|mlc-llm'
# Container images of LLM software, matched exactly on the repository (any
# tag). A container counts only if its image is one of these, or its Compose
# service or its own name is exactly one of the names below.
readonly LLM_IMAGES="ollama/ollama ghcr.io/open-webui/open-webui vllm/vllm-openai localai/localai quay.io/go-skynet/local-ai ghcr.io/ggml-org/llama.cpp ghcr.io/ggerganov/llama.cpp ghcr.io/mostlygeek/llama-swap ghcr.io/berriai/litellm lmsysorg/sglang ghcr.io/huggingface/text-generation-inference koboldai/koboldcpp"
readonly LLM_NAMES="ollama open-webui openwebui vllm localai local-ai llama-server llama-swap litellm sglang tgi text-generation-inference text-generation-webui koboldcpp"

# ---------------------------------------------------------------------------
# Runtime state
# ---------------------------------------------------------------------------

DRY_RUN=0
ASSUME_YES=0
PROFILE="standard"
PORT="$DEFAULT_PORT"
REASON_QUANT="UD-Q3_K_XL"
REASON_QUANT_SET=0
REASON_QUANT_SAVED=0
CTX_FAST=16384
CTX_REASON=16384
N_CPU_MOE=""
REASONING="off"
KEEP_AWAKE=0
SKIP_CLEANUP=0
# --yes alone never deletes models or environments; these options allow it.
DELETE_OLD_MODELS=0
DELETE_OLD_ENVS=0
# The 35B-A3B's vision projector, off while the app sends no images.
VISION="off"
BUILD_JOBS=""
# The SSH ports, from detect_ssh_ports.
SSH_PORTS=""
SSH_PORTS_ALL=""
SSH_PORTS_SURE=0
SSH_PORTS_NOTE=""
SSH_LOOPBACK_SESSION=0
IN_MULTIPLEXER=0
FIREWALL_SKIPPED=0
SSHD_PLACEMENT=""
SSHD_CHANGED=0
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
  trap - INT TERM HUP
  printf '\nStopped during "%s". Run the script again to carry on; downloads and the llama.cpp build resume where they stopped.\n' "$CURRENT_STEP" >&2
  exit 130
}

# A closed SSH connection sends SIGHUP. The log says what happened; the next
# run carries on where this one stopped.
on_hangup() {
  trap - INT TERM HUP
  printf '\nThe terminal closed during "%s" (SIGHUP). Run the script again to carry on, inside tmux so a dropped connection does not stop it.\n' "$CURRENT_STEP" >>"${LOG_FILE:-/dev/null}"
  exit 129
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

# confirm_delete CATEGORY QUESTION DEFAULT: a question about deleting data that
# costs a download or work to get back. With --yes the answer is no, unless
# CATEGORY is models and --delete-old-models was given, or envs and
# --delete-old-envs; CATEGORY "ask" is never answered by --yes.
confirm_delete() {
  local category=$1 question=$2 default=$3 allowed=0
  case "$category" in
    models) ((DELETE_OLD_MODELS)) && allowed=1 ;;
    envs) ((DELETE_OLD_ENVS)) && allowed=1 ;;
  esac
  if ((ASSUME_YES)); then
    if ((allowed)) && [[ "$default" == y ]]; then
      confirm "$question" y
      return
    fi
    case "$category" in
      models) printf '%s Skipped: --yes does not delete models without --delete-old-models.\n' "$question" ;;
      envs) printf '%s Skipped: --yes does not delete environments or source trees without --delete-old-envs.\n' "$question" ;;
      *) printf '%s Skipped: this needs an answer at the terminal; --yes does not give it.\n' "$question" ;;
    esac
    return 1
  fi
  confirm "$question" "$default"
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

# Whether a path may be deleted: absolute, without . or .. parts, not a
# system folder, not a top-level folder and not anyone's home folder. Prints
# the reason when it may not.
unsafe_to_delete() {
  local path=$1 normalized depth home
  if [[ "$path" != /* ]]; then
    printf 'it is a relative path'
    return 0
  fi
  if [[ "/$path/" == *"/./"* || "/$path/" == *"/../"* ]]; then
    printf 'it has . or .. in it'
    return 0
  fi
  normalized=$(realpath -m -- "$path")
  case "$normalized" in
    / | /bin | /boot | /dev | /etc | /home | /lib | /lib32 | /lib64 | /media | /mnt | /opt | /proc | /root | /run | /sbin | /snap | /srv | /sys | /tmp | /usr | /var | /data | /var/lib | /var/log | /var/backups | /usr/local | /usr/lib | /usr/share | /usr/bin | /usr/sbin | /usr/local/bin | /usr/local/lib | /usr/local/share | /etc/systemd | /etc/systemd/system | /etc/ssh)
      printf '%s is a system folder' "$normalized"
      return 0
      ;;
  esac
  depth=$(awk -F/ '{print NF-1}' <<<"$normalized")
  if ((depth < 2)); then
    printf '%s is a top-level folder' "$normalized"
    return 0
  fi
  while IFS= read -r home; do
    [[ -n "$home" && "$home" != / ]] || continue
    home=$(realpath -m -- "$home")
    if [[ "$normalized" == "$home" ]]; then
      printf '%s is a home folder' "$normalized"
      return 0
    fi
  done < <(getent passwd | cut -d: -f6)
  return 1
}

# Refuses, and stops the script, for a path that must not be deleted.
assert_safe_to_delete() {
  local reason
  if reason=$(unsafe_to_delete "$1"); then die "Refusing to delete $1: $reason."; fi
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

# Whether a name or command line names LLM software, as a whole word:
# "/usr/local/bin/ollama serve" does, "local-airflow-postgres-1" does not.
is_llm_text() {
  grep -qiE -- "(^|[^a-z0-9])($LLM_PATTERN)([^a-z0-9]|\$)" <<<"$1"
}

# Whether a container image is one of the known LLM images, whatever its tag
# or digest: docker.io/ollama/ollama:0.5 counts, myorg/ollama-tools does not.
is_llm_image() {
  local ref=${1,,} image
  ref=${ref%%@*}
  # A tag follows the last colon after the last slash.
  if [[ "${ref##*/}" == *:* ]]; then ref=${ref%:*}; fi
  ref=${ref#docker.io/}
  ref=${ref#index.docker.io/}
  ref=${ref#library/}
  for image in $LLM_IMAGES; do
    [[ "$ref" == "$image" ]] && return 0
  done
  return 1
}

is_llm_name() {
  local name=${1,,} known
  for known in $LLM_NAMES; do
    [[ "$name" == "$known" ]] && return 0
  done
  return 1
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
  --dry-run          print every change without making any; it only writes
                     its own log, checks the SSH config on a copy in /tmp,
                     and builds and runs a tiny CUDA test program when a
                     CUDA compiler is present
  --yes              take the default answer to every question; questions
                     about things not identified as LLM software default to no,
                     and nothing that holds data is deleted (see the next two)
  --delete-old-models  with --yes, also delete old LLM models and caches
  --delete-old-envs  with --yes, also delete old llama.cpp source trees and
                     Python environments of LLM servers
  --port N           port of the local endpoint on 127.0.0.1 (default $DEFAULT_PORT)
  --quant NAME       quantization of the 35B-A3B model: UD-Q3_K_XL or
                     UD-Q2_K_XL; by default setup picks the one that fits RAM
  --n-cpu-moe N      keep the experts of the first N layers of the 35B-A3B in
                     system RAM instead of working it out from free VRAM
  --vision on|off    download the 35B-A3B's vision projector and let it read
                     images (default off: the app sends no images yet)
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
      REASON_QUANT)
        REASON_QUANT=$value
        REASON_QUANT_SAVED=1
        ;;
      CTX_FAST) CTX_FAST=$value ;;
      CTX_REASON) CTX_REASON=$value ;;
      REASONING) REASONING=$value ;;
      N_CPU_MOE_SAVED) SAVED_N_CPU_MOE=$value ;;
      NGL_SAVED) SAVED_NGL=$value ;;
      CPU_EXPERT_LAYERS) SAVED_CPU_LAYERS=$value ;;
      VISION) VISION=$value ;;
    esac
  done <"$SETUP_CONF"
}

SAVED_N_CPU_MOE=""
SAVED_NGL=""
# "auto" until llama-fit-params has measured; then the layer list, which is
# empty when every expert fits in VRAM.
SAVED_CPU_LAYERS="auto"

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
CPU_EXPERT_LAYERS=${SAVED_CPU_LAYERS}
VISION=$VISION
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

# The app tasks each model serves, as the Mac script sets them: one model,
# the 35B-A3B, for everything a book run does, so a run never swaps models;
# the 4B for Tutor Chat, or for every local task in the minimal profile.
model_tasks() {
  case "$1" in
    fast)
      if profile_has reason; then printf 'tutor-chat'; else printf 'tagging, statement-translation, tutor-chat, solving, book-map, extraction'; fi
      ;;
    reason)
      printf 'tagging, statement-translation, solving, book-map, extraction'
      if [[ "$VISION" == on ]]; then printf ' (reads images)'; fi
      ;;
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
    case "$comm" in tmux* | screen* | SCREEN* | byobu*) IN_MULTIPLEXER=1 ;; esac
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

# Whether this session, or any SSH session open now, comes from this computer
# itself, as one through a reverse tunnel does.
session_comes_through_tunnel() {
  ((SSH_LOOPBACK_SESSION)) && return 0
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

# A dry run without a working driver still shows the cleanup (step 2); the
# steps after it need the driver. Returns 1 for a real run, which stops.
NO_DRIVER=0
driver_dry_run_goes_on() {
  ((DRY_RUN)) || return 1
  NO_DRIVER=1
  say "The dry run goes on with step 2 (the cleanup) and stops after it: steps 3 to 8 need the driver."
}

offer_driver_install() {
  say "No working NVIDIA driver was found (nvidia-smi is missing or cannot reach the driver)."
  if grep -q '^nouveau ' /proc/modules 2>/dev/null; then
    info "The open nouveau driver is loaded; CUDA needs NVIDIA's driver instead."
  fi
  if [[ -n "$(installed_matching 'nvidia-driver-*' 'nvidia-headless-*')" ]]; then
    say "NVIDIA driver packages are installed but the driver is not running. Reboot first."
    say "If it still fails after a reboot and Secure Boot is on (mokutil --sb-state), enroll the key the driver install asked for, or turn Secure Boot off."
    driver_dry_run_goes_on || exit 1
    return 0
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
    elif ((DRY_RUN)); then
      say "The real run also installs nvidia-smi (nvidia-utils-<version>-server) for the driver version ubuntu-drivers picks."
    else
      say "Install nvidia-smi too: sudo apt-get install nvidia-utils-<version>-server, with the version ubuntu-drivers installed."
    fi
    say ""
    if ((DRY_RUN)); then
      say "After the real run installs the driver, reboot (sudo reboot) and run this script again."
    else
      say "The driver is installed. Reboot (sudo reboot), then run this script again."
    fi
  else
    say "Install the driver yourself (sudo ubuntu-drivers install --gpgpu), reboot, then run this script again."
  fi
  driver_dry_run_goes_on || exit 0
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
    # Only a dry run gets here.
    return 0
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
      driver_dry_run_goes_on || exit 0
      return 0
    fi
    driver_dry_run_goes_on || die "A driver of version 525 or newer is needed."
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
  if profile_has reason; then
    if ((REASON_QUANT_SET == 0 && REASON_QUANT_SAVED == 0)); then REASON_QUANT=$(fitting_reason_quant); fi
    info "35B-A3B: the $REASON_QUANT file needs about $(($(reason_ram_mib "$REASON_QUANT") / 1024)) GiB of RAM for its experts and the program; the service may use $(((MEM_TOTAL_KIB / 1024 - 1024) / 1024)) GiB."
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
    if ((DRY_RUN)); then warn "$problem The dry run goes on; the real run stops here."; else die "$problem"; fi
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
    info "You are connected over SSH from $SSH_SESSION_PEER; sshd is never stopped or restarted."
  fi
  if ((IN_MULTIPLEXER)); then
    info "This runs inside tmux or screen, so a dropped SSH connection does not stop it."
  elif [[ -n "$SSH_SESSION_PEER" ]]; then
    info "If the SSH connection drops, this run stops; running it again carries on. Inside tmux (sudo apt install tmux, then tmux) a dropped connection does not stop it."
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
  detect_ssh_ports
  report_ssh_ports
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

# The Compose service name in a container's labels, as Docker
# ("a=b,com.docker.compose.service=ollama") or Podman ("map[...]") prints them.
compose_service_of() {
  grep -oE 'com\.docker\.compose\.service[=:][^], ]+' <<<"$1" | head -n 1 | sed -E 's/^com\.docker\.compose\.service[=:]//' || true
}

# Containers of LLM software: the image is a known LLM image, or the Compose
# service or the container's own name is exactly a known LLM name. Prints
# "id<TAB>image<TAB>name<TAB>status" lines.
find_llm_containers() {
  local tool=$1 id image name status labels service
  while IFS=$'\t' read -r id image name status labels; do
    [[ -n "$id" ]] || continue
    service=$(compose_service_of "$labels")
    if is_llm_image "$image" || is_llm_name "$name" || { [[ -n "$service" ]] && is_llm_name "$service"; }; then
      printf '%s\t%s\t%s\t%s\n' "$id" "$image" "$name" "$status"
    fi
  done < <("$tool" ps -a --format '{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}\t{{.Labels}}' 2>/dev/null || true)
}

# Named volumes of the given containers, one per line.
volumes_of_containers() {
  local tool=$1 id
  shift
  for id in "$@"; do
    "$tool" inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}' "$id" 2>/dev/null || true
  done | sed '/^$/d' | sort -u
}

cleanup_containers() {
  local tool containers images="" volumes id image name status ref size vol mount users others ids=()
  tool=$(container_tool)
  if [[ -z "$tool" ]]; then
    info "No Docker or Podman engine running."
    return 0
  fi
  containers=$(find_llm_containers "$tool")
  while IFS=$'\t' read -r id _; do
    [[ -n "$id" ]] || continue
    ids+=("$id")
  done <<<"$containers"
  # Volumes are listed before the containers go, while their mounts still show.
  volumes=""
  if ((${#ids[@]} > 0)); then volumes=$(volumes_of_containers "$tool" "${ids[@]}"); fi
  if [[ -n "$containers" ]]; then
    say "$tool containers of LLM software (known images or names):"
    while IFS=$'\t' read -r id image name status; do
      [[ -n "$id" ]] || continue
      info "$name ($image, $status)"
    done <<<"$containers"
    info "Files a container keeps outside its volumes go with it."
    if confirm "Stop and remove these containers?" y; then
      for id in "${ids[@]}"; do run "$tool" rm -f "$id" || warn "Could not remove container $id"; done
    fi
  fi
  while IFS=$'\t' read -r ref id size; do
    [[ -n "$ref" ]] || continue
    if is_llm_image "$ref"; then images+="$ref"$'\t'"$id"$'\t'"$size"$'\n'; fi
  done < <("$tool" images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}' 2>/dev/null || true)
  if [[ -n "$images" ]]; then
    say "$tool images of LLM software:"
    while IFS=$'\t' read -r ref id size; do
      [[ -n "$ref" ]] || continue
      info "$ref ($size)"
    done <<<"$images"
    if confirm "Remove these images (they can be pulled again)?" y; then
      while IFS=$'\t' read -r ref id _; do
        [[ -n "$ref" ]] || continue
        run "$tool" rmi -f "$id" || warn "Could not remove $ref"
      done <<<"$images"
    fi
  fi
  # Volumes hold chat histories, accounts and models. Each one is asked about
  # on its own, defaults to no and is never removed by --yes.
  if [[ -n "$volumes" ]]; then
    say "Volumes those containers used:"
    while IFS= read -r vol; do
      [[ -n "$vol" ]] || continue
      mount=$("$tool" volume inspect --format '{{.Mountpoint}}' "$vol" 2>/dev/null || true)
      size=$(human_bytes "$(dir_size_bytes "$mount")")
      users=$("$tool" ps -a --filter "volume=$vol" --format '{{.Names}}' 2>/dev/null | tr '\n' ' ' || true)
      others=""
      for name in $users; do
        grep -qxF "$name" <(cut -f3 <<<"$containers") || others+="$name "
      done
      if [[ -n "$others" ]]; then
        info "$vol ($size): also used by ${others% }; left alone."
        continue
      fi
      info "$vol ($size)${users:+, used by ${users% }}"
      if confirm_delete ask "Delete the volume $vol and everything in it ($size)?" n; then
        run "$tool" volume rm "$vol" || warn "Could not remove the volume $vol (a container still uses it?)"
      fi
    done <<<"$volumes"
  fi
  if [[ -z "$containers$images$volumes" ]]; then info "No containers, images or volumes of LLM software."; fi
  return 0
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
  local bin software=() models=() p entry home total=0 user_home="" user_exists=0 remove_software=0 remove_models=0
  for bin in /usr/local/bin/ollama /usr/bin/ollama /bin/ollama /usr/local/lib/ollama /usr/lib/ollama /etc/systemd/system/ollama.service; do
    if [[ -e "$bin" ]]; then software+=("$bin"); fi
  done
  if getent passwd ollama >/dev/null 2>&1; then
    user_exists=1
    user_home=$(getent passwd ollama | cut -d: -f6)
  fi
  # Models: the service user's home and each login user's ~/.ollama.
  if [[ -d /usr/share/ollama ]]; then models+=(/usr/share/ollama); fi
  while IFS= read -r entry; do
    home=${entry#*:}
    if [[ -d "$home/.ollama" ]]; then models+=("$home/.ollama"); fi
  done < <(human_users)
  if ((${#software[@]} == 0 && ${#models[@]} == 0 && user_exists == 0)); then
    info "No Ollama installation."
    return 0
  fi
  say "Ollama:"
  for p in "${software[@]}"; do info "$p (program, $(human_bytes "$(dir_size_bytes "$p")"))"; done
  ((user_exists)) && info "the ollama user and group"
  for p in "${models[@]}"; do
    info "$p (models and keys, $(human_bytes "$(dir_size_bytes "$p")"))"
    total=$((total + $(dir_size_bytes "$p")))
  done
  if ((${#software[@]} > 0 || user_exists)) && confirm "Stop Ollama and remove its program and service, as Ollama's uninstall guide does?" y; then
    remove_software=1
  fi
  if ((${#models[@]} > 0)) && confirm_delete models "Delete Ollama's models ($(human_bytes "$total"))?" y; then
    remove_models=1
  fi
  if ((remove_software)); then
    if systemctl cat ollama.service >/dev/null 2>&1; then
      run systemctl disable --now ollama.service || true
    fi
    for p in "${software[@]}"; do
      if [[ "$p" == *.service ]]; then backup_path "$p"; fi
      remove_path "$p"
    done
    run systemctl daemon-reload
  fi
  if ((remove_models)); then
    # The ollama user's home holds the service's models; the user goes first,
    # so the folder is no longer anyone's home.
    if ((user_exists)); then
      run userdel ollama || warn "Could not remove the ollama user"
      if getent group ollama >/dev/null 2>&1; then run groupdel ollama || warn "Could not remove the ollama group"; fi
    fi
    for p in "${models[@]}"; do
      if [[ "$p" == "$user_home" && "$p" == /usr/share/ollama ]]; then
        run rm -rf --one-file-system -- "$p"
      else
        remove_path "$p"
      fi
    done
  elif ((remove_software && user_exists)); then
    info "The ollama user stays, as its home holds the models you kept."
  fi
  return 0
}

# Model files of LLM tools in each login user's home folder: the model
# folders of the Hugging Face hub cache (never its token, datasets or other
# caches), llama.cpp's -hf download cache, LM Studio's model folders and
# vLLM's cache.
cleanup_caches() {
  local entry home rel path bytes hf="" tools="" hf_total=0 tools_total=0
  while IFS= read -r entry; do
    home=${entry#*:}
    [[ -d "$home" ]] || continue
    for path in "$home"/.cache/huggingface/hub/models--*; do
      [[ -d "$path" && ! -L "$path" ]] || continue
      bytes=$(dir_size_bytes "$path")
      hf+="$path"$'\t'"$bytes"$'\n'
      hf_total=$((hf_total + bytes))
    done
    for rel in .cache/llama.cpp .lmstudio/models .cache/lm-studio/models .cache/vllm; do
      path="$home/$rel"
      [[ -e "$path" && ! -L "$path" ]] || continue
      bytes=$(dir_size_bytes "$path")
      tools+="$path"$'\t'"$bytes"$'\n'
      tools_total=$((tools_total + bytes))
    done
  done < <(human_users)
  if [[ -z "$hf$tools" ]]; then
    info "No Hugging Face models, llama.cpp download cache, LM Studio models or vLLM cache."
    return 0
  fi
  if [[ -n "$tools" ]]; then
    say "Model folders of llama.cpp, LM Studio and vLLM ($(human_bytes "$tools_total")):"
    while IFS=$'\t' read -r path bytes; do
      [[ -n "$path" ]] || continue
      info "$path ($(human_bytes "$bytes"))"
    done <<<"$tools"
    if confirm_delete models "Delete these model folders?" y; then
      while IFS=$'\t' read -r path bytes; do
        [[ -n "$path" ]] || continue
        remove_path "$path"
      done <<<"$tools"
    fi
  fi
  if [[ -n "$hf" ]]; then
    say "Models in the Hugging Face cache ($(human_bytes "$hf_total")). Some may not be LLMs; the token and datasets are not touched:"
    while IFS=$'\t' read -r path bytes; do
      [[ -n "$path" ]] || continue
      info "${path##*/models--} ($(human_bytes "$bytes")): $path"
    done <<<"$hf"
    while IFS=$'\t' read -r path bytes; do
      [[ -n "$path" ]] || continue
      if confirm_delete models "Delete the Hugging Face model ${path##*/models--} ($(human_bytes "$bytes"))?" n; then
        remove_path "$path"
      fi
    done <<<"$hf"
  fi
  return 0
}

# GGUF model files outside the stores above, grouped by folder. They may be
# fine-tunes someone made, so each folder defaults to no.
cleanup_gguf_folders() {
  local roots=() r dirs dir bytes total=0 list="" f reason depth
  for r in /home /root /opt /srv /data /mnt /media /usr/local/share /var/lib; do
    if [[ -d "$r" ]]; then roots+=("$r"); fi
  done
  ((${#roots[@]} > 0)) || return 0
  dirs=$(find "${roots[@]}" -xdev -maxdepth 7 \( -path "$STATE_DIR" -o -path "$INSTALL_ROOT" -o -path /var/lib/docker -o -path /var/lib/containers -o -path '*/.cache/huggingface' -o -path '*/.cache/llama.cpp' -o -path '*/.lmstudio' -o -path '*/.cache/lm-studio' -o -path '*/.ollama' -o -path /usr/share/ollama -o -name node_modules -o -name .git \) -prune -o -type f -iname '*.gguf' -size +20M -printf '%h\n' 2>/dev/null | sort -u || true)
  if [[ -z "$dirs" ]]; then
    info "No other GGUF model files."
    return 0
  fi
  while IFS= read -r dir; do
    [[ -n "$dir" ]] || continue
    bytes=$(find "$dir" -maxdepth 1 -type f -iname '*.gguf' -printf '%s\n' 2>/dev/null | awk '{s += $1} END {print s + 0}')
    total=$((total + bytes))
    list+="$dir"$'\t'"$bytes"$'\n'
  done <<<"$dirs"
  say "Other folders with GGUF model files ($(human_bytes "$total") in total). They may hold models you made, so each defaults to no:"
  while IFS=$'\t' read -r dir bytes; do
    [[ -n "$dir" ]] || continue
    info "$dir ($(human_bytes "$bytes") of .gguf files)"
  done <<<"$list"
  while IFS=$'\t' read -r dir bytes; do
    [[ -n "$dir" ]] || continue
    confirm_delete models "Delete the .gguf files in $dir ($(human_bytes "$bytes"))? Other files stay." n || continue
    for f in "$dir"/*.gguf "$dir"/*.GGUF; do
      [[ -f "$f" ]] || continue
      if reason=$(unsafe_to_delete "$f"); then
        warn "Skipping $f: $reason."
        continue
      fi
      run rm -f -- "$f"
    done
    # The folder goes only when it is now empty, deep enough and nobody's home.
    depth=$(awk -F/ '{print NF-1}' <<<"$dir")
    if ((depth >= 3)) && ! unsafe_to_delete "$dir" >/dev/null; then
      if ((DRY_RUN)); then
        printf '[dry-run] would remove %s if it is empty then\n' "$dir"
      else
        rmdir --ignore-fail-on-non-empty -- "$dir" 2>/dev/null || true
      fi
    fi
  done <<<"$list"
  return 0
}

# Runs git as the owner of a work tree, so a repository's own settings can
# never run anything as root, and without optional locks, so a status check
# does not write the repository's index.
git_as_owner() {
  local tree=$1 owner
  shift
  owner=$(stat -c %U -- "$tree" 2>/dev/null || true)
  [[ -n "$owner" && "$owner" != UNKNOWN ]] || return 1
  if [[ "$owner" == root ]]; then
    git --no-optional-locks -C "$tree" "$@"
  else
    runuser -u "$owner" -- git --no-optional-locks -C "$tree" "$@"
  fi
}

# Old llama.cpp source trees and builds, and llama.cpp programs in
# /usr/local/bin. Trees with work not committed, and trees inside another
# project (vendored or a submodule), are left alone.
cleanup_llama_builds() {
  local roots=() r trees tree list="" bytes bins=() b status
  for r in /home /root /opt /srv /usr/local/src; do
    if [[ -d "$r" ]]; then roots+=("$r"); fi
  done
  ((${#roots[@]} > 0)) || return 0
  trees=$(find "${roots[@]}" -xdev -maxdepth 5 \( -path "$INSTALL_ROOT" -o -name node_modules -o -name .cache \) -prune -o -type f -name CMakeLists.txt -path '*/ggml/CMakeLists.txt' -printf '%h\n' 2>/dev/null | sed 's#/ggml$##' | sort -u || true)
  while IFS= read -r tree; do
    [[ -n "$tree" && -f "$tree/CMakeLists.txt" ]] || continue
    grep -q 'project("llama.cpp"' "$tree/CMakeLists.txt" 2>/dev/null || continue
    if [[ -f "$tree/.git" ]] || git_as_owner "$(dirname "$tree")" rev-parse --show-toplevel >/dev/null 2>&1; then
      info "$tree is part of another project; left alone."
      continue
    fi
    if [[ -d "$tree/.git" ]]; then
      if ! status=$(git_as_owner "$tree" status --porcelain 2>/dev/null); then
        info "$tree: git cannot read its status; left alone."
        continue
      fi
      if [[ -n "$status" ]]; then
        info "$tree has changes that are not committed; left alone."
        continue
      fi
    fi
    bytes=$(dir_size_bytes "$tree")
    list+="$tree"$'\t'"$bytes"$'\n'
  done <<<"$trees"
  for b in /usr/local/bin/llama-* /usr/local/bin/llama /usr/local/lib/libllama* /usr/local/lib/libggml*; do
    if [[ -e "$b" ]]; then bins+=("$b"); fi
  done
  if [[ -z "$list" && ${#bins[@]} -eq 0 ]]; then
    info "No old llama.cpp builds."
    return 0
  fi
  if ((${#bins[@]} > 0)); then
    say "llama.cpp programs and libraries installed in /usr/local:"
    for b in "${bins[@]}"; do info "$b"; done
    if confirm "Remove them?" y; then
      for b in "${bins[@]}"; do remove_path "$b"; done
    fi
  fi
  if [[ -n "$list" ]]; then
    say "Old llama.cpp source trees with no work in progress:"
    while IFS=$'\t' read -r tree bytes; do
      [[ -n "$tree" ]] || continue
      info "$tree ($(human_bytes "$bytes"))"
    done <<<"$list"
    if confirm_delete envs "Delete these source trees?" y; then
      while IFS=$'\t' read -r tree bytes; do
        [[ -n "$tree" ]] || continue
        remove_path "$tree"
      done <<<"$list"
    fi
  fi
  return 0
}

# Python environments that hold LLM servers (vLLM, Open WebUI, SGLang, text
# generation inference) default to yes. An environment that only holds a
# library such as litellm or llama_cpp (aider and similar tools use them),
# or that belongs to a project, defaults to no and is never removed by --yes.
cleanup_venvs() {
  local roots=() r hits venv list="" bytes servers libs parent kind
  for r in /home /root /opt /srv; do
    if [[ -d "$r" ]]; then roots+=("$r"); fi
  done
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
    [[ -n "$venv" ]] || continue
    servers=""
    libs=""
    for r in vllm open_webui sglang text_generation_server; do
      if compgen -G "$venv/lib/python*/site-packages/$r" >/dev/null; then servers+="$r "; fi
    done
    for r in litellm llama_cpp exllamav2; do
      if compgen -G "$venv/lib/python*/site-packages/$r" >/dev/null; then libs+="$r "; fi
    done
    parent=$(dirname "$venv")
    kind=server
    if [[ -z "$servers" ]]; then kind=library; fi
    if compgen -G "$parent/pyproject.toml" >/dev/null || compgen -G "$parent/requirements*.txt" >/dev/null || compgen -G "$parent/setup.py" >/dev/null || compgen -G "$parent/Pipfile" >/dev/null || compgen -G "$parent/environment.y*ml" >/dev/null; then
      kind=project
    fi
    bytes=$(dir_size_bytes "$venv")
    case "$kind" in
      server)
        info "$venv ($(human_bytes "$bytes")): ${servers% }"
        if confirm_delete envs "Delete this environment?" y; then remove_path "$venv"; fi
        ;;
      library)
        info "$venv ($(human_bytes "$bytes")): only the libraries ${libs% }, which other tools use too"
        if confirm_delete ask "Delete this environment anyway?" n; then remove_path "$venv"; fi
        ;;
      project)
        info "$venv ($(human_bytes "$bytes")): ${servers}${libs% }, inside the project $parent"
        if confirm_delete ask "Delete this project's environment anyway?" n; then remove_path "$venv"; fi
        ;;
    esac
  done <<<"$list"
  return 0
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

# Whether a forwarding description names a port only LLM software uses.
# Ports that web frameworks share (3000, 8080 and the like) do not count.
specs_are_llm() {
  local port
  for port in $(spec_ports "$1"); do
    if [[ "$(port_class "$port")" == strong ]]; then return 0; fi
  done
  return 1
}

# A reverse forward to this computer's SSH port may carry the session that
# runs this script.
specs_may_carry_session() {
  local spec=$1 port ssh_port
  session_comes_through_tunnel || return 1
  [[ "$spec" == *R:* || "$spec" == *[Rr]emote[Ff]orward* ]] || return 1
  for port in $(spec_ports "$spec"); do
    for ssh_port in 22 $SSH_PORTS_ALL ${SSH_SESSION_PORT:-}; do
      if [[ "$port" == "$ssh_port" ]]; then return 0; fi
    done
  done
  return 1
}

cleanup_tunnel_processes() {
  local pid user tty cmd specs list=""
  while read -r pid user tty cmd; do
    [[ -n "$pid" ]] || continue
    case "$(basename "${cmd%% *}")" in ssh | autossh) ;; *) continue ;; esac
    specs=$(ssh_forward_specs "$cmd")
    [[ -n "$specs" ]] || continue
    list+="$pid"$'\t'"$user"$'\t'"$tty"$'\t'"$specs"$'\t'"$cmd"$'\n'
  done < <(ps -eo pid=,user=,tty=,args= 2>/dev/null)
  if [[ -z "$list" ]]; then
    info "No SSH tunnel processes."
    return 0
  fi
  say "SSH tunnel processes:"
  while IFS=$'\t' read -r pid user tty specs cmd; do
    [[ -n "$pid" ]] || continue
    if specs_may_carry_session "$specs"; then
      info "process $pid ($user): $cmd"
      warn "This reverse tunnel may carry the SSH session running this script; it is left alone. Stop it yourself later if it is from an old LLM setup."
      continue
    fi
    if [[ "$tty" != "?" && -n "$tty" ]]; then
      # An ssh someone is typing in, which happens to forward a port.
      info "process $pid ($user, an interactive session on $tty): $cmd"
      if confirm_delete ask "Stop this interactive SSH session?" n; then stop_pid "$pid"; fi
      continue
    fi
    if specs_are_llm "$specs"; then
      info "process $pid ($user, forwards a port only LLM software uses): $cmd"
      if confirm "Stop process $pid?" y; then stop_pid "$pid"; fi
    else
      info "process $pid ($user, not identified as an LLM tunnel): $cmd"
      if confirm "Stop process $pid anyway?" n; then stop_pid "$pid"; fi
    fi
  done <<<"$list"
  return 0
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
    if specs_are_llm "$specs"; then default=y label="forwards a port only LLM software uses"; fi
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
  return 0
}

# Comments out LocalForward, RemoteForward and DynamicForward lines in the
# SSH client config of root and each login user. Lines on ports only LLM
# software uses default to yes, the rest to no. The file is backed up to this
# run's backup folder (not next to it, where an Include of config.d/* would
# read the copy) and written in place, so a symlinked config stays a link.
cleanup_ssh_client_configs() {
  local entry home cfg listing num text llm_nums other_nums chosen any=0 tmp
  while IFS= read -r entry; do
    home=${entry#*:}
    for cfg in "$home/.ssh/config" "$home"/.ssh/config.d/*; do
      [[ -f "$cfg" ]] || continue
      # ssh_config keywords are case-insensitive.
      listing=$(grep -niE '^[[:space:]]*(LocalForward|RemoteForward|DynamicForward)[[:space:]=]' "$cfg" 2>/dev/null || true)
      [[ -n "$listing" ]] || continue
      any=1
      llm_nums=""
      other_nums=""
      chosen=""
      while IFS=: read -r num text; do
        [[ -n "$num" ]] || continue
        if specs_are_llm "$text"; then llm_nums+=" $num"; else other_nums+=" $num"; fi
      done <<<"$listing"
      if [[ -n "$llm_nums" ]]; then
        say "Forwarding lines in $cfg on ports only LLM software uses:"
        for num in $llm_nums; do sed -n "${num}p" "$cfg" | indent; done
        if confirm "Comment these lines out (the file is backed up first)?" y; then chosen+="$llm_nums"; fi
      fi
      if [[ -n "$other_nums" ]]; then
        say "Other forwarding lines in $cfg:"
        for num in $other_nums; do sed -n "${num}p" "$cfg" | indent; done
        if confirm "They are not identified as LLM forwarding. Comment them out as well?" n; then chosen+="$other_nums"; fi
      fi
      [[ -n "$chosen" ]] || continue
      backup_path "$cfg"
      # A linked config is edited through the link, so its target is what
      # needs the copy.
      if [[ -L "$cfg" ]]; then backup_path "$(readlink -f -- "$cfg")"; fi
      if ((DRY_RUN)); then
        printf '[dry-run] would comment out lines%s of %s\n' "$chosen" "$cfg"
        continue
      fi
      tmp=$(mktemp)
      awk -v nums="$chosen" '
        BEGIN { n = split(nums, list, " "); for (i = 1; i <= n; i++) pick[list[i]] = 1 }
        (FNR in pick) { print "# disabled by gmat-llm setup: " $0; next }
        { print }' "$cfg" >"$tmp"
      cat "$tmp" >"$cfg"
      rm -f "$tmp"
      info "Commented out lines${chosen} of $cfg"
    done
  done < <(human_users)
  ((any)) || info "No forwarding lines in SSH client configs."
  return 0
}

# ---------------------------------------------------------------------------
# The SSH server: its binary, the ports it really listens on, and changes to
# its config. A change is made on a copy first and goes ahead only if sshd -t
# accepts it and every other user's login settings stay exactly the same; the
# live change is checked again and rolled back on any difference.
# ---------------------------------------------------------------------------

sshd_binary() {
  if [[ -x /usr/sbin/sshd ]]; then printf '/usr/sbin/sshd'; else command -v sshd || true; fi
}

# Runs sshd with the given options (-t or -T). sshd needs its empty folder
# /run/sshd; a dry run that has to make it takes it away again.
sshd_run() {
  local sshd made=0 rc=0
  sshd=$(sshd_binary)
  [[ -n "$sshd" ]] || return 127
  if [[ ! -d /run/sshd ]] && mkdir -p /run/sshd 2>/dev/null; then made=1; fi
  "$sshd" "$@" || rc=$?
  if ((made && DRY_RUN)); then rmdir /run/sshd 2>/dev/null || true; fi
  return "$rc"
}

sshd_config_ok() {
  sshd_run -t
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

# Works out the ports SSH really uses, from four places: the listening
# sockets of sshd (or of systemd for Ubuntu 24.04's ssh.socket), the ports
# sshd's config names (sshd -T), the ports ssh.socket names, and the server
# ports of the SSH sessions open now. Sets:
#   SSH_PORTS       the ports to keep open: those listened on and in use
#   SSH_PORTS_ALL   every port any source names, never to be closed
#   SSH_PORTS_SURE  1 when the sources agree, else 0 with SSH_PORTS_NOTE
detect_ssh_ports() {
  local out cfg_ports="" socket_ports="" socket_active=0 listen_ports="" session_ports="" line addr port users expected
  if [[ -n "$(sshd_binary)" ]] && out=$(sshd_run -T 2>/dev/null); then
    # ListenAddress lines carry the port sshd uses; Port lines are only a
    # default for addresses without one.
    cfg_ports=$(awk '$1 == "listenaddress" {n = split($2, a, ":"); print a[n]}' <<<"$out" | sort -un)
    if [[ -z "$cfg_ports" ]]; then cfg_ports=$(awk '$1 == "port" {print $2}' <<<"$out" | sort -un); fi
  fi
  if have systemctl && [[ "$(systemctl is-active ssh.socket 2>/dev/null || true)" == active ]]; then
    socket_active=1
    socket_ports=$(systemctl show -p Listen --value ssh.socket 2>/dev/null | grep -oE ':[0-9]+ \(Stream\)' | grep -oE '[0-9]+' | sort -un || true)
  fi
  while read -r line; do
    [[ -n "$line" ]] || continue
    addr=$(awk '{print $4}' <<<"$line")
    port=${addr##*:}
    [[ "$port" =~ ^[0-9]+$ ]] || continue
    users=$(grep -o 'users:(.*' <<<"$line" || true)
    if grep -qE '\("sshd(-session)?",' <<<"$users"; then
      listen_ports+="$port"$'\n'
    elif ((socket_active)) && grep -qF '("systemd",pid=1,' <<<"$users" && grep -qx "$port" <<<"$socket_ports"; then
      listen_ports+="$port"$'\n'
    fi
  done < <(ss -ltnpH 2>/dev/null || true)
  listen_ports=$(sed '/^$/d' <<<"$listen_ports" | sort -un)
  while read -r line; do
    [[ -n "$line" ]] || continue
    grep -qE '\("sshd(-session)?",' <<<"$line" || continue
    addr=$(awk '{print $3}' <<<"$line")
    port=${addr##*:}
    if [[ "$port" =~ ^[0-9]+$ ]]; then session_ports+="$port"$'\n'; fi
    # A session from this computer itself may come through a reverse tunnel.
    case "$(awk '{print $4}' <<<"$line")" in
      127.* | "[::1]"* | "[::ffff:127."*) SSH_LOOPBACK_SESSION=1 ;;
    esac
  done < <(ss -tnpH state established 2>/dev/null || true)
  if [[ -n "$SSH_SESSION_PORT" ]]; then session_ports+="$SSH_SESSION_PORT"$'\n'; fi
  session_ports=$(sed '/^$/d' <<<"$session_ports" | sort -un)
  if ((socket_active)); then expected=$socket_ports; else expected=$cfg_ports; fi
  SSH_PORTS=$(printf '%s\n%s\n' "$listen_ports" "$session_ports" | sed '/^$/d' | sort -un | tr '\n' ' ')
  SSH_PORTS=${SSH_PORTS% }
  SSH_PORTS_ALL=$(printf '%s\n%s\n%s\n%s\n' "$listen_ports" "$session_ports" "$cfg_ports" "$socket_ports" | sed '/^$/d' | sort -un | tr '\n' ' ')
  SSH_PORTS_ALL=${SSH_PORTS_ALL% }
  SSH_PORTS_SURE=0
  SSH_PORTS_NOTE=""
  if [[ -z "$listen_ports" ]]; then
    SSH_PORTS_NOTE="ss shows no SSH server listening"
  elif [[ -z "$expected" ]]; then
    SSH_PORTS_NOTE="sshd -T could not show the ports sshd's config names"
  elif [[ "$(tr '\n' ' ' <<<"$expected")" != "$(tr '\n' ' ' <<<"$listen_ports")" ]]; then
    local named heard
    named=$(tr '\n' ' ' <<<"$expected")
    heard=$(tr '\n' ' ' <<<"$listen_ports")
    SSH_PORTS_NOTE="the config names port(s) ${named% } but sshd listens on ${heard% }"
  else
    local stray=""
    for port in $session_ports; do
      grep -qx "$port" <<<"$listen_ports" || stray+="$port "
    done
    if [[ -n "$stray" ]]; then
      SSH_PORTS_NOTE="an open SSH session uses port(s) ${stray}that sshd no longer listens on"
    else
      SSH_PORTS_SURE=1
    fi
  fi
}

report_ssh_ports() {
  if ((SSH_PORTS_SURE)); then
    info "SSH listens on port(s) $SSH_PORTS; the firewall keeps them open."
  else
    warn "The SSH port could not be worked out with confidence: $SSH_PORTS_NOTE. Setup will not turn on the firewall, and keeps every rule for port(s) ${SSH_PORTS_ALL:-22}."
  fi
}

# The users and client addresses a change is checked for: the user who ran
# sudo, root and a user no rule names, connecting from this session's
# address, from this computer and from a hotspot address.
sshd_probe_users() {
  if [[ -n "$INVOKING_USER" && "$INVOKING_USER" != root ]]; then printf '%s\n' "$INVOKING_USER"; fi
  printf '%s\n' root gmat-llm-nobody
}

sshd_probe_addrs() {
  local peer=${SSH_SESSION_PEER%:*}
  peer=${peer#[}
  peer=${peer%]}
  peer=${peer#::ffff:}
  {
    if [[ "$peer" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then printf '%s\n' "$peer"; fi
    printf '%s\n' 127.0.0.1 172.20.10.2
  } | sort -u
}

# Settings that decide who can log in and how. A change to the SSH server
# config must leave all of them unchanged for every probe user.
readonly SSHD_GUARD_KEYS="port listenaddress addressfamily passwordauthentication pubkeyauthentication kbdinteractiveauthentication challengeresponseauthentication authenticationmethods authorizedkeysfile authorizedkeyscommand authorizedkeyscommanduser authorizedprincipalsfile allowusers allowgroups denyusers denygroups permitrootlogin permitemptypasswords usepam hostbasedauthentication gssapiauthentication kerberosauthentication maxauthtries maxsessions maxstartups logingracetime pubkeyacceptedalgorithms trustedusercakeys revokedkeys forcecommand chrootdirectory permittty"

# Prints those settings for every probe user and address, from the live
# config or from CONFIG.
sshd_login_snapshot() {
  local config=$1 user addr out args=()
  if [[ -n "$config" ]]; then args=(-f "$config"); fi
  for user in $(sshd_probe_users); do
    for addr in $(sshd_probe_addrs); do
      if ! out=$(sshd_run -T "${args[@]}" -C "user=$user,host=$addr,addr=$addr" 2>&1); then
        printf 'ERROR %s from %s: %s\n' "$user" "$addr" "$(first_line <<<"$out")"
        continue
      fi
      awk -v who="$user from $addr" -v keys=" $SSHD_GUARD_KEYS " 'index(keys, " " $1 " ") {print who ": " $0}' <<<"$out"
    done
  done
}

# Copies the SSH server config to DIR: every file under /etc/ssh except the
# host keys, with Include lines that point into /etc/ssh, or are relative
# (sshd reads those from /etc/ssh), pointing into DIR instead. A symbolic
# link is copied as the file it points to, so a change to the copy can never
# write through to the live config.
sshd_make_copy() {
  local dir=$1
  mkdir -p "$dir"
  (cd /etc/ssh && find . \( -type f -o -type l \) ! -name 'ssh_host_*' ! -name moduli -exec cp -aL --parents {} "$dir/" \;) || return 1
  python3 -I - "$dir" <<'PY'
import os, re, shlex, sys
root = sys.argv[1]
safe = re.compile(r"^[A-Za-z0-9._/*?\[\]-]+$")
def move(token):
    if token.startswith("/etc/ssh/"):
        token = root + token[len("/etc/ssh"):]
    elif not token.startswith(("/", "~")):
        token = root + "/" + token
    return token if safe.match(token) else '"' + token.replace('"', '\\"') + '"'
for base, _, names in os.walk(root):
    for name in names:
        path = os.path.join(base, name)
        if os.path.islink(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                lines = f.read().split("\n")
        except (UnicodeDecodeError, OSError):
            continue
        changed = False
        for i, line in enumerate(lines):
            m = re.match(r"^(\s*)include(?:\s*=\s*|\s+)(.*)$", line, re.I)
            if not m:
                continue
            try:
                tokens = shlex.split(m.group(2), comments=True)
            except ValueError:
                sys.exit(3)
            lines[i] = m.group(1) + "Include " + " ".join(move(t) for t in tokens)
            changed = True
        if changed:
            with open(path, "w", encoding="utf-8") as f:
                f.write("\n".join(lines))
PY
}

# A checksum of the SSH server config files, to tell whether a change wrote
# anything.
sshd_config_checksum() {
  (cd /etc/ssh && find . \( -type f -o -type l \) ! -name 'ssh_host_*' ! -name moduli -print0 | sort -z | xargs -0 -r sha256sum) 2>/dev/null | sha256sum | awk '{print $1}'
}

# sshd_apply CHANGE WHAT [CHECK]: CHANGE ROOT edits the SSH server config
# under ROOT (/etc/ssh, or a copy). The copy goes first; the live config is
# changed only if sshd -t accepts the copy, the probe users' login settings
# stay exactly the same and CHECK CONFIG passes. The live result is checked
# the same way, and any difference puts every file back. Returns 1 when the
# change is not made. sshd is not reloaded here (see SSHD_CHANGED).
# Whether setup may change the SSH server config at all: it must pass
# sshd -t as it is, and hold no symbolic links, which the copy that a change
# is rolled back from could not put back. Says why not.
sshd_config_editable() {
  local err linked
  if ! err=$(sshd_run -t 2>&1); then
    warn "The SSH server config already fails 'sshd -t', so setup does not change it: $(tr '\n' ' ' <<<"$err")"
    return 1
  fi
  linked=$(find /etc/ssh/sshd_config /etc/ssh/sshd_config.d -maxdepth 1 -type l 2>/dev/null | tr '\n' ' ' || true)
  if [[ -n "$linked" ]]; then
    warn "${linked}is a symbolic link, which setup does not edit, so the SSH server config is not changed."
    return 1
  fi
}

sshd_apply() {
  local change=$1 what=$2 check=${3:-} work before after users sum_before
  sshd_config_editable || return 1
  work=$(mktemp -d)
  before=$(sshd_login_snapshot "")
  if [[ -z "$before" ]] || grep -q '^ERROR ' <<<"$before"; then
    warn "sshd -T cannot show the login settings to compare ($(grep '^ERROR ' <<<"$before" | first_line || true)), so $what cannot be checked and is not made."
    rm -rf "$work"
    return 1
  fi
  if ! sshd_make_copy "$work/ssh"; then
    warn "The SSH server config could not be copied for a check (an Include line setup cannot read), so $what is not made."
    rm -rf "$work"
    return 1
  fi
  "$change" "$work/ssh"
  if ! sshd_run -t -f "$work/ssh/sshd_config" >"$work/err" 2>&1; then
    warn "sshd -t rejects the config with $what: $(tr '\n' ' ' <"$work/err")"
    rm -rf "$work"
    return 1
  fi
  after=$(sshd_login_snapshot "$work/ssh/sshd_config")
  after=${after//"$work/ssh"/\/etc\/ssh}
  if [[ "$after" != "$before" ]]; then
    warn "$what would change how other users log in, so it is not made:"
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep '^[<>]' | sed 's/^</  before:/; s/^>/  after: /' >&2 || true
    rm -rf "$work"
    return 1
  fi
  if [[ -n "$check" ]] && ! "$check" "$work/ssh/sshd_config"; then
    rm -rf "$work"
    return 1
  fi
  users=$(sshd_probe_users | tr '\n' ' ')
  if ((DRY_RUN)); then
    printf '[dry-run] checked %s on a copy of the SSH server config: sshd -t accepts it, and logins stay the same for %s\n' "$what" "${users% }"
    rm -rf "$work"
    return 0
  fi
  # The live change, with a copy of every file to go back to.
  mkdir -p "$work/restore"
  (cd /etc/ssh && find . \( -type f -o -type l \) ! -name 'ssh_host_*' ! -name moduli -exec cp -a --parents {} "$work/restore/" \;)
  (cd /etc/ssh && find . \( -type f -o -type l \) ! -name 'ssh_host_*' ! -name moduli | sort) >"$work/files-before"
  backup_path /etc/ssh/sshd_config
  if [[ -d /etc/ssh/sshd_config.d ]]; then backup_path /etc/ssh/sshd_config.d; fi
  sum_before=$(sshd_config_checksum)
  "$change" /etc/ssh
  if sshd_run -t >"$work/err" 2>&1 && [[ "$(sshd_login_snapshot "")" == "$before" ]] && { [[ -z "$check" ]] || "$check" ""; }; then
    if [[ "$(sshd_config_checksum)" != "$sum_before" ]]; then SSHD_CHANGED=1; fi
    rm -rf "$work"
    return 0
  fi
  warn "The SSH server config did not check out after $what; putting every file back."
  sshd_restore "$work"
  rm -rf "$work"
  return 1
}

# Puts /etc/ssh back from sshd_apply's copy: files the change added go, the
# others come back as they were.
sshd_restore() {
  local work=$1 f
  (cd /etc/ssh && find . \( -type f -o -type l \) ! -name 'ssh_host_*' ! -name moduli | sort) >"$work/files-after"
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    rm -f -- "/etc/ssh/${f#./}"
  done < <(comm -13 "$work/files-before" "$work/files-after")
  (cd "$work/restore" && find . \( -type f -o -type l \) -exec cp -a --parents {} /etc/ssh/ \;)
  if sshd_run -t >/dev/null 2>&1; then
    info "The SSH server config is as it was before."
  else
    die "The SSH server config could not be put back. Copy the files from $BACKUP_DIR/etc/ssh to /etc/ssh before sshd restarts, and run sudo sshd -t."
  fi
}

# Whether sshd_config reads sshd_config.d/*.conf before any Match block.
sshd_reads_dropins() {
  awk '
    tolower($1) == "match" { exit 1 }
    tolower($1) == "include" {
      for (i = 2; i <= NF; i++) if ($i == "/etc/ssh/sshd_config.d/*.conf" || $i == "sshd_config.d/*.conf") found = 1
    }
    END { exit !found }' /etc/ssh/sshd_config 2>/dev/null
}

# Forwarding settings an old setup may have added.
readonly SSHD_FORWARD_KEYS='GatewayPorts|PermitTunnel|AllowTcpForwarding|PermitOpen|PermitListen|AllowStreamLocalForwarding'

# Lines to comment out, one "file<TAB>line numbers" per line (file relative
# to /etc/ssh), and the content of the reset drop-in, for the change below.
SSHD_COMMENT_LINES=""
SSHD_RESET_CONTENT=""

change_forwarding_cleanup() {
  local root=$1 rel nums tmp
  while IFS=$'\t' read -r rel nums; do
    [[ -n "$rel" && -f "$root/$rel" ]] || continue
    tmp=$(mktemp)
    awk -v nums="$nums" '
      BEGIN { n = split(nums, list, " "); for (i = 1; i <= n; i++) pick[list[i]] = 1 }
      (FNR in pick) { print "# disabled by gmat-llm setup: " $0; next }
      { print }' "$root/$rel" >"$tmp"
    cat "$tmp" >"$root/$rel"
    rm -f "$tmp"
  done <<<"$SSHD_COMMENT_LINES"
  if [[ -n "$SSHD_RESET_CONTENT" ]]; then
    mkdir -p "$root/sshd_config.d"
    printf '%s\n' "$SSHD_RESET_CONTENT" >"$root/sshd_config.d/${SSHD_RESET_DROPIN##*/}"
    chmod 0644 "$root/sshd_config.d/${SSHD_RESET_DROPIN##*/}"
  fi
}

# The reset drop-in must really turn the settings off.
check_forwarding_reset() {
  local config=$1 args=() out
  [[ -n "$SSHD_RESET_CONTENT" ]] || return 0
  if [[ -n "$config" ]]; then args=(-f "$config"); fi
  out=$(sshd_run -T "${args[@]}" -C "user=gmat-llm-nobody,host=127.0.0.1,addr=127.0.0.1" 2>/dev/null || true)
  if grep -qiE '^gatewayports (yes|clientspecified)' <<<"$out" || grep -qiE '^permittunnel (yes|point-to-point|ethernet)' <<<"$out"; then
    warn "A reset drop-in would not take effect here: sshd_config sets these before it reads sshd_config.d."
    return 1
  fi
}

# Server-side forwarding settings an old setup may have added. In drop-ins
# that name LLM software, only the forwarding lines are offered for
# commenting out; the rest of such a file stays. Settings anywhere else are
# shown and left alone, except that GatewayPorts or PermitTunnel can be
# turned off by a drop-in sshd reads first. sshd is reloaded, never restarted.
cleanup_sshd_forwarding() {
  local files=() f rel hits nums other="" widen need_gateway=0 need_tunnel=0 default
  if [[ ! -f /etc/ssh/sshd_config ]]; then
    info "No OpenSSH server config."
    return 0
  fi
  files=(/etc/ssh/sshd_config)
  for f in /etc/ssh/sshd_config.d/*.conf; do
    if [[ "$f" != "$SSHD_DROPIN" && "$f" != "$SSHD_RESET_DROPIN" ]]; then files+=("$f"); fi
  done
  SSHD_COMMENT_LINES=""
  SSHD_RESET_CONTENT=""
  for f in "${files[@]}"; do
    hits=$(grep -niE "^[[:space:]]*($SSHD_FORWARD_KEYS)([[:space:]]|=)" "$f" 2>/dev/null || true)
    [[ -n "$hits" ]] || continue
    if [[ "$f" != /etc/ssh/sshd_config ]] && { is_llm_text "$(cat "$f")" || [[ "$(basename "$f" | tr '[:upper:]' '[:lower:]')" == *llm* ]]; }; then
      say "Forwarding lines in $f, a drop-in that looks like it came from an old LLM setup:"
      indent <<<"$hits"
      widen=0
      grep -qiE '(GatewayPorts[[:space:]=]+(yes|clientspecified))|(PermitTunnel[[:space:]=]+(yes|point-to-point|ethernet))|(PermitListen[[:space:]=]+any)|(PermitOpen[[:space:]=]+any)' <<<"$hits" && widen=1
      default=n
      ((widen)) && default=y
      info "Only these lines would be commented out; the rest of the file stays."
      if confirm "Comment these lines out?" "$default"; then
        rel=${f#/etc/ssh/}
        nums=$(cut -d: -f1 <<<"$hits" | tr '\n' ' ')
        SSHD_COMMENT_LINES+="$rel"$'\t'"${nums% }"$'\n'
      fi
      continue
    fi
    other+="$f:"$'\n'"$(indent <<<"$hits")"$'\n'
    if grep -qiE 'GatewayPorts[[:space:]=]+(yes|clientspecified)' <<<"$hits"; then need_gateway=1; fi
    if grep -qiE 'PermitTunnel[[:space:]=]+(yes|point-to-point|ethernet)' <<<"$hits"; then need_tunnel=1; fi
  done
  if [[ -n "$other" ]]; then
    say "Forwarding settings in the SSH server config (not identified as LLM-related, so not edited):"
    printf '%s' "$other"
  fi
  if ((need_gateway || need_tunnel)) && sshd_reads_dropins; then
    say "GatewayPorts or PermitTunnel is turned on above, which lets forwarded ports or tunnels reach the network. The tunnel user has both off in its own rules either way."
    if confirm "Turn them off for every user with a drop-in sshd reads first ($SSHD_RESET_DROPIN)?" n; then
      SSHD_RESET_CONTENT="# Written by gmat-llm setup. sshd uses the first value it reads, and this file
# is read before the others, so it turns off forwarding an old setup turned on.
# Remove it to go back."
      ((need_gateway)) && SSHD_RESET_CONTENT+=$'\nGatewayPorts no'
      ((need_tunnel)) && SSHD_RESET_CONTENT+=$'\nPermitTunnel no'
    fi
  fi
  if [[ -n "$SSHD_COMMENT_LINES$SSHD_RESET_CONTENT" ]]; then
    if sshd_apply change_forwarding_cleanup "the forwarding changes" check_forwarding_reset; then
      if [[ -n "$SSHD_RESET_CONTENT" ]]; then record_installed "file:$SSHD_RESET_DROPIN"; fi
      if ((!DRY_RUN && SSHD_CHANGED)); then reload_sshd; fi
    else
      warn "The SSH server config is left as it was."
    fi
  elif [[ -z "$other" ]]; then
    info "No forwarding settings in the SSH server config."
  fi
  return 0
}

# The ports a ufw rule names, one "first last" pair per line (a single port
# is first = last). Prints nothing for a rule without a port, which covers
# every port.
ufw_rule_ports() {
  local words=() word items=() item
  read -r -a words <<<"$1"
  for word in "${words[@]}"; do
    word=${word%/tcp}
    word=${word%/udp}
    [[ "$word" =~ ^[0-9]+([:,][0-9]+)*$ ]] || continue
    IFS=, read -r -a items <<<"$word"
    for item in "${items[@]}"; do
      if [[ "$item" == *:* ]]; then printf '%s %s\n' "${item%%:*}" "${item##*:}"; else printf '%s %s\n' "$item" "$item"; fi
    done
  done
}

# Rules for LLM ports from earlier setups. A rule that names an SSH port, an
# SSH application profile, a range around an SSH port, or no port at all is
# never deleted. While ufw is on, every deletion defaults to no.
cleanup_ufw_rules() {
  have ufw || {
    info "ufw is not installed yet."
    return 0
  }
  local rules rule spec pairs first last p protected keep class default words=() found=0 active=0
  [[ "$(ufw status 2>/dev/null | first_line || true)" == *"Status: active"* ]] && active=1
  rules=$(ufw show added 2>/dev/null | grep -E '^ufw ' || true)
  if [[ -z "$rules" ]]; then
    info "No ufw rules yet."
    return 0
  fi
  protected="22 $SSH_PORTS_ALL ${SSH_SESSION_PORT:-}"
  while IFS= read -r rule; do
    [[ -n "$rule" ]] || continue
    [[ "$rule" != *"gmat-llm"* ]] || continue
    # ufw delete takes the rule without its comment.
    spec=${rule#ufw }
    spec=${spec%% comment *}
    pairs=$(ufw_rule_ports "$spec")
    keep=""
    if [[ -z "$pairs" ]]; then
      keep="it covers every port"
    elif grep -qi 'ssh' <<<"$spec"; then
      keep="it is an SSH rule"
    else
      while read -r first last; do
        [[ -n "$first" ]] || continue
        for p in $protected; do
          if ((p >= first && p <= last)); then keep="it covers the SSH port $p"; fi
        done
      done <<<"$pairs"
    fi
    class=other
    while read -r first last; do
      [[ -n "$first" && "$first" == "$last" ]] || continue
      case "$(port_class "$first")" in
        strong) class=strong ;;
        common) [[ "$class" == strong ]] || class=common ;;
      esac
    done <<<"$pairs"
    [[ "$class" != other ]] || continue
    found=1
    if [[ -n "$keep" ]]; then
      info "ufw rule: $rule (kept: $keep)"
      continue
    fi
    default=n
    if ((!active)) && [[ "$class" == strong ]]; then default=y; fi
    info "ufw rule: $rule"
    if confirm "Delete this ufw rule?" "$default"; then
      read -r -a words <<<"$spec"
      run ufw --force delete "${words[@]}" || warn "Could not delete: $rule"
    fi
  done <<<"$rules"
  ((found)) || info "No ufw rules for LLM ports."
  return 0
}

cleanup_old_setup() {
  step "2. Clean out earlier local LLM setups"
  if ((SKIP_CLEANUP)); then
    info "Skipped (--skip-cleanup)."
    return 0
  fi
  say "Looking for services, containers, processes, models and SSH tunnels of earlier setups."
  say "Nothing is removed without a yes. --yes alone removes programs and services of LLM software, never models,"
  say "environments or container volumes (see --delete-old-models and --delete-old-envs)."
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

# The names of all installed packages, sorted, to tell afterwards which ones
# an install brought in.
installed_package_list() {
  dpkg-query -W -f='${Status}\t${Package}\n' 2>/dev/null | awk -F'\t' '$1 == "install ok installed" {print $2}' | sort -u
}

# Records every package that is installed now and was not in BEFORE (a file
# from installed_package_list), so uninstall knows exactly what came in.
record_new_packages() {
  local before=$1 pkg
  ((DRY_RUN)) && return 0
  while IFS= read -r pkg; do
    [[ -n "$pkg" ]] || continue
    record_installed "apt:$pkg"
  done < <(comm -13 "$before" <(installed_package_list))
}

install_base_packages() {
  local wanted=(build-essential cmake ninja-build git curl ca-certificates pkg-config libssl-dev python3 avahi-daemon ufw pciutils openssh-server)
  local missing bytes before
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
  before=$(mktemp)
  installed_package_list >"$before"
  # shellcheck disable=SC2086
  run env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends $missing
  record_new_packages "$before"
  rm -f "$before"
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
# different keys make apt update fail, so those entries are turned off, and
# turned back on if the CUDA install is declined after all.
DISABLED_CUDA_SOURCES=()
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
      DISABLED_CUDA_SOURCES+=("$f")
    done
  else
    warn "apt update may fail with \"Conflicting values set for option Signed-By\" until these entries are removed."
  fi
}

restore_cuda_sources() {
  local f
  for f in "${DISABLED_CUDA_SOURCES[@]}"; do
    if [[ "$f" == /etc/apt/sources.list ]]; then
      if ((DRY_RUN)); then
        printf '[dry-run] would put back %s from %s\n' "$f" "$BACKUP_DIR$f"
      else
        cp -a -- "$BACKUP_DIR$f" "$f"
      fi
    else
      run mv -f "$f.disabled-by-gmat-llm" "$f"
    fi
  done
  DISABLED_CUDA_SOURCES=()
}

install_cuda_toolkit() {
  NVCC=""
  if NVCC=$(find_suitable_nvcc); then
    info "Using the CUDA compiler $NVCC (CUDA $(nvcc_version "$NVCC"))"
    return 0
  fi
  local url sha deb tmpdir bytes before added_keyring=0 added_pin=0
  if [[ "$OS_VERSION" == "22.04" ]]; then
    url=$CUDA_KEYRING_URL_2204
    sha=$CUDA_KEYRING_SHA256_2204
  else
    url=$CUDA_KEYRING_URL_2404
    sha=$CUDA_KEYRING_SHA256_2404
  fi
  say "No suitable CUDA compiler. llama.cpp needs CUDA 12.8 from NVIDIA's repository:"
  info "the cuda-keyring package, which adds NVIDIA's repository to apt;"
  info "an apt pin ($APT_PIN_FILE) that keeps the driver coming from Ubuntu;"
  info "the packages $CUDA_PACKAGES, about 1 GB to download."
  confirm "Add NVIDIA's repository and go on?" y || die "llama.cpp needs the CUDA toolkit to use the GPU; nothing was added."
  disable_conflicting_cuda_sources
  before=$(mktemp)
  installed_package_list >"$before"
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
    added_keyring=1
  fi
  if [[ ! -f "$APT_PIN_FILE" ]]; then added_pin=1; fi
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
  if ! confirm "Download and install them?" y; then
    # Back to how apt was: no NVIDIA repository left behind.
    if ((added_keyring)); then run dpkg --purge cuda-keyring || warn "Could not remove cuda-keyring; remove it with: sudo apt purge cuda-keyring"; fi
    if ((added_pin)); then run rm -f "$APT_PIN_FILE"; fi
    restore_cuda_sources
    APT_UPDATED=0
    apt_update_once
    rm -f "$before"
    die "llama.cpp needs the CUDA toolkit to use the GPU. NVIDIA's repository was removed again."
  fi
  # shellcheck disable=SC2086
  run env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends $CUDA_PACKAGES
  record_new_packages "$before"
  rm -f "$before"
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
    # A build that stopped part way (a dropped connection, Ctrl+C) carries on
    # where it stopped, as long as it was made with the same tag, compiler and
    # GPU; anything else starts from a clean build folder.
    if [[ -d "$build" ]] && [[ -f "$root/build-config" ]] && [[ "$(cat "$root/build-config")" == "$info" ]]; then
      say "Carrying on with the llama.cpp build that stopped part way, $jobs compile job(s) at a time."
    else
      say "Building llama.cpp with CUDA for sm_$GPU_CUDA_ARCH, $jobs compile job(s) at a time. This takes 20 to 60 minutes on a laptop."
      remove_path "$build"
      remove_path "$root/build-info"
      if ((!DRY_RUN)); then
        mkdir -p "$root"
        printf '%s\n' "$info" >"$root/build-config"
      fi
    fi
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
      mmproj_regex=""
      if [[ "$VISION" == on ]]; then mmproj_regex=$REASON_MMPROJ_REGEX; fi
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
    [[ -n "$id" ]] || continue
    info "$id: $path ($(human_bytes "$size")) from $repo"
  done <<<"$MODEL_PLAN"
  bytes=$(remaining_bytes)
  if ((bytes == 0)); then
    info "Every file is already downloaded."
  else
    free=$(free_bytes_for "$MODELS_DIR")
    if ((free < bytes + 2000000000)); then
      if ((DRY_RUN)); then
        warn "Not enough disk space: $(human_bytes "$bytes") to download, $(human_bytes "$free") free. The dry run goes on; the real run stops here."
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

# RAM the 35B-A3B needs with a quantization, in MiB, estimated from its file
# size and the VRAM: its experts are all but about 2.4 GiB of the file, and
# stay in RAM except for what fits on the GPU beside the other weights
# (1.9 GiB), the 16K cache (0.3 GiB), the CUDA buffers (1 GiB) and a 1.5 GiB
# margin. The token embeddings (0.5 GiB) and the program (1 GiB) come on top.
reason_ram_mib() {
  local file_mib experts gpu vram=${GPU_VRAM_MIB:-0}
  if [[ "$1" == UD-Q2_K_XL ]]; then file_mib=$SIZE_MIB_REASON_Q2; else file_mib=$SIZE_MIB_REASON_Q3; fi
  experts=$((file_mib - 2440))
  gpu=$((vram - 1945 - 320 - 1024 - 1536))
  ((gpu < 0)) && gpu=0
  ((gpu > experts)) && gpu=$experts
  printf '%s' $((experts - gpu + 512 + 1024))
}

# The larger quantization that leaves 1.5 GiB of the service's memory limit
# (RAM less 1 GiB) for the page cache to keep the experts in.
fitting_reason_quant() {
  local limit=$((MEM_TOTAL_KIB / 1024 - 1024))
  if (($(reason_ram_mib UD-Q3_K_XL) + 1536 <= limit)); then printf 'UD-Q3_K_XL'; else printf 'UD-Q2_K_XL'; fi
}

# Picks the 35B-A3B's quantization: the one given with --quant or saved from
# the last run, else the 3-bit file when RAM allows it, else the 2-bit file.
choose_reason_quant() {
  local limit need3 need2
  limit=$((MEM_TOTAL_KIB / 1024 - 1024))
  need3=$(reason_ram_mib UD-Q3_K_XL)
  need2=$(reason_ram_mib UD-Q2_K_XL)
  if ((REASON_QUANT_SET || REASON_QUANT_SAVED)); then
    if [[ "$REASON_QUANT" == UD-Q3_K_XL ]] && ((need3 + 1536 > limit)); then
      warn "The 3-bit file needs about $((need3 / 1024)) GiB of RAM here and the service may use $((limit / 1024)) GiB, so the kernel will keep reading experts from disk and replies will be slow. --quant UD-Q2_K_XL avoids that."
    fi
  elif ((need3 + 1536 <= limit)); then
    REASON_QUANT=UD-Q3_K_XL
  else
    say "With $GPU_VRAM_MIB MiB of VRAM, the 3-bit 35B-A3B file (16.9 GB) needs about $((need3 / 1024)) GiB of RAM for its experts and the program, and the service may use $((limit / 1024)) GiB. The kernel would keep reading experts from disk, which makes every reply slow. The 2-bit file (12.3 GB) needs about $((need2 / 1024)) GiB."
    if confirm "Use the 2-bit quantization (UD-Q2_K_XL)?" y; then
      REASON_QUANT=UD-Q2_K_XL
    else
      REASON_QUANT=UD-Q3_K_XL
      warn "Keeping the 3-bit file; expect slow replies from the 35B-A3B."
    fi
  fi
  if [[ "$REASON_QUANT" == UD-Q2_K_XL ]] && ((need2 + 1024 > limit)); then
    warn "Even the 2-bit file is tight with this much RAM; --profile minimal runs the 4B model only."
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

# The 35B-A3B's experts that stay in system RAM, as a list of layer numbers.
# llama-fit-params works out from free VRAM which layers' experts do not fit
# and names them in an -ot list (it picks the last layers); that list goes
# into the config as it is, so the VRAM used matches its estimate. The
# margin keeps 1.5 GiB of VRAM free for the context and the CUDA buffers,
# plus the vision projector when it is on. Prints "NGL<TAB>LAYERS", with
# LAYERS empty when every expert fits, "auto" when nothing can be measured,
# or "user" when --n-cpu-moe was given.
compute_expert_layers() {
  local model=$1 mmproj=$2 margin out line ngl layers
  if [[ -n "$N_CPU_MOE" ]]; then
    printf 'all\tuser'
    return 0
  fi
  if ((DRY_RUN)) || [[ ! -f "$model" ]]; then
    printf 'all\tauto'
    return 0
  fi
  margin=1536
  if [[ -n "$mmproj" && -f "$mmproj" ]]; then margin=$((margin + $(stat -c %s "$mmproj") / 1048576)); fi
  out=$("$(llama_bin llama-fit-params)" --model "$model" --ctx-size "$CTX_REASON" --parallel 1 --fit-target "$margin" 2>/dev/null || true)
  line=$(grep -E '^-c [0-9]+ -ngl' <<<"$out" | tail -n 1 || true)
  if [[ -z "$line" ]]; then
    warn "llama-fit-params gave no answer; keeping every expert in system RAM."
    printf 'all\t%s' "$(seq -s, 0 $((REASON_LAYERS - 1)))"
    return 0
  fi
  ngl=$(awk '{print $4}' <<<"$line")
  layers=$(grep -oE 'blk\\\.[0-9]+\\\.ffn' <<<"$line" | grep -oE '[0-9]+' | sort -un | tr '\n' ',' || true)
  printf '%s\t%s' "$ngl" "${layers%,}"
}

# The -ot patterns for a list of layers, as llama-fit-params writes them.
expert_override() {
  local layer out=""
  for layer in ${1//,/ }; do
    out+="${out:+,}blk\\.${layer}\\.ffn_(up|down|gate)_(ch|)exps=CPU"
  done
  printf '%s' "$out"
}

# How many layers keep their experts in RAM.
expert_layer_count() {
  if [[ -z "$1" ]]; then printf '0'; else tr ',' '\n' <<<"$1" | grep -c .; fi
}

# Host memory llama.cpp expects the model to use with these settings, in MiB.
host_mib_needed() {
  local model=$1 ngl=$2 layers=$3 out args=()
  if [[ -n "$layers" ]]; then args=(-ot "$(expert_override "$layers")"); fi
  out=$("$(llama_bin llama-fit-params)" --model "$model" --ctx-size "$CTX_REASON" --parallel 1 -ngl "$ngl" "${args[@]}" --fit-print on 2>/dev/null || true)
  awk '$1 == "Host" {print $2 + $3 + $4}' <<<"$out" | tail -n 1
}

tune_reason_model() {
  local model=$1 mmproj=$2 result ngl layers host mem_mib
  result=$(compute_expert_layers "$model" "$mmproj")
  ngl=${result%%$'\t'*}
  layers=${result#*$'\t'}
  case "$layers" in
    user)
      info "35B-A3B: the experts of the first $N_CPU_MOE layers stay in system RAM (--n-cpu-moe)."
      SAVED_NGL=all
      SAVED_CPU_LAYERS=""
      return 0
      ;;
    auto)
      info "The dry run cannot measure VRAM; the real run works out which experts stay in RAM with llama-fit-params."
      SAVED_NGL=all
      SAVED_CPU_LAYERS=auto
      return 0
      ;;
  esac
  SAVED_NGL=$ngl
  SAVED_CPU_LAYERS=$layers
  SAVED_N_CPU_MOE=""
  if ((!DRY_RUN)) && [[ -f "$model" ]]; then
    host=$(host_mib_needed "$model" "$ngl" "$layers")
    mem_mib=$((MEM_TOTAL_KIB / 1024))
    if [[ -n "$host" ]]; then
      info "35B-A3B: $(expert_layer_count "$layers") of $REASON_LAYERS layers keep their experts in system RAM; llama.cpp expects $host MiB of RAM and the rest in VRAM."
      if ((host + 1536 > mem_mib - 1024)); then
        warn "That leaves less than 1.5 GiB of the service's $((mem_mib - 1024)) MiB limit for the page cache and everything else, so the kernel will read experts from disk again and again and replies will be slow. Run setup again with --quant UD-Q2_K_XL to avoid that."
      fi
    fi
  fi
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
      printf '    description: "For %s"\n' "$(model_tasks fast)"
      ;;
    reason)
      printf '    name: "Qwen3.6 35B-A3B %s"\n' "$REASON_QUANT"
      printf '    description: "For %s"\n' "$(model_tasks reason)"
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
  # The keys in llama-swap's environment stay out of the model's.
  printf '      /usr/bin/env -u GMAT_LLM_API_KEY -u GMAT_LLM_CLOUD_API_KEY\n'
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
      if [[ "$VISION" == on && -n "$mmproj" ]]; then printf '      --mmproj %s\n' "$mmproj"; fi
      if [[ "$SAVED_N_CPU_MOE" =~ ^[0-9]+$ ]]; then
        printf '      # the experts of the first %s layers stay in system RAM (--n-cpu-moe)\n' "$SAVED_N_CPU_MOE"
        printf '      --n-gpu-layers %s\n' "${SAVED_NGL:-all}"
        printf '      --n-cpu-moe %s\n' "$SAVED_N_CPU_MOE"
        printf '      --fit off\n'
      elif [[ "$SAVED_CPU_LAYERS" != auto ]]; then
        printf '      # attention and shared weights on the GPU; the experts of %s layers\n' "$(expert_layer_count "$SAVED_CPU_LAYERS")"
        printf '      # stay in system RAM, as llama-fit-params worked out from free VRAM\n'
        printf '      --n-gpu-layers %s\n' "${SAVED_NGL:-all}"
        if [[ -n "$SAVED_CPU_LAYERS" ]]; then printf "      --override-tensor '%s'\n" "$(expert_override "$SAVED_CPU_LAYERS")"; fi
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
      printf "      # a low temperature: extraction copies text, and the app's three\n"
      printf '      # solver prompts differ already\n'
      printf '      --temp 0.3\n'
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
  cat <<EOT
# Written by gmat-llm setup. The tunnel user may only forward one local port,
# to the LLM endpoint; it gets no shell, no remote forwarding and no password
# login. AllowUsers and AllowGroups here apply to this user only, so a global
# AllowUsers list does not shut it out. Other users are not affected.
Match User $TUNNEL_USER
    AllowUsers $TUNNEL_USER
    AllowGroups $TUNNEL_USER
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
EOT
}

readonly SSHD_BLOCK_BEGIN="# BEGIN gmat-llm tunnel rules (written by gmat-llm setup; remove this block to undo)"
readonly SSHD_BLOCK_END="# END gmat-llm tunnel rules"

# Removes the marked block from FILE, if it is there.
drop_sshd_block() {
  local file=$1 tmp
  grep -qxF "$SSHD_BLOCK_BEGIN" "$file" 2>/dev/null || return 0
  tmp=$(mktemp)
  awk -v begin="$SSHD_BLOCK_BEGIN" -v end="$SSHD_BLOCK_END" '$0 == begin {skip = 1} !skip {print} $0 == end {skip = 0}' "$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

# Writes the tunnel user's rules under ROOT (/etc/ssh or a copy): as a
# drop-in when sshd_config reads sshd_config.d, otherwise as a marked block
# at the end of sshd_config. An Include line is never added, since it would
# turn on every other file in sshd_config.d.
change_tunnel_rules() {
  local root=$1 main="$1/sshd_config" dropin
  dropin="$root/sshd_config.d/${SSHD_DROPIN##*/}"
  drop_sshd_block "$main"
  if [[ "$SSHD_PLACEMENT" == dropin ]]; then
    mkdir -p "$root/sshd_config.d"
    sshd_dropin >"$dropin"
    chmod 0644 "$dropin"
  else
    rm -f "$dropin"
    if [[ -s "$main" && "$(tail -c 1 "$main")" != "" ]]; then printf '\n' >>"$main"; fi
    {
      printf '%s\n' "$SSHD_BLOCK_BEGIN"
      sshd_dropin
      printf '%s\n' "$SSHD_BLOCK_END"
    } >>"$main"
  fi
}

# The rules must take effect for the tunnel user from every probe address,
# and nothing in the config may deny it outright.
check_tunnel_rules() {
  local config=$1 args=() addr out deny
  if [[ -n "$config" ]]; then args=(-f "$config"); fi
  for addr in $(sshd_probe_addrs); do
    out=$(sshd_run -T "${args[@]}" -C "user=$TUNNEL_USER,host=$addr,addr=$addr" 2>/dev/null || true)
    if ! { grep -qx 'allowtcpforwarding local' <<<"$out" && grep -qx "permitopen 127.0.0.1:$PORT" <<<"$out" &&
      grep -qx 'permitlisten none' <<<"$out" && grep -qx 'forcecommand /usr/sbin/nologin' <<<"$out" &&
      grep -qx "authorizedkeysfile $AUTH_KEYS_FILE" <<<"$out" && grep -qx "allowusers $TUNNEL_USER" <<<"$out"; }; then
      warn "The tunnel rules do not take effect for $TUNNEL_USER connecting from $addr (an earlier Match block may set the same options first)."
      return 1
    fi
    deny=$(awk '$1 == "denyusers" || $1 == "denygroups" {print $1 " " $2}' <<<"$out")
    if [[ -n "$deny" ]]; then
      warn "The SSH server config has $(tr '\n' ' ' <<<"$deny")which may refuse $TUNNEL_USER; check that it does not."
    fi
  done
  return 0
}

# Where to try the rules: as a drop-in when sshd_config reads sshd_config.d
# at its top level, else (or when that does not take effect) in sshd_config.
sshd_placements() {
  if sshd_reads_dropins; then printf '%s\n' dropin block; else printf '%s\n' block; fi
}

setup_ssh_access() {
  local placement applied=0
  ensure_tunnel_user
  if [[ ! -f /etc/ssh/sshd_config ]]; then
    if ((DRY_RUN)); then
      printf '[dry-run] openssh-server is installed in step 3; the tunnel rules are checked against its config when setup runs for real\n'
      return 0
    fi
    die "/etc/ssh/sshd_config is missing although openssh-server is installed; reinstall openssh-server."
  fi
  SSHD_CHANGED=0
  # Rules someone added by hand, where setup's own would not take effect or
  # in a config setup does not edit, count as long as they take effect.
  if [[ ! -f "$SSHD_DROPIN" ]] && ! grep -qxF "$SSHD_BLOCK_BEGIN" /etc/ssh/sshd_config 2>/dev/null && check_tunnel_rules "" >/dev/null 2>&1; then
    info "The tunnel rules already in the SSH server config take effect for $TUNNEL_USER; it is not changed."
    return 0
  fi
  sshd_config_editable || die "The tunnel rules were not added and the SSH server config was not changed. Fix the cause above and run setup again, or add these lines to the SSH server config yourself where they take effect, check it with sudo sshd -t, reload sshd (sudo systemctl reload ssh) and run setup again:
$(sshd_dropin)"
  for placement in $(sshd_placements); do
    SSHD_PLACEMENT=$placement
    if [[ "$placement" == dropin ]]; then
      say "The tunnel user's rules go in $SSHD_DROPIN, which sshd_config already reads:"
    else
      say "The tunnel user's rules go in a marked block at the end of /etc/ssh/sshd_config. Setup does not make sshd_config read sshd_config.d, which would turn on the files there:"
    fi
    sshd_dropin | indent
    if sshd_apply change_tunnel_rules "the tunnel rules" check_tunnel_rules; then
      applied=1
      break
    fi
  done
  ((applied)) || die "The tunnel rules could not be added without changing other SSH settings, so nothing was changed (see the warnings above). Fix the cause, or add the rules above to /etc/ssh/sshd_config yourself where they take effect (before any Match block that sets the same options), check it with sudo sshd -t, reload sshd (sudo systemctl reload ssh) and run setup again."
  if [[ "$SSHD_PLACEMENT" == dropin ]]; then record_installed "file:$SSHD_DROPIN"; else record_installed "sshd-block"; fi
  ((DRY_RUN)) && return 0
  if ((SSHD_CHANGED)); then reload_sshd; else info "The SSH rules for $TUNNEL_USER were already in place."; fi
  info "sshd applies them: $TUNNEL_USER may forward to 127.0.0.1:$PORT only, and logins of $(sshd_probe_users | tr '\n' ' ')did not change."
}

# Programs other than sshd and avahi that accept connections from the
# network, TCP and UDP; the firewall will block them. Docker publishes ports
# past ufw, so those stay reachable.
warn_network_listeners() {
  local line addr name proto others="" docker=""
  for proto in t u; do
    while read -r line; do
      [[ -n "$line" ]] || continue
      addr=$(awk '{print $4}' <<<"$line")
      case "$addr" in 127.* | "[::1]"* | "::1"* | "[::ffff:127."*) continue ;; esac
      name=$(grep -o '(("[^"]*"' <<<"$line" | first_line | tr -d '("' || true)
      case "$name" in
        sshd | sshd-session | systemd | avahi-daemon | systemd-resolve | systemd-network | systemd-timesyn | chronyd | dhclient) continue ;;
        docker-proxy)
          docker+="$addr"$'\n'
          continue
          ;;
      esac
      if [[ "$proto" == t ]]; then others+="$addr/tcp ${name:-unknown}"$'\n'; else others+="$addr/udp ${name:-unknown}"$'\n'; fi
    done < <(ss "-l${proto}npH" 2>/dev/null || true)
  done
  if [[ -n "$others" ]]; then
    say "These programs accept connections from the network; with the firewall on they are blocked unless you add a rule (sudo ufw allow PORT/tcp or PORT/udp):"
    printf '%s' "$others" | indent
  fi
  if [[ -n "$docker" ]]; then
    say "Docker publishes these ports itself, past ufw, so they stay reachable from the network. Stop those containers, or publish them on 127.0.0.1 only:"
    printf '%s' "$docker" | indent
  fi
}

setup_firewall() {
  local status port
  status=$(ufw status 2>/dev/null | first_line || true)
  detect_ssh_ports
  say "Firewall (ufw): ${status:-ufw not installed}"
  if ((!SSH_PORTS_SURE)); then
    FIREWALL_SKIPPED=1
    warn "The firewall is left as it is: the SSH port could not be worked out with confidence ($SSH_PORTS_NOTE), and a wrong guess would lock SSH out."
    say "Check the port sshd listens on (sudo ss -ltnp | grep sshd), then turn the firewall on yourself:"
    for port in ${SSH_PORTS_ALL:-22}; do info "sudo ufw limit $port/tcp"; done
    info "sudo ufw default deny incoming"
    info "sudo ufw enable"
    return 0
  fi
  if [[ "$status" == *"Status: active"* ]]; then
    say "ufw is already on. Setup adds a rate-limited rule for SSH port(s) $SSH_PORTS and changes nothing else."
    for port in $SSH_PORTS; do
      run ufw limit "$port/tcp" comment "SSH, kept open by gmat-llm"
      record_installed "ufw:limit $port/tcp"
    done
    return 0
  fi
  warn_network_listeners
  say "Setup can turn on the firewall with these rules:"
  for port in $SSH_PORTS; do info "ufw limit $port/tcp: SSH, refusing an address that opens 6 or more connections within 30 seconds"; done
  info "ufw default deny incoming, ufw default allow outgoing"
  info "mDNS (UDP 5353 to 224.0.0.251) stays allowed by ufw's default rules, so $(hostname).local keeps working."
  if ! confirm "Turn on the firewall with these rules?" y; then
    FIREWALL_SKIPPED=1
    say "The firewall stays off."
    return 0
  fi
  for port in $SSH_PORTS; do
    run ufw limit "$port/tcp" comment "SSH, kept open by gmat-llm"
    record_installed "ufw:limit $port/tcp"
  done
  run ufw default deny incoming
  run ufw default allow outgoing
  # Open connections, this SSH session included, stay up when ufw starts.
  run ufw --force enable
  record_installed "ufw:enabled"
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

# The curl option that carries the API key, for --config: read from a pipe,
# so the key never shows in a command line that ps would list.
curl_key_config() {
  printf 'header = "Authorization: Bearer %s"\n' "$(api_key)"
}

# Sends a request through llama-swap and prints the reply body; fails on an
# HTTP error.
endpoint_post() {
  local path=$1 body=$2 timeout=${3:-900} out code
  out=$(mktemp)
  code=$(curl --noproxy '*' -sS -o "$out" -w '%{http_code}' --max-time "$timeout" --config <(curl_key_config) -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:$PORT$path" <<<"$body" || true)
  if [[ "$code" != 200 ]]; then
    printf 'HTTP %s: %s\n' "${code:-none}" "$(head -c 400 "$out")" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

endpoint_get() {
  local path=$1
  curl --noproxy '*' -fsS --max-time 60 --config <(curl_key_config) "http://127.0.0.1:$PORT$path"
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

# Whether the log shows the model ran out of VRAM or RAM. systemd reports a
# kill by the cgroup's memory limit as "killed by the OOM killer", and
# records oom-kill as the unit's result.
ran_out_of_memory() {
  grep -qiE 'out of memory|cudaMalloc failed|failed to allocate|unable to allocate|OOM killer|oom-kill' <<<"$1" && return 0
  [[ "$(systemctl show -p Result --value "$SERVICE_NAME" 2>/dev/null || true)" == oom-kill ]]
}

# A long prompt like a book page and a reply about as long as extraction
# writes, to see whether such a request finishes within the app's 180 s.
long_request() {
  python3 -I -c '
import json, sys
page = " ".join("Paragraph %d. The committee reviewed the proposal and noted that revenue grew by %d percent while costs rose by %d percent over the same period." % (i, 3 + i % 7, 2 + i % 5) for i in range(60))
schema = {"type": "object", "properties": {"sentences": {"type": "array", "items": {"type": "string"}}},
          "required": ["sentences"], "additionalProperties": False}
body = {"model": sys.argv[1], "max_tokens": 1500,
        "messages": [{"role": "system", "content": "Reply with JSON only."},
                     {"role": "user", "content": "Copy every sentence of this page, word for word, into the list.\n\n" + page}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "page", "strict": True, "schema": schema}}}
print(json.dumps(body))
' "$1"
}

# Prompt and reply speeds of a reply, and their counts.
reply_timings() {
  python3 -I -c '
import json, sys
reply = json.load(sys.stdin)
t = reply.get("timings") or {}
print("%.1f\t%.1f\t%d\t%d" % (t.get("prompt_per_second") or 0, t.get("predicted_per_second") or 0, t.get("prompt_n") or 0, t.get("predicted_n") or 0))
'
}

# Times one request to the 35B-A3B after unloading every model (a cold load,
# as after a swap) and one right after (warm), then a long one.
test_reason_speed() {
  local id=$1 started cold warm reply pps tps pn tn projected
  endpoint_get /unload >/dev/null || true
  started=$(date +%s)
  if ! endpoint_post /v1/chat/completions "$(chat_request "$id" text)" 900 >/dev/null; then
    return 1
  fi
  cold=$(($(date +%s) - started))
  started=$(date +%s)
  endpoint_post /v1/chat/completions "$(chat_request "$id" text)" 300 >/dev/null || return 1
  warm=$(($(date +%s) - started))
  info "load: a first request took $cold s from cold (as after a model swap), the next $warm s"
  started=$(date +%s)
  if reply=$(endpoint_post /v1/chat/completions "$(long_request "$id")" 900); then
    IFS=$'\t' read -r pps tps pn tn <<<"$(reply_timings <<<"$reply")"
    info "long reply: $tn tokens in $(($(date +%s) - started)) s (prompt of $pn tokens at $pps tokens/s, reply at $tps tokens/s)"
    projected=$(awk -v pn="$pn" -v pps="$pps" -v tps="$tps" 'BEGIN { if (pps > 0 && tps > 0) printf "%d", 2500 / pps + 2000 / tps; else print 0 }')
    if ((projected > 150)); then
      warn "At these speeds a 2,000-token extraction reply to a 2,500-token page takes about $projected s, near or past the app's 180 s per request. Keep long tasks on the cloud, or expect extraction jobs to time out and retry."
    else
      info "A 2,000-token reply to a 2,500-token page would take about $projected s (the app allows 180 s)."
    fi
  else
    warn "$id did not finish a long reply."
    return 1
  fi
}

test_one_model() {
  local key=$1 id reply summary content pps tps failures=0 started log
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
  if [[ "$key" == ocr ]] || [[ "$key" == reason && "$VISION" == on ]]; then
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
      log=$(journal_since "$started")
      if ran_out_of_memory "$log"; then
        warn "$id ran out of memory reading an image."
        return 2
      fi
      warn "$id did not answer a vision request."
      failures=$((failures + 1))
    fi
  fi
  if [[ "$key" == reason ]]; then
    if ! test_reason_speed "$id"; then
      log=$(journal_since "$started")
      if ran_out_of_memory "$log"; then
        warn "$id ran out of memory."
        return 2
      fi
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

# Moves the experts of three more layers to system RAM: the ones just below
# those already there, as llama-fit-params counts from the last layer.
more_experts_in_ram() {
  local layers=$1 lowest next added=0
  if [[ -z "$layers" ]]; then
    lowest=$REASON_LAYERS
  else
    lowest=$(tr ',' '\n' <<<"$layers" | sort -n | head -n 1)
  fi
  next=$((lowest - 1))
  while ((added < 3 && next >= 0)); do
    layers="${next}${layers:+,$layers}"
    next=$((next - 1))
    added=$((added + 1))
  done
  printf '%s' "$layers"
}

run_health_checks() {
  local key result failed=0 attempt
  if ((DRY_RUN)); then
    printf '[dry-run] would send a chat request and a response_format json_schema request to each model through llama-swap, time a cold and a warm load and a long reply of the 35B-A3B, read a test image with the models that read images, and report tokens per second and memory use\n'
    return 0
  fi
  test_api_key_enforced || failed=1
  for key in $(profile_models); do
    attempt=1
    while true; do
      result=0
      test_one_model "$key" || result=$?
      if ((result == 2)) && [[ "$key" == reason ]] && ((attempt <= 3)) && [[ "$SAVED_CPU_LAYERS" != auto ]] && [[ -z "$SAVED_N_CPU_MOE" ]]; then
        if (($(expert_layer_count "$SAVED_CPU_LAYERS") < REASON_LAYERS)); then
          SAVED_CPU_LAYERS=$(more_experts_in_ram "$SAVED_CPU_LAYERS")
          say "Keeping the experts of $(expert_layer_count "$SAVED_CPU_LAYERS") layers in system RAM and trying again."
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
        warn "The 35B-A3B model does not fit. Run setup again with --quant UD-Q2_K_XL."
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
  ip_list=${ip_list% }
  say "The endpoint: http://127.0.0.1:$PORT/v1 on this computer only (llama-swap, OpenAI-compatible)."
  say "Models and the app tasks they serve:"
  for key in $(profile_models); do info "$(model_id "$key"): $(model_tasks "$key")"; done
  say "Generation, approaches and lessons stay on your cloud model (see docs/local-llm.md)."
  say ""
  say "This computer: $(hostname) ($(hostname).local), addresses ${ip_list:-none}, SSH port(s) ${SSH_PORTS:-unknown}"
  if ((FIREWALL_SKIPPED)); then say "The firewall was not turned on; see step 6 for the commands to do it yourself."; fi
  say "SSH host key (ED25519): $(host_key_fingerprint)"
  if [[ -n "$API_KEY_NEW" ]]; then
    say ""
    if ((HAVE_TTY)); then
      say "The API key, shown on the terminal only, not in the log (later: sudo gmat-llm show-api-key):"
      to_tty "  $API_KEY_NEW"
    else
      say "An API key was made. Show it with: sudo gmat-llm show-api-key (it is not written to this log)."
    fi
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
  if [[ -n "$BACKUP_DIR" ]] && ((!DRY_RUN)); then say "Backups of changed files: $BACKUP_DIR"; fi
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
  local models running
  models=$(curl --noproxy '*' -s --max-time 5 --config <(curl_key_config) "http://127.0.0.1:$PORT/v1/models" | python3 -I -c 'import json, sys; print(" ".join(m["id"] for m in json.load(sys.stdin)["data"]))' 2>/dev/null || true)
  running=$(curl --noproxy '*' -s --max-time 5 --config <(curl_key_config) "http://127.0.0.1:$PORT/running" | python3 -I -c 'import json, sys
data = json.load(sys.stdin)
items = data.get("running", data) if isinstance(data, dict) else data
print(" ".join("%s (%s)" % (r.get("model"), r.get("state")) for r in items))' 2>/dev/null || true)
  say "Models: ${models:-unknown}"
  say "Loaded now: ${running:-none}"
  say "Memory: $(model_memory_report)"
  local experts="not measured yet"
  if [[ "$SAVED_N_CPU_MOE" =~ ^[0-9]+$ ]]; then experts="the first $SAVED_N_CPU_MOE layers (--n-cpu-moe)"; elif [[ "$SAVED_CPU_LAYERS" != auto ]]; then experts="$(expert_layer_count "$SAVED_CPU_LAYERS") of $REASON_LAYERS layers"; fi
  say "Profile $PROFILE, 35B-A3B quantization $REASON_QUANT, experts in RAM: $experts, vision $VISION, reasoning $REASONING"
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
  elif [[ -t 0 ]]; then
    # Not echoed, so the key does not stay on the screen.
    printf 'Paste the cloud API key, then press Enter: ' >&2
    IFS= read -rs key || true
    printf '\n' >&2
  else
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
# The base-name pattern of a model's files with the saved choices: the saved
# quantization for the 35B-A3B, so a second quantization left in the folder
# is never picked up.
model_file_regex() {
  case "$1" in
    fast) printf '%s' "^${FAST_PREFIX//./\\.}-${FAST_QUANT}(-[0-9]{5}-of-[0-9]{5})?\\.gguf$" ;;
    reason) printf '%s' "^${REASON_PREFIX//./\\.}-${REASON_QUANT}(-[0-9]{5}-of-[0-9]{5})?\\.gguf$" ;;
    ocr) printf '%s' "$OCR_MODEL_REGEX" ;;
    embed) printf '%s' "$EMBED_MODEL_REGEX" ;;
  esac
}

model_mmproj_regex() {
  case "$1" in
    reason) if [[ "$VISION" == on ]]; then printf '%s' "$REASON_MMPROJ_REGEX"; fi ;;
    ocr) printf '%s' "$OCR_MMPROJ_REGEX" ;;
  esac
}

# Rebuilds the model plan from the files setup downloaded and the saved
# choices, for commands run after setup.
load_model_plan_from_disk() {
  MODEL_PLAN=""
  local key id f name regex mmproj_regex
  for key in $(profile_models); do
    id=$(model_id "$key")
    regex=$(model_file_regex "$key")
    mmproj_regex=$(model_mmproj_regex "$key")
    for f in "$MODELS_DIR/$id"/*.gguf; do
      name=$(basename "$f")
      if [[ "$name" =~ $regex ]]; then
        MODEL_PLAN+="$id"$'\tmodel\t-\t-\t'"$name"$'\t0\t\n'
      elif [[ -n "$mmproj_regex" && "$name" =~ $mmproj_regex ]]; then
        MODEL_PLAN+="$id"$'\tmmproj\t-\t-\t'"$name"$'\t0\t\n'
      fi
    done
    [[ -n "$(model_file "$id" model)" ]] || die "The $key model's file for the saved choices is missing from $MODELS_DIR/$id; run the setup again."
  done
}

# Rewrites the llama-swap config from the saved setup choices and restarts
# the service.
swap_config_from_saved() {
  load_model_plan_from_disk
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

# Takes the tunnel user's rules out of the SSH server config under ROOT.
change_remove_tunnel_rules() {
  local root=$1
  rm -f "$root/sshd_config.d/${SSHD_DROPIN##*/}"
  drop_sshd_block "$root/sshd_config"
}

change_remove_reset_dropin() {
  rm -f "$1/sshd_config.d/${SSHD_RESET_DROPIN##*/}"
}

# Removes packages setup installed, after apt shows what would go: when apt
# would also remove a package setup did not install, it asks first.
remove_recorded_packages() {
  local pkgs=$1 plan extra p
  # shellcheck disable=SC2086 # package names, one word each
  plan=$(apt-get -s remove $pkgs 2>/dev/null | awk '$1 == "Remv" {print $2}' || true)
  extra=""
  for p in $plan; do
    grep -qxF "apt:$p" "$STATE_RECORD" 2>/dev/null || extra+="$p "
  done
  if [[ -n "$extra" ]]; then
    warn "Removing them would also remove packages setup did not install: $extra"
    confirm "Remove those as well?" n || {
      info "The packages stay installed."
      return 0
    }
  fi
  # shellcheck disable=SC2086 # package names, one word each
  DEBIAN_FRONTEND=noninteractive apt-get remove -y $pkgs || warn "apt-get remove failed; the packages may still be installed."
}

cmd_uninstall() {
  require_root
  require_installed
  local models_bytes cuda_pkgs="" keep_cuda=1
  say "This removes the GMAT prep LLM server: the service, llama.cpp, llama-swap, the config and keys, the tunnel user and its SSH rules."
  confirm "Go on?" n || exit 0
  systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$SERVICE_FILE"
  systemctl daemon-reload
  INVOKING_USER="${SUDO_USER:-}"
  # The session's address is one of those the change is checked for.
  detect_ssh_session
  SSHD_CHANGED=0
  if [[ -f "$SSHD_DROPIN" ]] || grep -qxF "$SSHD_BLOCK_BEGIN" /etc/ssh/sshd_config 2>/dev/null; then
    if ! sshd_apply change_remove_tunnel_rules "removing the tunnel rules"; then
      warn "The tunnel rules stay in place; remove $SSHD_DROPIN, or the marked block at the end of /etc/ssh/sshd_config, by hand."
    fi
  elif grep -rqsE "^[[:space:]]*Match[[:space:]]+User[[:space:]]+$TUNNEL_USER\$" /etc/ssh/sshd_config /etc/ssh/sshd_config.d; then
    info "The SSH server config has rules for $TUNNEL_USER that setup did not write; remove them yourself if you like."
  fi
  if [[ -f "$SSHD_RESET_DROPIN" ]] && confirm "Remove $SSHD_RESET_DROPIN too? (it turned off GatewayPorts or PermitTunnel that an old setup had turned on)" n; then
    sshd_apply change_remove_reset_dropin "removing the reset drop-in" || warn "$SSHD_RESET_DROPIN stays."
  fi
  if ((SSHD_CHANGED)); then reload_sshd; fi
  if getent passwd "$TUNNEL_USER" >/dev/null 2>&1; then userdel "$TUNNEL_USER" 2>/dev/null || true; fi
  if getent group "$TUNNEL_USER" >/dev/null 2>&1; then groupdel "$TUNNEL_USER" 2>/dev/null || true; fi
  if [[ -d "$MODELS_DIR" ]]; then
    models_bytes=$(dir_size_bytes "$MODELS_DIR")
    if confirm "Delete the downloaded models ($(human_bytes "$models_bytes"))?" y; then rm -rf --one-file-system "$STATE_DIR"; fi
  fi
  if [[ -f "$STATE_RECORD" ]]; then
    if grep -qxF "file:$LOGIND_DROPIN" "$STATE_RECORD"; then rm -f "$LOGIND_DROPIN"; fi
    if grep -qxF "masked-sleep" "$STATE_RECORD"; then systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target || true; fi
    # The packages the CUDA install brought in, as recorded then.
    cuda_pkgs=$(grep -E '^apt:' "$STATE_RECORD" | sed 's/^apt://' | grep -E '^(cuda-|libcublas|libnvjitlink|libnvptxcompiler|libcufft|libcurand|libcusolver|libcusparse|libnpp|nsight)' | tr '\n' ' ' || true)
    if [[ -n "${cuda_pkgs// /}" ]] && confirm "Remove the CUDA toolkit packages setup installed ($cuda_pkgs)?" n; then
      remove_recorded_packages "$cuda_pkgs"
      if ! pkg_installed cuda-keyring; then keep_cuda=0; fi
    fi
    # The driver pin goes only with NVIDIA's repository: while the repository
    # is there, the pin keeps apt from taking the driver from it.
    if grep -qxF "file:$APT_PIN_FILE" "$STATE_RECORD"; then
      if ((keep_cuda == 0)) || ! pkg_installed cuda-keyring; then
        rm -f "$APT_PIN_FILE"
        info "Removed the driver pin $APT_PIN_FILE, as NVIDIA's repository is gone."
      else
        info "$APT_PIN_FILE stays while NVIDIA's repository (cuda-keyring) is installed."
      fi
    fi
  fi
  if getent passwd "$SERVICE_USER" >/dev/null 2>&1; then userdel "$SERVICE_USER" 2>/dev/null || true; fi
  if getent group "$SERVICE_USER" >/dev/null 2>&1; then groupdel "$SERVICE_USER" 2>/dev/null || true; fi
  say "The firewall stays as it is, with SSH open. To turn it off: sudo ufw disable"
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
      --profile | --port | --quant | --n-cpu-moe | --ctx-fast | --ctx-reason | --reasoning | --jobs | --vision)
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
          --vision) VISION=$2 ;;
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
      --delete-old-models)
        DELETE_OLD_MODELS=1
        shift
        ;;
      --delete-old-envs)
        DELETE_OLD_ENVS=1
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
  case "$VISION" in on | off) ;; *) die "--vision must be on or off." ;; esac
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
  say "gmat-llm setup $GMAT_LLM_SCRIPT_VERSION, $(date -R)$( ((DRY_RUN)) && printf ', dry run: changes are shown, not made')"
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
  trap on_hangup HUP
  preflight
  cleanup_old_setup
  if ((NO_DRIVER)); then
    say ""
    say "The dry run stops here: steps 3 to 8 need a working NVIDIA driver. The real run installs it first; reboot after that and run setup again."
    exit 0
  fi
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
