# Local LLM server

GMAT prep can send most of its LLM tasks to models on a laptop next to your Mac, instead of a cloud API. Two scripts set this up:

- `scripts/local-llm/setup-llm-server.sh` sets up the laptop. It needs Ubuntu Server 22.04 or 24.04 and an NVIDIA GPU. It was written for an RTX 2060 with 6 GB of VRAM and 16 GB of RAM.
- `scripts/local-llm/start-gmat-prep-mac.sh` runs on the Mac. It opens a tunnel to the laptop, starts the app and points the app's LLM settings at the laptop.

Both machines are expected on the same network, such as an iPhone hotspot, where addresses change from day to day.

## What runs where

```
Mac                                         Laptop (Ubuntu, RTX 2060)
GMAT prep app                               llama-swap on 127.0.0.1:18100
  API address http://127.0.0.1:18100/v1       starts one llama-server at a time:
  |                                             qwen3.5-4b or qwen3.6-35b-a3b
  +-- SSH tunnel as user gmat-tunnel ------>  passes cloud model requests on to
                                              your cloud API (optional)
```

- The laptop runs llama-swap, an OpenAI-compatible proxy, on 127.0.0.1:18100. When a request names a model, llama-swap starts llama.cpp's `llama-server` for that model and stops the one that ran before. A model also stops after 30 minutes without requests.
- Setup builds llama.cpp on the laptop with CUDA for the RTX 2060 (compute capability 7.5).
- The Mac runs the app as usual. The app's API address is the Mac end of the SSH tunnel, `http://127.0.0.1:18100/v1`, and its API key is the laptop's key.
- Nothing on the laptop accepts LLM requests from the network. Requests arrive through the tunnel only.

## Models

| Name in the app | Model | Files | Download | Where it runs | App tasks |
|---|---|---|---|---|---|
| `qwen3.5-4b` | Qwen3.5 4B | `Qwen3.5-4B-Q4_K_M.gguf` | 2.74 GB | all on the GPU, 16K context | tagging, statement-translation, tutor-chat |
| `qwen3.6-35b-a3b` | Qwen3.6 35B-A3B | `Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf`, `mmproj-F16.gguf` | 16.85 GB, 0.90 GB | GPU, with the experts of some layers in system RAM; 16K context | solving, book-map, extraction; reads images |
| `ocr` | GLM-OCR | `GLM-OCR-Q8_0.gguf`, `mmproj-GLM-OCR-Q8_0.gguf` | 0.95 GB, 0.48 GB | GPU | none yet |
| `embed` | Qwen3 Embedding 0.6B | `Qwen3-Embedding-0.6B-Q8_0.gguf` | 0.64 GB | GPU | none yet |

Sizes are decimal gigabytes from the Hugging Face file listings, at the revisions setup pins.

- Profiles. `--profile minimal` installs the 4B model only. `standard`, the default, adds the 35B-A3B. `full` adds OCR and embeddings, which the app does not use yet.
- The 35B-A3B is a mixture-of-experts model: about 3B of its 35B parameters work on each token. Its experts can stay in system RAM while the rest runs on the GPU, which is how a 17 GB model runs with 6 GB of VRAM. Setup measures the free VRAM with llama.cpp's `llama-fit-params` and writes the number of layers whose experts stay in RAM (`--n-cpu-moe`) into the config. It leaves room on the GPU for the vision projector and the context. If the first test runs out of memory, setup moves the experts of 3 more layers to RAM and tries again, up to three times.
- If 16 GB of RAM is too little, `--quant UD-Q2_K_XL` uses the 12.29 GB file instead.
- The weights are memory-mapped (`--load-mode mmap`), not locked in RAM. Under memory pressure the kernel can drop expert pages and read them again. That is slow, but the model keeps running.
- Thinking is off (`--reasoning off`). Thinking makes replies several times longer, and the app gives each request 180 seconds. `--reasoning on` turns it on.
- Sampling follows Qwen's advice for answers without thinking: temperature 0.7, top-p 0.8, top-k 20, min-p 0. Qwen also advises a presence penalty of 1.5. It is left at 0, because a penalty on repeated words works against extraction, which must copy text exactly.
- One model is loaded at a time. When the app moves from a 4B task to a 35B-A3B task, llama-swap loads the other model first. Loading the 35B-A3B reads about 17 GB from disk.
- Speed was not measured on the RTX 2060. As a rough guide, one published test of this model on a GTX 1650 with 4 GB of VRAM, with the experts in RAM, reports about 20 tokens per second for the reply and 66 tokens per second for reading the prompt.

