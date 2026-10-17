# Local LLM server

GMAT prep can send most of its LLM tasks to models on a laptop next to your Mac, instead of a cloud API. Two scripts set this up:

- `scripts/local-llm/setup-llm-server.sh` sets up the laptop. It needs Ubuntu Server 22.04 or 24.04 and an NVIDIA GPU. It was written for an RTX 2060 with 6 GB of VRAM and 16 GB of RAM.
- `scripts/local-llm/start-gmat-prep-mac.sh` runs on the Mac. It opens a tunnel to the laptop, starts the app and points the app's LLM settings at the laptop.

Both machines are expected on the same network, such as an iPhone hotspot, where addresses change from day to day.

Neither script has run on the real laptop or on a Mac yet. [Not tested yet](#not-tested-yet) says what was tested and what was not.

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
- No model endpoint on the laptop accepts requests from the network. Requests arrive through the tunnel only.

## Models

| Name in the app | Model | Files | Download | Where it runs | App tasks |
|---|---|---|---|---|---|
| `qwen3.5-4b` | Qwen3.5 4B | `Qwen3.5-4B-Q4_K_M.gguf` | 2.74 GB | all on the GPU, 16K context | tutor-chat (every local task in the minimal profile) |
| `qwen3.6-35b-a3b` | Qwen3.6 35B-A3B | `Qwen3.6-35B-A3B-UD-Q2_K_XL.gguf` with 16 GB of RAM, `Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf` with more; `mmproj-F16.gguf` only with `--vision on` | 12.29 GB or 16.85 GB; 0.90 GB | GPU, with most of its experts in system RAM; 16K context | tagging, statement-translation, solving, book-map, extraction |
| `ocr` | GLM-OCR | `GLM-OCR-Q8_0.gguf`, `mmproj-GLM-OCR-Q8_0.gguf` | 0.95 GB, 0.48 GB | GPU | none yet |
| `embed` | Qwen3 Embedding 0.6B | `Qwen3-Embedding-0.6B-Q8_0.gguf` | 0.64 GB | GPU | none yet |

Sizes are decimal gigabytes from the Hugging Face file listings, at the revisions setup pins.

- Profiles. `--profile minimal` installs the 4B model only. `standard`, the default, adds the 35B-A3B. `full` adds OCR and embeddings, which the app does not use yet.
- One model for a book run. Every local task of a book run goes to the 35B-A3B, so a run loads it once and does not swap models. The 4B serves Tutor Chat. Only one model is loaded at a time, so a chat during a book run waits while the 4B loads, and the book run's next request waits while the 35B-A3B loads again (it reads 12 to 17 GB from disk).
- The 35B-A3B is a mixture-of-experts model: about 3B of its 35B parameters work on each token. Its experts can stay in system RAM while the rest runs on the GPU, which is how a 12 to 17 GB model runs with 6 GB of VRAM. Setup measures the free VRAM with llama.cpp's `llama-fit-params` and writes the list of layers it picks for keeping their experts in RAM into the config, as `--override-tensor`. It keeps 1.5 GiB of VRAM free for the context and the CUDA buffers, plus room for the vision file with `--vision on`. If the first test runs out of memory, setup moves the experts of 3 more layers to RAM and tries again, up to three times. `--n-cpu-moe N` sets the number yourself: the experts of the first N layers stay in RAM.
- No vision. The app sends no images yet, so setup does not download the 35B-A3B's vision file. `--vision on` downloads it (0.90 GB) and lets the model read images; once the app sends images, tick "Reads images" for `qwen3.6-35b-a3b` in Curator tools, Settings.
- The weights are memory-mapped (`--load-mode mmap`), not locked in RAM. Under memory pressure the kernel can drop expert pages and read them again. That is slow, but the model keeps running.
- Thinking is off (`--reasoning off`). Thinking makes replies several times longer, and the app gives each request 180 seconds. `--reasoning on` turns it on.
- Sampling. The app sends no temperature, so the server sets it. The 4B uses Qwen's advice for answers without thinking: temperature 0.7, top-p 0.8, top-k 20, min-p 0. The 35B-A3B uses temperature 0.3 with the same other values, because extraction copies text and the app's three solver prompts already differ. Qwen's suggested presence penalty of 1.5 is left at 0, because a penalty on repeated words works against copying text exactly.

### Memory and speed on 6 GB of VRAM and 16 GB of RAM

The 35B-A3B will be slow on this laptop. With 6 GB of VRAM, almost all of its experts stay in system RAM and run on the CPU.

These are estimates from the file sizes; the laptop has not run the model.

| | UD-Q3_K_XL (3-bit) | UD-Q2_K_XL (2-bit) |
|---|---|---|
| Download | 16.85 GB | 12.29 GB |
| Experts | about 13.3 GiB | about 9.1 GiB |
| On the GPU | attention and shared weights (1.9 GiB), the 16K context (0.3 GiB), CUDA buffers (1 GiB), about 1.3 GiB of experts, 1.5 GiB kept free | the same |
| In RAM: experts, token embeddings (0.5 GiB) and the program (about 1 GiB) | about 13.5 GiB | about 9.3 GiB |
| Room the service has (RAM less 1 GiB) on a 16 GB laptop | about 14.5 GiB | about 14.5 GiB |

The 3-bit file leaves under 1.5 GiB for the page cache and everything else. The kernel would keep dropping expert pages and reading them back from disk, and every reply would crawl. So setup picks the 2-bit file when the 3-bit one does not leave that much room, which is the case with 16 GB. It says so and asks; `--quant UD-Q3_K_XL` keeps the 3-bit file anyway, with a warning. Your choice is saved for later runs.

Speed was not measured on the RTX 2060. As a rough guide, one published test of this model on a GTX 1650 with 4 GB of VRAM, with the experts in RAM, reports about 20 tokens per second for the reply and 66 tokens per second for reading the prompt. Expect something in that range, and less when the disk has to supply experts. At those speeds an extraction request, a 2,500-token book page in and up to 2,000 tokens of JSON out, takes over 2 minutes, and longer if the model runs slower here: near or past the app's 180 seconds per request. `sudo gmat-llm test` times a load from cold, a warm request and a long reply, and warns when a page would come near the limit. If it warns, set extraction in Curator tools, Settings, to the cloud model that generation uses, which the laptop already passes on.

## Why generation, approaches and lessons stay on the cloud

- These tasks write what you study: new questions with their explanations, solution approaches and lessons. A wrong question or a wrong explanation teaches the wrong thing, so these tasks get the strongest model you can use. A 2- or 3-bit 35B-A3B on a laptop is well behind the best cloud models at long, careful writing.
- Their replies are long, and the app does not cap the length of a reply. At 20 tokens per second, a 2,000-token lesson takes over a minute and a half once the prompt is read.
- The local models do the tasks whose replies the app checks against a schema: tagging, translating statements, tutor chat, solving, and reading book pages. Extraction, which copies a whole page out as JSON, also has long replies; see the speed note above.
- If you want no cloud at all, `--all-local` sends these three tasks to the 35B-A3B as well.

The app has one API address and one API key. So that the cloud tasks keep working, their requests go through the tunnel too, and llama-swap passes them on to your cloud API with your cloud key. The Mac script sets this up on its first run when the app already uses a cloud API: it runs `sudo gmat-llm set-cloud` on the laptop over your SSH login. The cloud key is then kept on the laptop in `/etc/gmat-llm/cloud.env`, which only root can read.

- The cloud API's address must start with `https://` and end in `/v1`, because llama-swap adds `/v1/chat/completions` to the part before it. An address like Gemini's `https://generativelanguage.googleapis.com/v1beta/openai/` cannot be passed on. The script stops before changing anything in that case.
- After `set-cloud`, the script checks that the laptop lists every cloud model. If one is missing, for example because you had no SSH login on the laptop and the command was not run, it stops before changing anything, and the app keeps its cloud key.
- Before it gives the app the laptop's key, the script saves the app's earlier key file in `~/.config/gmat-prep/backup/app-credentials-<time>.json`, readable by you only, and says so.

## Security design

The laptop accepts LLM requests from itself only. The Mac gets in through SSH, with a key that can do one thing.

- llama-swap listens on 127.0.0.1:18100. Each `llama-server` listens on 127.0.0.1, on a port from 18101 up. The models run without the API keys in their environment.
- The tunnel uses its own user, `gmat-tunnel`, with no password and no shell. A `Match User gmat-tunnel` block sets these rules for that user and no other:
  - public key login only, with the keys in `/etc/gmat-llm/ssh/authorized_keys`;
  - local forwarding to 127.0.0.1:18100 and nowhere else (`AllowTcpForwarding local`, `PermitOpen 127.0.0.1:18100`, `PermitListen none`);
  - no terminal, no agent or X11 forwarding, no tunnel devices;
  - any command is replaced by `/usr/sbin/nologin`;
  - `AllowUsers gmat-tunnel` and `AllowGroups gmat-tunnel`, so a global `AllowUsers` list on the laptop does not shut the tunnel out. Inside the block they apply to `gmat-tunnel` only.
- Where the rules go. When `sshd_config` reads `sshd_config.d` (Ubuntu's default), they go in `/etc/ssh/sshd_config.d/60-gmat-llm.conf`. Otherwise they go in a marked block at the end of `sshd_config`. Setup never adds an `Include` line, since that would turn on every file already in `sshd_config.d`.
- Each key line repeats the limit with `restrict,port-forwarding,permitopen="127.0.0.1:18100"`.
- These rules were tested against the OpenSSH servers of Ubuntu 24.04 (OpenSSH 9.6) and Ubuntu 22.04 (OpenSSH 8.9), also with a global `AllowUsers` list. The tunnel works. Forwards to other ports, remote forwards, SOCKS forwards to other addresses, commands, shells and other keys are refused.
- The Mac's tunnel key, `~/.ssh/gmat_llm_ed25519`, has no passphrase, so the script can open the tunnel without asking. The key can only open this tunnel, so a copy of it gives no shell on the laptop. Take a key back on the laptop with `sudo gmat-llm remove-client`.
- On the first run the Mac shows the laptop's SSH host key fingerprint. You compare it with the one setup printed. The Mac pins that key in `~/.config/gmat-prep/llm-server-known_hosts` and checks it on every connection. A machine that answers with another key is never used, even when the Mac scans the hotspot to find the laptop.
- llama-swap also asks for an API key, as a second barrier. It refuses requests without `Authorization: Bearer <key>`, except `/health`. The key is random: `gmat-` and 40 letters and digits. It is kept in `/etc/gmat-llm/llama-swap.env` on the laptop (root only), in `~/.config/gmat-prep/llm-api-key` on the Mac (you only), and in the app's API key file. The scripts hand it to `curl` through a config file read from a pipe, so it never shows in a process list, and setup shows a new key on the terminal only, never in its log. `llama-server` itself does not check the key, so a program on the laptop could reach a model that is loaded.
- The firewall, ufw, refuses incoming connections except SSH. SSH is rate-limited: ufw refuses an address that opens 6 or more connections within 30 seconds. The Mac script spaces out its own connections to stay below that.
- Before it turns the firewall on, setup shows the rules and asks. It lists the programs that accept connections from the network, TCP and UDP (mosh and WireGuard use UDP); the firewall blocks them unless you allow them with `sudo ufw allow PORT/tcp` or `PORT/udp`. mDNS stays open through ufw's default rules, so `<laptop name>.local` keeps working.
- Ports that Docker publishes are not covered by ufw: Docker routes their traffic before ufw's rules apply. Setup lists the ones it can see (Docker's `docker-proxy` listeners). An Ollama or Open WebUI container you keep would stay reachable from the hotspot without any key; stop it, or publish it on 127.0.0.1 only.
- The endpoint runs as the system user `gmat-llm` under systemd, with `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome` and `PrivateTmp`. Its memory limit is 1 GiB below the laptop's RAM, so a model that runs out of memory is stopped before SSH stops answering.
- Downloads are pinned and checked: llama.cpp at tag b11400 (commit 0bb496d), llama-swap v265 by SHA-256, NVIDIA's `cuda-keyring` packages by SHA-256, and the models at fixed Hugging Face revisions by the SHA-256 that Hugging Face lists.

### Running setup over SSH

Setup never stops sshd and never closes SSH sessions, and it takes these steps so that a run over SSH cannot lock you out:

- Every change to the SSH server config is made on a copy first. It goes ahead only if `sshd -t` accepts the copy and the login settings stay exactly the same for you (the user who ran sudo), root and a user no rule names, connecting from your address, from the laptop itself and from a hotspot address. The settings compared are the port and listen addresses, every authentication setting, the allow and deny lists, `PermitRootLogin`, `AuthorizedKeysFile`, `ForceCommand` and a few more. The live change is checked the same way, and on any difference every file is put back. Then sshd is reloaded; open sessions stay open. A config that already fails `sshd -t` is not touched.
- The firewall is turned on only when the SSH port is known for sure. Setup reads the ports from `sshd -T` (both `Port` and `ListenAddress`), from `ssh.socket` (Ubuntu 22.10 and later start sshd through it), from what sshd or systemd really listen on, and from the open SSH sessions. If these disagree, or nothing listens, it leaves ufw alone and prints the commands to run yourself.
- The cleanup never deletes a ufw rule that covers an SSH port, names SSH or has no port. While ufw is on, every rule deletion defaults to no.
- Run setup inside tmux (`sudo apt install tmux`, then `tmux`). A dropped SSH connection stops a run outside tmux; run setup again and it carries on, with downloads and the llama.cpp build continuing where they stopped.
- If SSH stops answering anyway, at the laptop's console run `sudo ufw allow PORT/tcp` for your SSH port, or `sudo ufw disable`. The SSH server config from before each change is in `/var/backups/gmat-llm/<time>/etc/ssh/`.

## What the scripts change and how to undo it

### On the laptop

Setup asks before each change. It copies files to `/var/backups/gmat-llm/<time>/` before it edits them, and lists what it installed in `/etc/gmat-llm/installed.list`. `sudo gmat-llm uninstall` undoes most of it (see [Uninstall](#uninstall)).

| What setup does | How to undo it |
|---|---|
| Removes earlier local LLM setups, one group at a time, after showing each item and its size. See [Cleanup of earlier setups](#cleanup-of-earlier-setups) for what counts and what `--yes` does. | Deleted models and folders are gone. Edited config files and unit files are in the backup folder. |
| Installs the packages it needs that are missing: `build-essential`, `cmake`, `ninja-build`, `git`, `curl`, `ca-certificates`, `pkg-config`, `libssl-dev`, `python3`, `avahi-daemon`, `ufw`, `pciutils`, `openssh-server`. | `sudo apt remove` the ones you do not want. Uninstall leaves them. |
| If no NVIDIA driver is installed, offers Ubuntu's driver (`ubuntu-drivers install --gpgpu` and the matching `nvidia-utils-<version>-server`), then stops so you can reboot. | `sudo apt remove` the driver packages. |
| Explains and asks before it adds NVIDIA's repository through NVIDIA's `cuda-keyring` package, then installs CUDA 12.8: `cuda-nvcc-12-8`, `cuda-cudart-dev-12-8`, `libcublas-dev-12-8`, `cuda-driver-dev-12-8` and `cuda-cccl-12-8`, about 1 GB. Older entries for that repository are renamed `*.disabled-by-gmat-llm`. An apt pin, `/etc/apt/preferences.d/gmat-llm-nvidia-driver`, keeps apt from taking the driver from NVIDIA's repository. If you decline the packages, setup removes the keyring and the pin again and puts the older entries back. | Uninstall offers to remove the packages setup installed, and removes the pin together with `cuda-keyring` only, since the pin is what keeps the driver on Ubuntu's packages while NVIDIA's repository is there. Rename a `.disabled-by-gmat-llm` file back, or delete the `# disabled by gmat-llm setup:` prefix in `/etc/apt/sources.list`, to restore an old entry. |
| Builds llama.cpp in `/opt/gmat-llm/llama.cpp`, installs llama-swap in `/opt/gmat-llm/llama-swap`, and copies itself to `/opt/gmat-llm/bin/gmat-llm`, linked from `/usr/local/bin/gmat-llm`. | Uninstall. |
| Downloads the models to `/var/lib/gmat-llm/models`. | Uninstall asks whether to delete them. |
| Writes `/etc/gmat-llm` (settings, the API key, the tunnel keys) and `/etc/systemd/system/gmat-llm.service`, and adds the system users `gmat-llm` and `gmat-tunnel`. Logs go to `/var/log/gmat-llm`. | Uninstall. It leaves the logs. |
| Adds the tunnel user's rules, as `/etc/ssh/sshd_config.d/60-gmat-llm.conf` or as a marked block at the end of `sshd_config` (see [Security design](#security-design)). If an earlier setup turned on `GatewayPorts` or `PermitTunnel`, it offers `/etc/ssh/sshd_config.d/00-gmat-llm-reset.conf`, which turns them off; the default is no. | Uninstall removes the rules, checked the same way as when they were added, and asks about the reset file. The old SSH server config is in the backup folder. |
| Turns on ufw, after showing the rules and asking: incoming connections refused, outgoing allowed, SSH allowed with rate limiting. If ufw is already on, it only adds the SSH rule. | `sudo ufw disable`. Do not delete the SSH rule while ufw is on: that blocks every new SSH connection. |
| With `--keep-awake`: writes `/etc/systemd/logind.conf.d/60-gmat-llm-lid.conf` and masks the sleep targets, so closing the lid does nothing. | Uninstall. |

### Cleanup of earlier setups

Step 2 looks for local LLM software that ran on the laptop before. Software counts as LLM software only by exact names: a container's image must be one of the known images (such as `ollama/ollama`, `ghcr.io/open-webui/open-webui`, `vllm/vllm-openai`, `localai/localai`), or its Compose service or own name must be exactly a known name; unit names, command lines and folder names must name the software as a whole word, so `local-airflow` or `film-studio` do not count. Only ports that LLM software alone uses by default count as LLM ports: 11434 (Ollama), 1234 (LM Studio), 1337 (Jan), 9931 (llama-server releases after b11400), 30000 (SGLang) and 39281 (Cortex). Ports that web frameworks share, such as 3000, 5000 and 8080, do not count.

Nothing is removed without a yes. `--yes` takes the default answer, and a question about data that would cost a download or work to get back is never answered yes by `--yes` alone:

| Found | Default answer | With `--yes` |
|---|---|---|
| Services, user services, containers and images of LLM software; LLM programs, going by their command line, listening on LLM ports or shared ones such as 8080; Ollama's program and service; llama.cpp programs in `/usr/local` | yes | removed |
| SSH tunnels on LLM ports: processes, services and `~/.ssh/config` lines | yes | stopped, or commented out (the config is backed up first) |
| SSH tunnels on other ports, and ssh sessions someone is typing in | no | left alone |
| ufw rules for LLM ports (rules for shared ports such as 8080 default to no) | yes while ufw is off, no while it is on | deleted only while ufw is off |
| ufw rules that cover an SSH port, name SSH or have no port | not offered | left alone |
| Ollama's models, llama.cpp's download cache, LM Studio's models, vLLM's cache | yes | kept; deleted with `--delete-old-models` |
| Hugging Face models (`~/.cache/huggingface/hub/models--*` only, never the token or datasets) and other folders of `.gguf` files, each asked about on its own | no | kept |
| Old llama.cpp source trees with no work in progress, and Python environments of LLM servers (vLLM, Open WebUI, SGLang, text generation inference) | yes | kept; deleted with `--delete-old-envs` |
| llama.cpp trees with changes not committed, or inside another project | not offered | left alone |
| Python environments that only hold a library such as `litellm` or `llama_cpp` (aider and similar tools use them), or that belong to a project | no | kept |
| Container volumes, each with its size and the containers that use it; a volume another container also uses is not offered | no | kept |
| Forwarding lines in an SSH server drop-in of an old LLM setup; only those lines are commented out | yes when one of them opens forwarding to the network (`GatewayPorts yes`, `PermitTunnel`, `PermitOpen any`, `PermitListen any`), else no | as the default |

A folder that is someone's home, a system folder or a top-level folder is never deleted.

### On the Mac

| What the script does | How to undo it |
|---|---|
| Stops SSH processes that forward LLM ports, after asking. Other SSH tunnels, and ssh sessions someone is typing in, default to no. | Start them again yourself. |
| Stops LaunchAgents that run ssh, after asking, and moves their files to `~/.config/gmat-prep/backup/<time>/`. | Move the file back to `~/Library/LaunchAgents` and log in again. |
| Comments out `LocalForward`, `RemoteForward` and `DynamicForward` lines in `~/.ssh/config` and `~/.ssh/config.d/*`, after asking. Lines on LLM ports default to yes, other lines to no. The file is first copied to `~/.config/gmat-prep/backup/ssh/<time>/`, never next to it, where an `Include ~/.ssh/config.d/*` would read the copy. | Copy the backup back, or delete the `# disabled by start-gmat-prep-mac.sh:` prefix. |
| Makes the tunnel key `~/.ssh/gmat_llm_ed25519`, and keeps its settings, the pinned host key and the laptop's API key in `~/.config/gmat-prep/`. Logs go to `~/Library/Logs/gmat-prep/`. | Delete them. |
| Sets the app's LLM settings: the API address, the API key, the models of the local tasks and a price of 0 for the local models. No local model is marked as reading images. The cloud tasks keep their model. The settings from before are saved in `~/.config/gmat-prep/backup/app-llm-settings-<time>.json`, and the app's earlier API key file in `~/.config/gmat-prep/backup/app-credentials-<time>.json`. | In Curator tools, under Settings, enter the earlier values from those files. |
| If Bun is missing, installs Bun 1.4.2 with Bun's official installer, after asking. | Delete `~/.bun` and the lines the installer added to your shell's startup file. |

## First-time setup

### 1. The laptop

1. Install Ubuntu Server 22.04 or 24.04 and join the hotspot. `ip -4 addr` on the laptop shows its address.
2. Copy the script to the laptop and run it there, at the laptop or over SSH (inside tmux, see [Running setup over SSH](#running-setup-over-ssh)). Ubuntu Server's installer offers to install OpenSSH; without it, copy the script on a USB stick.

   ```sh
   scp scripts/local-llm/setup-llm-server.sh you@LAPTOP-ADDRESS:
   ssh you@LAPTOP-ADDRESS
   tmux
   sudo bash setup-llm-server.sh --dry-run   # prints every change, makes none
   sudo bash setup-llm-server.sh
   ```

3. Setup works through eight steps: checks, cleanup of earlier setups, installs, model downloads, the llama-swap config and service, tunnel access and firewall, health checks, and a summary. It asks before each change, and shows each download's size before it starts. Downloads resume where they stopped, and so does a llama.cpp build that was cut off: run setup again.
4. If the laptop has no NVIDIA driver, setup installs Ubuntu's driver and stops. Reboot, then run setup again.
5. At the end setup prints the laptop's name, its addresses, its SSH host key fingerprint and, on the first run, the API key (on the terminal only). Keep this at hand for the Mac. Later, `sudo gmat-llm status` shows the fingerprint and `sudo gmat-llm show-api-key` shows the key.

The dry run changes nothing on the system, with three small exceptions: it writes its own log (in `/tmp` until `/var/log/gmat-llm` exists), checks SSH server changes on a copy of the config in `/tmp` (making the empty folder `/run/sshd` that sshd needs for that, and removing it again), and builds and runs a tiny CUDA test program in `/tmp` when a CUDA compiler is installed. On a laptop without the NVIDIA driver, it shows the driver install and the cleanup, then stops, since the later steps need the driver.

Useful options: `--profile minimal|standard|full`, `--quant UD-Q2_K_XL|UD-Q3_K_XL` to choose the 35B-A3B file yourself, `--vision on`, `--keep-awake` to keep the laptop running with the lid closed, `--yes` to take the default answer to every question, `--delete-old-models` and `--delete-old-envs` (see [Cleanup of earlier setups](#cleanup-of-earlier-setups)), and `--help` for the rest.

### 2. The Mac

1. In the gmat-prep repo, run `scripts/local-llm/start-gmat-prep-mac.sh`.
2. It checks Bun, installs the app's dependencies and builds the web app when needed.
3. It offers to stop old SSH tunnels and forwarding (see the table above).
4. It asks for the laptop's name as setup printed it, finds the laptop and shows its SSH host key fingerprint. Answer yes only if it matches what setup printed.
5. It asks for your own SSH login on the laptop. With it, the script installs the Mac's tunnel key and reads the API key over SSH; `sudo` on the laptop asks for your password. Without a login, it prints two commands to run on the laptop and asks you to paste the key they show.
6. It opens the tunnel, starts the app, sets the app's LLM settings, runs the app's own connection test and opens the app in your browser.
7. If the app has no Curator passphrase yet, the script asks you to choose one. If it has one, the script asks for it.
8. If the app already uses a cloud API, the script keeps generation, approaches and lessons there and asks to keep the cloud key on the laptop for them (see [Why generation, approaches and lessons stay on the cloud](#why-generation-approaches-and-lessons-stay-on-the-cloud)). If the app has no cloud API yet, either use `--all-local`, or choose models for those three tasks in Settings and then run the script with `--reconfigure --cloud-base-url https://.../v1`; it asks for the cloud key.

## Everyday use

- Run `scripts/local-llm/start-gmat-prep-mac.sh`. It finds the laptop even if its address changed, opens the tunnel, starts the app and opens the browser. Ctrl+C stops the app and the tunnel.
- If the tunnel drops, for example because the laptop slept, the app keeps running and the script reconnects when it finds the laptop again, trying every 30 seconds. A job whose request failed meanwhile pauses and resumes on its own after five minutes.
- `--stop` stops an app and tunnel that an earlier run left running, for example after its Terminal window closed.
- `--configure-only` sets the LLM settings of an app you started another way, such as `bun dev`. The settings point the app at the tunnel, so when no tunnel is open the script offers to open one and keeps it open until Ctrl+C. `--reconfigure` sets the settings again on a normal start.
- The first request after a model switch waits while the model loads.

On the laptop:

| Command | What it does |
|---|---|
| `sudo gmat-llm status` | service, models, memory, experts in RAM, tunnel keys, host key fingerprint, firewall |
| `sudo gmat-llm test` | asks every model for a reply and for JSON that follows a schema; times the 35B-A3B's load from cold, a warm request and a long reply; reads a test image with the models that read images; reports speed and memory use |
| `sudo gmat-llm logs -f` | follows the endpoint's log |
| `sudo gmat-llm restart` | restarts the endpoint |
| `sudo gmat-llm add-client 'ssh-ed25519 AAAA...'` | allows another Mac's tunnel key |
| `sudo gmat-llm remove-client [match]` | lists tunnel keys, or removes those that match |
| `sudo gmat-llm set-cloud --base-url https://.../v1 --models a,b` | sends those models on to a cloud API; reads the key from a file (`--key-file`) or from standard input without showing it |
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
| Models, standard profile | 15.03 GB with the 2-bit 35B-A3B, 19.59 GB with the 3-bit one; 0.90 GB more with `--vision on` |
| Models, full profile | 2.07 GB more than standard |

After setup, the laptop downloads nothing more unless you run setup again. Traffic between the Mac and the laptop goes through the iPhone over Wi-Fi and not out to the internet. Whether an iPhone counts it as mobile data was not checked.

What goes where:

- Requests of the local tasks, with their question text, book pages and chat messages, go only to the laptop.
- Requests of generation, approaches and lessons go to your cloud API, as before, through the laptop when the cloud route is set.
- Setup downloads from Ubuntu's archive, NVIDIA's repository, GitHub (llama.cpp and llama-swap) and Hugging Face (the models). The Mac script runs `bun install` when the app's dependencies are missing or changed, and downloads Bun only if it is missing and you agree.

## Troubleshooting

- The Mac cannot find the laptop. Check that both are on the same hotspot and that the laptop is awake (setup's `--keep-awake` helps). Pass the address the laptop shows with `ip -4 addr`: `--address 172.20.10.N`. The script also scans the Mac's own network for an SSH server with the pinned host key. If the hotspot keeps devices from reaching each other, the tunnel cannot work.
- "answers with a different host key". The laptop was reinstalled, its SSH host keys changed, or another device now has its old address. Compare with `sudo gmat-llm status` on the laptop, then run the Mac script with `--pair`.
- "Port 18100 on this Mac is in use". Another program has that port. Stop it, or pass `--local-port N`.
- SSH connections are refused for a while. ufw refuses an address that opens 6 or more connections within 30 seconds. Wait 30 seconds and try again.
- "The SSH port could not be worked out with confidence". Setup left the firewall off. Check the port with `sudo ss -ltnp | grep sshd`, then run the commands setup printed: `sudo ufw limit PORT/tcp`, `sudo ufw default deny incoming`, `sudo ufw enable`.
- "The tunnel rules could not be added". Setup changed nothing; the warnings above it say why, for example an earlier `Match` block in `sshd_config` that sets the same options first. Fix that, or add the rules setup printed to `sshd_config` yourself where they take effect, check with `sudo sshd -t`, reload with `sudo systemctl reload ssh` and run setup again.
- "The endpoint refused the API key". Setup made a new key, for example after `/etc/gmat-llm` was removed. Run the Mac script with `--pair`.
- The 35B-A3B does not load or runs out of memory. Look at `sudo gmat-llm logs`. Run setup again with `--quant UD-Q2_K_XL`, with a smaller `--ctx-reason`, or with `--n-cpu-moe 40` to keep every expert in RAM. Close other programs that use the GPU (`nvidia-smi` lists them).
- A request times out after 180 seconds. Loading the 35B-A3B from a slow disk can take that long, and long replies such as extraction can too; the job then pauses and tries again after five minutes. `sudo gmat-llm test` shows the times. Set extraction to your cloud model in Settings if pages keep timing out.
- Replies fail their JSON check. The local models keep to a reply's shape best with `--json-mode json-schema`. The script keeps the app's JSON mode when the app also uses a cloud API, because some cloud APIs do not accept that mode.
- `apt update` fails with "Conflicting values set for option Signed-By". An older entry for NVIDIA's repository clashes with the `cuda-keyring` one. Let setup turn it off, or remove it.
- Logs: setup writes `/var/log/gmat-llm/setup-<time>.log`. The endpoint logs to the journal (`sudo gmat-llm logs`). On the Mac, the app and tunnel logs are in `~/Library/Logs/gmat-prep/`.

## Uninstall

On the laptop, run `sudo gmat-llm uninstall`. It stops and removes the service, the tunnel user and its SSH rules, llama.cpp, llama-swap, `/etc/gmat-llm` and the `gmat-llm` tool. It asks before deleting the models and before removing the CUDA packages; it removes only packages setup recorded as installed, and asks first if apt would remove others with them. It leaves the firewall on with SSH open (`sudo ufw disable` turns it off), the Ubuntu packages, the logs in `/var/log/gmat-llm` and the backups in `/var/backups/gmat-llm`.

On the Mac, stop the script with Ctrl+C. Copy the saved settings files from `~/.config/gmat-prep/backup/` somewhere else, then delete `~/.ssh/gmat_llm_ed25519`, `~/.ssh/gmat_llm_ed25519.pub`, `~/.config/gmat-prep/` and `~/Library/Logs/gmat-prep/`. In the app, under Curator tools, Settings, enter your cloud API address, models and API key again.

## Not tested yet

Nothing here has run on the real laptop or on a Mac. What was tested ran in a Linux container:

- The Mac script ran under bash 3.2.57, the version macOS ships, built from source, on Linux with GNU tools. It never ran on macOS, so these parts are untested: `route`, `ipconfig`, `ifconfig`, `nc -G`, `plutil`, `PlistBuddy`, `launchctl`, `open`, the `~/Library` folders, and the macOS versions of `ps`, `sed`, `date` and `stat`.
- Setup never ran on a real Ubuntu machine: not with systemd running, a real ufw, an NVIDIA driver or a GPU. What ran: the whole setup as a dry run with pretend hardware and with old LLM setups in a user's home; its cleanup for real in a private copy of the system; its functions with stand-ins for ufw, Docker, systemctl, ss and apt-get; its SSH server changes against the real sshd of Ubuntu 24.04 (OpenSSH 9.6) and 22.04 (OpenSSH 8.9) on a private copy of `/etc`, with real tunnel connections; its llama-swap config with llama-swap v265 and a CPU build of `llama-server` b11400 and a 0.8B model; and the Mac script end to end against a real sshd, sudo, llama-swap and the app.
- Not tested at all: the CUDA build of llama.cpp and the install of CUDA from NVIDIA's repository; the NVIDIA driver install; `llama-fit-params` on the real GPU and whether its choice of layers fits; the 35B-A3B's speed and memory use on the laptop, and whether an extraction request finishes within 180 seconds; Ubuntu 24.04's `ssh.socket` on a real system (its output was simulated); whether an iPhone counts the traffic between the Mac and the laptop as mobile data.

Run setup with `--dry-run` first and read what it would do.

## Sources

- llama.cpp: [repository](https://github.com/ggml-org/llama.cpp), [build guide at b11400](https://github.com/ggml-org/llama.cpp/blob/b11400/docs/build.md), [llama-server options at b11400](https://github.com/ggml-org/llama.cpp/blob/b11400/tools/server/README.md), [llama-fit-params at b11400](https://github.com/ggml-org/llama.cpp/blob/b11400/tools/fit-params/README.md)
- llama-swap: [v265 release](https://github.com/mostlygeek/llama-swap/releases/tag/v265), [configuration reference](https://github.com/mostlygeek/llama-swap/blob/v265/docs/config.example.yaml), [API keys](https://github.com/mostlygeek/llama-swap/blob/v265/docs/kb/guides/api-integration/api-keys-and-auth.md)
- Models: [Qwen3.5 4B GGUF](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF), [Qwen3.6 35B-A3B GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF), [Qwen3.6 35B-A3B model card](https://huggingface.co/Qwen/Qwen3.6-35B-A3B) (sampling settings), [Unsloth's Qwen3.6 guide](https://unsloth.ai/docs/models/qwen3.6), [GLM-OCR GGUF](https://huggingface.co/ggml-org/GLM-OCR-GGUF), [Qwen3 Embedding 0.6B GGUF](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF)
- Speed on a small GPU: [InsiderLLM, running Qwen3.6 35B-A3B locally](https://insiderllm.com/guides/best-way-run-qwen-3-6-35b-moe-locally/)
- NVIDIA: [CUDA repositories](https://developer.download.nvidia.com/compute/cuda/repos/), [CUDA minor version compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html) (CUDA 12.x needs driver 525 or newer, CUDA 13.x needs 580)
- Ubuntu: [NVIDIA driver installation](https://help.ubuntu.com/community/NvidiaDriversInstallation), [ufw(8)](https://manpages.debian.org/unstable/ufw/ufw.8.en.html), [sshd socket activation (Ubuntu 22.10 and later)](https://discourse.ubuntu.com/t/sshd-now-uses-socket-based-activation-ubuntu-22-10-and-later/30189)
- Docker: [packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/) (published ports bypass ufw)
- OpenSSH: [sshd_config(5)](https://man7.org/linux/man-pages/man5/sshd_config.5.html)
- Ollama on Linux, including its uninstall steps: [docs.ollama.com/linux](https://docs.ollama.com/linux)
- Bun installation: [bun.com/docs/installation](https://bun.com/docs/installation)
- macOS `nc`: [nc(1)](https://www.unix.com/man-page/osx/1/nc/)