## Why generation, approaches and lessons stay on the cloud

- These tasks write what you study: new questions with their explanations, solution approaches and lessons. A wrong question or a wrong explanation teaches the wrong thing, so these tasks get the strongest model you can use. A 3-bit 35B-A3B on a laptop is well behind the best cloud models at long, careful writing.
- Their replies are long. At about 20 tokens per second, a 2,000-token lesson takes over a minute and a half once the prompt is read. That is close to the app's limit of 180 seconds per request, and the app does not cap the length of a reply.
- The local models do the tasks with shorter replies that the app checks against a schema: tagging, translating statements, tutor chat, solving, and reading book pages.
- If you want no cloud at all, `--all-local` sends these three tasks to the 35B-A3B as well.

The app has one API address and one API key. So that the cloud tasks keep working, their requests go through the tunnel too, and llama-swap passes them on to your cloud API with your cloud key. The Mac script sets this up on its first run when the app already uses a cloud API (it runs `sudo gmat-llm set-cloud` on the laptop over your SSH login). The cloud key is then kept on the laptop in `/etc/gmat-llm/cloud.env`, which only root can read.

## Security design

The laptop accepts LLM requests from itself only. The Mac gets in through SSH, with a key that can do one thing.

- llama-swap listens on 127.0.0.1:18100. Each `llama-server` listens on 127.0.0.1, on a port from 18101 up.
- The tunnel uses its own user, `gmat-tunnel`, with no password and no shell. The file `/etc/ssh/sshd_config.d/60-gmat-llm.conf` sets these rules for that user and no other:
  - public key login only, with the keys in `/etc/gmat-llm/ssh/authorized_keys`;
  - local forwarding to 127.0.0.1:18100 and nowhere else (`AllowTcpForwarding local`, `PermitOpen 127.0.0.1:18100`, `PermitListen none`);
  - no terminal, no agent or X11 forwarding, no tunnel devices;
  - any command is replaced by `/usr/sbin/nologin`.
- Each key line repeats the limit with `restrict,port-forwarding,permitopen="127.0.0.1:18100"`.
- These rules were tested against the OpenSSH servers of Ubuntu 24.04 (OpenSSH 9.6) and Ubuntu 22.04 (OpenSSH 8.9). The tunnel works. Forwards to other ports, remote forwards, SOCKS forwards to other addresses, commands, shells and other keys are refused.
- The Mac's tunnel key, `~/.ssh/gmat_llm_ed25519`, has no passphrase, so the script can open the tunnel without asking. The key can only open this tunnel, so a copy of it gives no shell on the laptop. Take a key back on the laptop with `sudo gmat-llm remove-client`.
- On the first run the Mac shows the laptop's SSH host key fingerprint. You compare it with the one setup printed. The Mac pins that key in `~/.config/gmat-prep/llm-server-known_hosts` and checks it on every connection. A machine that answers with another key is never used, even when the Mac scans the hotspot to find the laptop.
- llama-swap also asks for an API key, as a second barrier. It refuses requests without `Authorization: Bearer <key>`, except `/health`. The key is random: `gmat-` and 40 letters and digits. It is kept in `/etc/gmat-llm/llama-swap.env` on the laptop (root only), in `~/.config/gmat-prep/llm-api-key` on the Mac (you only), and in the app's API key file. `llama-server` itself does not check the key, so a program on the laptop could reach a model that is loaded.
- The firewall, ufw, refuses incoming connections except SSH. SSH is rate-limited: ufw refuses an address that opens 6 or more connections within 30 seconds. The Mac script spaces out its own connections to stay below that.
- mDNS stays open through ufw's default rules, so `<laptop name>.local` keeps working. Before it turns the firewall on, setup lists other programs that accept connections from the network. The firewall blocks them unless you allow them with `sudo ufw allow PORT/tcp`.
- The endpoint runs as the system user `gmat-llm` under systemd, with `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome` and `PrivateTmp`. Its memory limit is 1 GiB below the laptop's RAM, so a model that runs out of memory is stopped before SSH stops answering.
- Setup never stops sshd and never closes SSH sessions. It reloads sshd only after `sshd -t` accepts the new config, so you can run setup over SSH.
- Downloads are pinned and checked: llama.cpp at tag b11400 (commit 0bb496d), llama-swap v265 by SHA-256, NVIDIA's `cuda-keyring` packages by SHA-256, and the models at fixed Hugging Face revisions by the SHA-256 that Hugging Face lists.

## What the scripts change and how to undo it

### On the laptop

Setup asks before each change. It copies files to `/var/backups/gmat-llm/<time>/` before it edits them, and lists what it installed in `/etc/gmat-llm/installed.list`. `sudo gmat-llm uninstall` undoes most of it (see [Uninstall](#uninstall)).

| What setup does | How to undo it |
|---|---|
| Removes earlier local LLM setups, one group at a time, after showing each item and its size: services, Docker or Podman containers with their images and volumes, processes on LLM ports, Ollama, model caches, other folders of `.gguf` files, old llama.cpp builds, Python environments with LLM software, SSH tunnels and the services that start them, SSH forwarding lines, sshd forwarding drop-ins and ufw rules for LLM ports. Anything it cannot identify as LLM software is left alone, or offered with no as the default answer. | Deleted models and folders are gone. Edited config files and unit files are in the backup folder. |
| Installs the packages it needs that are missing: `build-essential`, `cmake`, `ninja-build`, `git`, `curl`, `ca-certificates`, `pkg-config`, `libssl-dev`, `python3`, `avahi-daemon`, `ufw`, `pciutils`, `openssh-server`. | `sudo apt remove` the ones you do not want. Uninstall leaves them. |
| If no NVIDIA driver is installed, offers Ubuntu's driver (`ubuntu-drivers install --gpgpu` and the matching `nvidia-utils-<version>-server`), then stops so you can reboot. | `sudo apt remove` the driver packages. |
| Installs CUDA 12.8 from NVIDIA's repository, through NVIDIA's `cuda-keyring` package: `cuda-nvcc-12-8`, `cuda-cudart-dev-12-8`, `libcublas-dev-12-8`, `cuda-driver-dev-12-8` and `cuda-cccl-12-8`, about 1 GB. Older entries for that repository are renamed `*.disabled-by-gmat-llm`. An apt pin, `/etc/apt/preferences.d/gmat-llm-nvidia-driver`, keeps apt from taking the driver from NVIDIA's repository. | Uninstall removes the pin and offers to remove the CUDA packages. Rename a `.disabled-by-gmat-llm` file back, or delete the `# disabled by gmat-llm setup:` prefix in `/etc/apt/sources.list`, to restore an old entry. |
| Builds llama.cpp in `/opt/gmat-llm/llama.cpp`, installs llama-swap in `/opt/gmat-llm/llama-swap`, and copies itself to `/opt/gmat-llm/bin/gmat-llm`, linked from `/usr/local/bin/gmat-llm`. | Uninstall. |
| Downloads the models to `/var/lib/gmat-llm/models`. | Uninstall asks whether to delete them. |
| Writes `/etc/gmat-llm` (settings, the API key, the tunnel keys) and `/etc/systemd/system/gmat-llm.service`, and adds the system users `gmat-llm` and `gmat-tunnel`. Logs go to `/var/log/gmat-llm`. | Uninstall. It leaves the logs. |
| Adds `/etc/ssh/sshd_config.d/60-gmat-llm.conf`. If `sshd_config` does not read that folder, it adds an `Include` line at the top. If an earlier setup turned on `GatewayPorts` or `PermitTunnel`, it offers `/etc/ssh/sshd_config.d/00-gmat-llm-reset.conf`, which turns them off. | Uninstall removes the first file and asks about the second. The old `sshd_config` is in the backup folder. |
| Turns on ufw: incoming connections refused, outgoing allowed, SSH allowed with rate limiting. | `sudo ufw disable`, or `sudo ufw delete limit 22/tcp` for the SSH rule. |
| With `--keep-awake`: writes `/etc/systemd/logind.conf.d/60-gmat-llm-lid.conf` and masks the sleep targets, so closing the lid does nothing. | Uninstall. |

### On the Mac

| What the script does | How to undo it |
|---|---|
| Stops SSH processes that forward ports LLM tools use, after asking. It shows other SSH tunnels and leaves them running unless you say otherwise. | Start them again yourself. |
| Stops LaunchAgents that run ssh, after asking, and moves their files to `~/.config/gmat-prep/backup/<time>/`. | Move the file back to `~/Library/LaunchAgents` and log in again. |
| Comments out `LocalForward`, `RemoteForward` and `DynamicForward` lines in `~/.ssh/config` and `~/.ssh/config.d/*`, after asking. Lines on LLM ports default to yes, other lines to no. The file is first copied to `config.backup-<time>` next to it. | Copy the backup back, or delete the `# disabled by start-gmat-prep-mac.sh:` prefix. |
| Makes the tunnel key `~/.ssh/gmat_llm_ed25519`, and keeps its settings, the pinned host key and the laptop's API key in `~/.config/gmat-prep/`. Logs go to `~/Library/Logs/gmat-prep/`. | Delete them. |
| Sets the app's LLM settings: the API address, the API key, the models of the local tasks, a price of 0 for the local models, and which models read images. The cloud tasks keep their model. The settings from before are saved in `~/.config/gmat-prep/backup/app-llm-settings-<time>.json`. The app's earlier API key is replaced and not kept anywhere on the Mac. | In Curator tools, under Settings, enter the earlier values from that file and your cloud API key. |
| If Bun is missing, installs Bun 1.4.2 with Bun's official installer, after asking. | Delete `~/.bun` and the lines the installer added to your shell's startup file. |

## First-time setup

### 1. The laptop

1. Install Ubuntu Server 22.04 or 24.04 and join the hotspot. `ip -4 addr` on the laptop shows its address.
2. Copy the script to the laptop and run it there, at the laptop or over SSH. Ubuntu Server's installer offers to install OpenSSH; without it, copy the script on a USB stick.

   ```sh
   scp scripts/local-llm/setup-llm-server.sh you@LAPTOP-ADDRESS:
   ssh you@LAPTOP-ADDRESS
   sudo bash setup-llm-server.sh --dry-run   # prints every change, makes none
   sudo bash setup-llm-server.sh
   ```

3. Setup works through eight steps: checks, cleanup of earlier setups, installs, model downloads, the llama-swap config and service, tunnel access and firewall, health checks, and a summary. It asks before each change, and shows each download's size before it starts. Downloads resume where they stopped: if the connection drops, run setup again.
4. If the laptop has no NVIDIA driver, setup installs Ubuntu's driver and stops. Reboot, then run setup again.
5. At the end setup prints the laptop's name, its addresses, its SSH host key fingerprint and, on the first run, the API key. Keep this at hand for the Mac. Later, `sudo gmat-llm status` shows the fingerprint and `sudo gmat-llm show-api-key` shows the key.

Useful options: `--profile minimal|standard|full`, `--quant UD-Q2_K_XL` for less memory, `--keep-awake` to keep the laptop running with the lid closed, `--yes` to take the default answer to every question, and `--help` for the rest.

### 2. The Mac

1. In the gmat-prep repo, run `scripts/local-llm/start-gmat-prep-mac.sh`.
2. It checks Bun, installs the app's dependencies and builds the web app when needed.
3. It offers to stop old SSH tunnels and forwarding (see the table above).
4. It asks for the laptop's name as setup printed it, finds the laptop and shows its SSH host key fingerprint. Answer yes only if it matches what setup printed.
5. It asks for your own SSH login on the laptop. With it, the script installs the Mac's tunnel key and reads the API key over SSH; `sudo` on the laptop asks for your password. Without a login, it prints two commands to run on the laptop and asks you to paste the key they show.
6. It opens the tunnel, starts the app, sets the app's LLM settings, runs the app's own connection test and opens the app in your browser.
7. If the app has no Curator passphrase yet, the script asks you to choose one. If it has one, the script asks for it.
8. If the app already uses a cloud API, the script keeps generation, approaches and lessons there and asks to keep the cloud key on the laptop for them. If the app has no cloud API yet, either use `--all-local`, or choose models for those three tasks in Settings and then run the script with `--reconfigure --cloud-base-url https://.../v1`; it asks for the cloud key.

## Everyday use

- Run `scripts/local-llm/start-gmat-prep-mac.sh`. It finds the laptop even if its address changed, opens the tunnel, starts the app and opens the browser. Ctrl+C stops the app and the tunnel.
- If the tunnel drops, for example because the laptop slept, the app keeps running and the script reconnects when it finds the laptop again, trying every 30 seconds. A job whose request failed meanwhile pauses and resumes on its own after five minutes.
- `--stop` stops an app and tunnel that an earlier run left running, for example after its Terminal window closed.
- `--configure-only` sets the LLM settings of an app you started another way, such as `bun dev`. `--reconfigure` sets them again on a normal start.
- The first request after a model switch waits while the model loads.

On the laptop:

| Command | What it does |
|---|---|
| `sudo gmat-llm status` | service, models, memory, tunnel keys, host key fingerprint, firewall |
| `sudo gmat-llm test` | asks every model for a reply and for JSON that follows a schema, and the models that read images for the number in a test image; reports speed and memory use |
| `sudo gmat-llm logs -f` | follows the endpoint's log |
| `sudo gmat-llm restart` | restarts the endpoint |
| `sudo gmat-llm add-client 'ssh-ed25519 AAAA...'` | allows another Mac's tunnel key |
| `sudo gmat-llm remove-client [match]` | lists tunnel keys, or removes those that match |
| `sudo gmat-llm set-cloud --base-url https://.../v1 --models a,b` | sends those models on to a cloud API; reads the key from standard input |
| `sudo gmat-llm clear-cloud` | stops sending models on to the cloud API |
| `sudo gmat-llm show-api-key` | prints the endpoint's API key |
| `sudo gmat-llm setup [options]` | runs setup again; it keeps what is in place and redoes what changed |

## Data use

On a hotspot, downloads use mobile data. Setup shows each download's size and asks before it starts.

| Download | Size |
|---|---|
| Ubuntu packages | shown by apt before it installs them |
| NVIDIA driver, only if none is installed | shown by apt |
| CUDA 12.8 packages | about 1.03 GB (2.4 GB on disk) |
| llama.cpp source | about 40 MB |
| llama-swap | 22 MB |
| Models, minimal profile | 2.74 GB |
| Models, standard profile | 20.49 GB |
| Models, full profile | 22.56 GB |

After setup, the laptop downloads nothing more unless you run setup again. Traffic between the Mac and the laptop goes through the iPhone over Wi-Fi and not out to the internet. Whether an iPhone counts it as mobile data was not checked.

What goes where:

- Requests of the local tasks, with their question text, book page images and chat messages, go only to the laptop.
- Requests of generation, approaches and lessons go to your cloud API, as before, through the laptop when the cloud route is set.
- Setup downloads from Ubuntu's archive, NVIDIA's repository, GitHub (llama.cpp and llama-swap) and Hugging Face (the models). The Mac script runs `bun install` when the app's dependencies are missing or changed, and downloads Bun only if it is missing and you agree.

## Troubleshooting

- The Mac cannot find the laptop. Check that both are on the same hotspot and that the laptop is awake (setup's `--keep-awake` helps). Pass the address the laptop shows with `ip -4 addr`: `--address 172.20.10.N`. The script also scans the Mac's own network for an SSH server with the pinned host key. If the hotspot keeps devices from reaching each other, the tunnel cannot work.
- "answers with a different host key". The laptop was reinstalled, its SSH host keys changed, or another device now has its old address. Compare with `sudo gmat-llm status` on the laptop, then run the Mac script with `--pair`.
- "Port 18100 on this Mac is in use". Another program has that port. Stop it, or pass `--local-port N`.
- SSH connections are refused for a while. ufw refuses an address that opens 6 or more connections within 30 seconds. Wait 30 seconds and try again.
- "The endpoint refused the API key". Setup made a new key, for example after `/etc/gmat-llm` was removed. Run the Mac script with `--pair`.
- The 35B-A3B does not load or runs out of memory. Look at `sudo gmat-llm logs`. Run setup again with `--quant UD-Q2_K_XL`, with a smaller `--ctx-reason`, or with a higher `--n-cpu-moe N`. Close other programs that use the GPU (`nvidia-smi` lists them).
- A request times out after 180 seconds. Loading the 35B-A3B from a slow disk can take that long, and the job then pauses and tries again after five minutes. Long writing tasks on the 35B-A3B are the other cause; keep them on the cloud.
- Replies fail their JSON check. The local models keep to a reply's shape best with `--json-mode json-schema`. The script keeps the app's JSON mode when the app also uses a cloud API, because some cloud APIs do not accept that mode.
- `apt update` fails with "Conflicting values set for option Signed-By". An older entry for NVIDIA's repository clashes with the `cuda-keyring` one. Let setup turn it off, or remove it.
- Logs: setup writes `/var/log/gmat-llm/setup-<time>.log`. The endpoint logs to the journal (`sudo gmat-llm logs`). On the Mac, the app and tunnel logs are in `~/Library/Logs/gmat-prep/`.

## Uninstall

On the laptop, run `sudo gmat-llm uninstall`. It stops and removes the service, the tunnel user and its SSH rules, llama.cpp, llama-swap, `/etc/gmat-llm` and the `gmat-llm` tool. It asks before deleting the models and before removing the CUDA packages. It leaves the firewall on with SSH open (`sudo ufw disable` turns it off), the Ubuntu packages, the logs in `/var/log/gmat-llm` and the backups in `/var/backups/gmat-llm`.

On the Mac, stop the script with Ctrl+C. Copy the saved settings file from `~/.config/gmat-prep/backup/` somewhere else, then delete `~/.ssh/gmat_llm_ed25519`, `~/.ssh/gmat_llm_ed25519.pub`, `~/.config/gmat-prep/` and `~/Library/Logs/gmat-prep/`. In the app, under Curator tools, Settings, enter your cloud API address, models and API key again.

## Sources

- llama.cpp: [repository](https://github.com/ggml-org/llama.cpp), [build guide at b11400](https://github.com/ggml-org/llama.cpp/blob/b11400/docs/build.md), [llama-server options at b11400](https://github.com/ggml-org/llama.cpp/blob/b11400/tools/server/README.md), [llama-fit-params at b11400](https://github.com/ggml-org/llama.cpp/blob/b11400/tools/fit-params/README.md)
- llama-swap: [v265 release](https://github.com/mostlygeek/llama-swap/releases/tag/v265), [configuration reference](https://github.com/mostlygeek/llama-swap/blob/v265/docs/config.example.yaml), [API keys](https://github.com/mostlygeek/llama-swap/blob/v265/docs/kb/guides/api-integration/api-keys-and-auth.md)
- Models: [Qwen3.5 4B GGUF](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF), [Qwen3.6 35B-A3B GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF), [Qwen3.6 35B-A3B model card](https://huggingface.co/Qwen/Qwen3.6-35B-A3B) (sampling settings), [Unsloth's Qwen3.6 guide](https://unsloth.ai/docs/models/qwen3.6), [GLM-OCR GGUF](https://huggingface.co/ggml-org/GLM-OCR-GGUF), [Qwen3 Embedding 0.6B GGUF](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF)
- Speed on a small GPU: [InsiderLLM, running Qwen3.6 35B-A3B locally](https://insiderllm.com/guides/best-way-run-qwen-3-6-35b-moe-locally/)
- NVIDIA: [CUDA repositories](https://developer.download.nvidia.com/compute/cuda/repos/), [CUDA minor version compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html) (CUDA 12.x needs driver 525 or newer, CUDA 13.x needs 580)
- Ubuntu: [NVIDIA driver installation](https://help.ubuntu.com/community/NvidiaDriversInstallation), [ufw(8)](https://manpages.debian.org/unstable/ufw/ufw.8.en.html)
- OpenSSH: [sshd_config(5)](https://man7.org/linux/man-pages/man5/sshd_config.5.html)
- Ollama on Linux, including its uninstall steps: [docs.ollama.com/linux](https://docs.ollama.com/linux)
- Bun installation: [bun.com/docs/installation](https://bun.com/docs/installation)
- macOS `nc`: [nc(1)](https://www.unix.com/man-page/osx/1/nc/)
