# Forge Local Companion

Forge Local Companion is a local-first AI companion powered by Ollama, SQLite
memory, identity files, and a browser-based web UI — sized for a single
consumer GPU (8 GB) running a small model like gemma4:e4b.

The default install is 100% local: one configurable chat model through Ollama,
persistent local memory, and no cloud dependency. Everything that reaches
beyond the machine — web search, Telegram, cloud fallback — is a separate
opt-in switch that defaults OFF.

## What This Is

- A local-first AI companion with a web chat UI (streaming replies) backed by Express
- One configurable local model from `forge.config.yaml`, via Ollama `/api/chat`
- Persistent memory: SQLite + FTS5, optional local embeddings, and automatic
  capture of durable facts with a review/prune UI
- Local identity files (IDENTITY/SOUL/USER) the model can propose changes to,
  which you approve
- Document RAG: drop in PDF/md/txt/csv, get cited answers
- A permission-gated tool system (web search via self-hosted SearXNG, page
  fetch, on-demand local image generation and vision analysis) with a full
  audit log
- Local CPU voice I/O: whisper.cpp speech-to-text and Piper text-to-speech
- A Telegram channel bridge and a cron scheduler for unattended agent turns
- Deny-by-default everywhere: every capability with reach is opt-in

## What This Is Not

- Not cloud-hosted, and not a Claude, OpenAI, Anthropic, or Codex app
- Not able to execute commands or write files (the only filesystem tools are
  read-only — `read_file` / `list_dir` — and bound to an allowlist of
  directories that defaults to empty)
- Not a multi-user service — one instance, one user, one machine
- Not a universal agent framework; it is one opinionated companion

## How It Works

Every channel — web UI, Telegram, scheduled jobs — feeds the same pipeline:

```text
Message (web / telegram / scheduler)
  -> saved locally in messages.db under its channel
  -> /remember or /forget handled if present
  -> memories retrieved (FTS5 + optional local embeddings, fused)
  -> relevant document chunks retrieved (RAG, token-capped, untrusted-framed)
  -> identity files + memories + documents become system context
  -> agent loop when tools are enabled (permission-gated, audit-logged),
     otherwise a single Ollama /api/chat completion (streamed in the web UI)
  -> reply saved locally, sent back to the channel
  -> async passes: automatic memory capture + identity reflection
```

## Quickstart

```powershell
git clone <repo-url> forge
cd forge
npm install
ollama pull gemma4:e4b
npm start
```

Open http://127.0.0.1:6800 and say hello.

Two names are worth setting before (or right after) the first launch, in
`forge.config.yaml` — or better, in a gitignored local copy (see
"Configuration"):

- `forge.name` — your companion's name. The first run scaffolds starter
  identity files under `identity/` around it (see "Identity Files").
- `user.name` — your name, so the companion knows who it is talking to.

Everything beyond local chat — tools, web search, voice, image generation,
Telegram — is opt-in and defaults OFF. Each has its own section below.

On Windows, `run.bat` is a one-click launcher: it starts Ollama if it is not
running, starts the Forge server in a minimized window, and opens the web UI.
Double-clicking it again while Forge is running just opens the UI.

## Requirements

Required:

- Node.js 22+
- Git
- Ollama with a pulled chat model

Optional, per feature:

- An embedding-capable Ollama model (e.g. `nomic-embed-text`) for semantic
  memory recall and document RAG
- Docker for the self-hosted SearXNG instance behind `web_search`
- whisper.cpp and Piper binaries for voice I/O (CPU)
- An A1111-compatible Stable Diffusion backend for image generation
- A Telegram bot token for the Telegram bridge

Platform notes: Forge is developed and tuned on Windows 11 with an 8 GB
NVIDIA GPU — the doc examples are PowerShell and `run.bat` is Windows-only.
The server itself is plain Node.js + SQLite with no Windows-specific
dependencies, so macOS and Linux should work via `npm start`, but they are
not regularly tested. Optional features that shell out to local binaries
(whisper.cpp, Piper) or local HTTP backends (SearXNG, Stable Diffusion) work
wherever you can provide those.

## Ollama Setup

Install Ollama, then pull and run a chat model:

```powershell
ollama run <model-of-choice>
```

Optional semantic memory recall uses a separate embedding-capable model. Pull
the model selected in `memory.embeddings.model` before enabling it:

```powershell
ollama pull <embedding-model-of-choice>
```

Forge expects Ollama at:

```text
http://localhost:11434
```

You can change the model and base URL in `forge.config.yaml`.

## Install And Run

From the repo root:

```powershell
npm install
npm run typecheck
npm test
npm start
```

On Windows PowerShell, if `npm.ps1` is blocked by execution policy, use `npm.cmd`:

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd start
```

By default the web server listens only on localhost:

```text
http://127.0.0.1:6800
```

## Configuration

Forge loads `forge.config.yaml` from the repo root — unless a
**`forge.config.local.yaml`** exists next to it, in which case the local file
is used instead. The local file is gitignored, so machine-specific settings
(enabled channels, chat ids, binary paths, toggles you flip often) never show
up in `git status`. To start one:

```powershell
Copy-Item forge.config.yaml forge.config.local.yaml
```

Keep the tracked `forge.config.yaml` as the clean committed defaults. Note the
local file is a full replacement, not a merge — copy first, then edit.

Example `forge.config.yaml`:

```yaml
forge:
  name: forge-local
  version: "0.1.0"
  root: .

user:
  name: your-name

llm:
  provider: ollama
  model: gemma4:e4b
  ollama:
    base_url: http://localhost:11434
    keep_alive: 10m
    options:
      # Gemma 4 sampling guidance
      temperature: 1.0
      top_k: 64
      top_p: 0.95
      # Fits an 8 GB GPU; see "Tuning For An 8 GB GPU" for the 16384 path
      num_ctx: 8192
      num_predict: 1024
  # Cloud fallback used only when local Ollama fails. Default off.
  fallback:
    enabled: false
    provider: openai-compatible
    base_url: https://api.openai.com/v1
    # model: <cloud-model>            # required when enabled
    api_key_env: FORGE_FALLBACK_API_KEY

paths:
  dbs: ./dbs
  identity: ./identity
  logs: ./logs
  images: ./images

services:
  web:
    host: 127.0.0.1
    port: 6800
    context_window_tokens: 80000
    debug_prompt_context: false

memory:
  retention_days: 30
  # Optional. Keep disabled for the original FTS5-only memory behavior.
  embeddings:
    enabled: false
    # model: <embedding-model-of-choice>
    request_timeout_ms: 10000
    backfill_batch_size: 16
  # Automatic capture of durable facts after each turn (see "Automatic Memory").
  auto:
    enabled: true
    max_per_turn: 3
    dedupe_similarity: 0.92
  # Rolling summary of turns that fell out of the context window
  # (see "Conversation Continuity").
  summary:
    enabled: true
    max_chars: 1200
    batch_messages: 40
  # Nightly memory hygiene (see "Backups & Memory Hygiene").
  consolidation:
    enabled: true
    dedupe_similarity: 0.95
    interval_days: 1

# Document RAG (see "Document RAG" below). Requires memory.embeddings.
rag:
  enabled: true
  chunk_tokens: 400
  chunk_overlap_tokens: 50
  top_k: 4
  min_similarity: 0.35
  max_context_tokens: 1500

# Safe tool system. Everything defaults OFF; see "Tool System" below.
tools:
  enabled: false
  max_iterations: 5
  levels:
    safe: false
    network: false
    filesystem: false
    sensitive: false
  filesystem:
    readable_dirs: []
    writable_dirs: []

# Web tools backend (used by web_search/fetch_url when the network level is on).
search:
  searxng_url: http://localhost:8888
  results: 5
  timeout_ms: 8000
  fetch_max_chars: 8000

# Local CPU voice I/O (see "Local Voice I/O"). Off by default.
voice:
  stt:
    enabled: false
    engine: whisper-cpp
    binary: whisper-cli
    model: ""
  tts:
    enabled: false
    binary: piper
    model: ""

# On-demand local image generation (see "Image Generation"). Off by default.
imagegen:
  enabled: false
  backend: a1111
  base_url: http://localhost:7860
  free_vram: true

# Unattended scheduled agent turns (see "Scheduler"). Off by default.
scheduler:
  enabled: false
  jobs: []

# Scheduled local backups (see "Backups & Memory Hygiene"). Local-only:
# protects the databases and identity files.
backup:
  enabled: true
  interval_days: 7
  keep: 8
  dir: ./backups

# Telegram bridge (see "Telegram Bridge"). Off by default; token from env.
channels:
  telegram:
    enabled: false
    token_env: FORGE_TELEGRAM_TOKEN
    allowed_chat_ids: []
```

Important notes:

- `llm.model` is the active local model.
- The model name is configurable and is not hardcoded in TypeScript.
- `llm.provider` is present for clarity but only supports `ollama`.
- The default web host is `127.0.0.1`.
- Change the web host intentionally if you want LAN access.

## Identity Files

The companion's character lives in plain Markdown under `identity/`
(gitignored — these files are yours, not the repo's). The first run scaffolds
starter templates built around `forge.name`:

- `IDENTITY.md` — who the companion is: name, role, responsibilities
- `SOUL.md` — how it behaves: personality, tone, values
- `USER.md` — what it knows about you (starts empty; it will ask)
- `NOTES.md` — its own lower-trust working notes, appended by reflection

Edit the files directly any time, or just talk. After chat turns, an async
reflection pass lets the model propose identity edits; proposals stay pending
until you approve or reject them in the web UI — the model never rewrites its
own identity directly. `NOTES.md` is the one exception: reflection appends
working notes there without approval, which is why it is treated as lower
trust, and why scheduled notes maintenance (`identity.notes_maintenance`)
periodically promotes durable notes into pending IDENTITY.md proposals,
archives stale ones into memory, and keeps the file under a byte cap.

Two practical rules:

- Every `.md` file in `identity/` is injected into the system prompt — do not
  park drafts or scratch files there.
- The identity context as a whole is capped to a share of the prompt budget
  (`identity.budget.share`, default 0.35). When the files outgrow it, they
  are truncated in priority order (SOUL, then IDENTITY, USER, NOTES) with a
  visible notice, and `get_status` reports what was cut.

## Scheduler

The scheduler runs unattended agent turns on a cron schedule — morning
briefings, reminders, "check X daily and message me." Each job's prompt goes
through the exact same permission-gated pipeline as a chat message: identity,
memories, RAG, the tool loop with its levels and audit log, and automatic
memory capture.

```yaml
scheduler:
  enabled: true
  jobs:
    - name: morning-briefing
      cron: "0 8 * * *"        # minute hour day month weekday
      prompt: "Search the web for today's top tech news and give me a short briefing."
      channel: telegram
      chat_id: "123456789"
```

- Standard 5-field cron with lists, ranges, and steps (`*/15 9-17 * * 1-5`);
  expressions are validated at startup with clear errors.
- `channel: telegram` delivers the output to you (pairs with the Telegram
  bridge); `channel: none` skips delivery. Either way the turn is stored in
  `messages.db` under `channel='scheduler'`, so it also shows up in the web UI.
- Single-GPU discipline: jobs execute strictly one at a time. If a job's
  schedule fires while its previous run is still going, the new run is
  skipped, not queued up behind it.
- Every run — success, failure, or overlap-skip — is logged durably to the
  `scheduler_runs` table in `tools.db` with duration and a result preview.

Default: disabled, no jobs defined.

### Reminders

One-shot reminders ride the same tick loop, no cron job required — they work
even with `scheduler.enabled: false`. Ask in chat ("remind me in 20 minutes
to check the oven") and the model calls the `set_reminder` tool; when the
reminder comes due it is always posted into the chat feed
(`channel='scheduler'`), and also sent to the first allowlisted Telegram chat
when the bridge is configured. Reminders are stored durably in the
`reminders` table in `tools.db` and each delivery is logged to
`scheduler_runs`. Requirements: `tools.enabled` plus `tools.levels.sensitive`
for `set_reminder`/`cancel_reminder`, and `tools.levels.safe` for
`list_reminders` and the recall tools. No new config blocks are needed.

## Telegram Bridge

Forge can be reached from Telegram — a channel, not a tool. Telegram messages
run through the exact same pipeline as the web UI (identity, memories, RAG,
tools, automatic capture) and are stored in `messages.db` with
`channel='telegram'`, with conversation history scoped per chat. The channel
adapter interface (`src/channels/types.ts`) is generic, so a WhatsApp Cloud
adapter can slot in later.

Setup:

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Put the token in the environment (or `.env`):

   ```text
   FORGE_TELEGRAM_TOKEN=123456:ABC-your-token
   ```

3. Enable the bridge in `forge.config.yaml`:

   ```yaml
   channels:
     telegram:
       enabled: true
       allowed_chat_ids: []
   ```

4. Start Forge and message your bot. The allowlist is empty, so the bot
   replies once with your chat id; add it to `allowed_chat_ids` and restart.

The bridge uses long polling, so no public URL or webhook is required.
Security notes: chats not on the allowlist never reach the model, replies are
split at Telegram's 4096-character limit, and poll failures back off and
retry without crashing Forge. Messages travel through Telegram's servers —
use the web UI when everything must stay on the machine.

Photo attachments are a separate opt-in
(`channels.telegram.attachments.enabled`). When on, photos — and images sent
as files — from allowlisted chats are downloaded (size-capped by
`max_file_bytes`, default 10 MiB) into the gitignored `attachments/`
directory, which acts as an implicit read-only root for the filesystem
tools, and the turn tells the model the saved path so it can call
`analyze_image` (see "Image Analysis (Vision)"; requires `vision.enabled`
plus the filesystem tool level). Old downloads are pruned after
`retention_days` (default 7).

## Image Generation

The `generate_image` tool (permission `network`) generates images with a local
Stable Diffusion backend over HTTP — any A1111-compatible txt2img API works:
SD WebUI launched with `--api`, SD.Next, or Forge webui, running **SD 1.5 or
SDXL-Turbo with low-VRAM flags** (`--medvram` or `--lowvram`). The backend
interface is small, so a hosted API could swap in later; nothing is sent
anywhere by default.

**The 8 GB rule: SD and gemma4:e4b are never co-resident in VRAM.** Generation
is strictly on-demand. With `imagegen.free_vram: true` (default) the tool asks
Ollama to unload the chat model before generating; Ollama reloads it
automatically on the next reply. Expect two slow moments by design: the first
image after idle (SD model load) and the first reply after an image (E4B
reload). Do not try to keep both loaded.

Setup: start the SD backend, set `imagegen.enabled: true` and
`imagegen.base_url`, and make sure `tools.enabled` and `tools.levels.network`
are on. The tool takes a `prompt` plus optional `width`/`height`/`steps`/
`seed`, clamped to `max_size`/`max_steps` (defaults are 512px / 20 steps,
sized for small VRAM). Generated PNGs are saved under the gitignored
`images/` directory and served at `/api/images/...`; replies that reference
them render the image inline in the chat. Backend offline, timeouts, and bad
responses come back to the model as structured errors — never a crashed turn.

## Image Analysis (Vision)

The `analyze_image` tool (permission `filesystem`) describes or reads an
image file with a dedicated local vision model over the same Ollama API — the
default is `qwen2.5vl:7b`. The chat model is never used for vision, even when
its model card claims the capability (community builds can ship a broken
vision projector that hallucinates descriptions).

Setup: `ollama pull qwen2.5vl:7b`, set `vision.enabled: true`, and make sure
`tools.enabled`, `tools.levels.filesystem`, and a non-empty
`tools.filesystem.readable_dirs` are on — image paths are bound by the same
read-only allowlist as `read_file` (Telegram attachments add their own
implicit root). The tool registers at startup, so enabling it requires a
restart.

Ollama swaps the chat and vision models in and out of VRAM by itself — no
`free_vram` handoff needed — so the first analysis after chatting pays a
model-load delay, and a dense image can take a few minutes on an 8 GB card
(`timeout_ms` defaults to 5 minutes). The `num_predict` and `repeat_penalty`
defaults guard against runaway repetition on images dense with repeated
glyphs, and `max_image_bytes` caps input files at 10 MiB.

## Local Voice I/O

Voice input and output run entirely on CPU — roughly zero VRAM next to
gemma4:e4b. Both are off by default and fail gracefully (clear error, chat
unaffected) if a binary or model is missing.

**Speech-to-text (whisper.cpp).** Download a whisper.cpp release binary
(`whisper-cli`) and a ggml model — `ggml-base.en.bin` (English) or
`ggml-small.bin` (multilingual) from the whisper.cpp model repository — then:

```yaml
voice:
  stt:
    enabled: true
    binary: C:\tools\whisper\whisper-cli.exe
    model: C:\models\ggml-base.en.bin
```

A microphone button appears in the chat composer. Recording happens in the
browser (16 kHz mono WAV, so no ffmpeg is needed); the transcript lands in the
composer for review, then flows through the normal chat pipeline. Setting
`voice.stt.engine: native` sends the audio to the chat model itself instead —
Gemma 4 E4B accepts audio natively — but whisper.cpp is the default because
its transcription is more reliable.

**Text-to-speech (Piper).** Download a Piper release and a voice model
(e.g. `en_US-lessac-medium.onnx` plus its `.json` config side-by-side), then:

```yaml
voice:
  tts:
    enabled: true
    binary: C:\tools\piper\piper.exe
    model: C:\models\en_US-lessac-medium.onnx
```

A `speak` action appears on assistant replies and plays the synthesized WAV
in the browser. Synthesis is capped at `voice.tts.max_chars` characters.

## Document RAG

Upload PDF, Markdown, text, or CSV files in the web UI's **Docs** tab. Each
document is extracted, chunked (~`rag.chunk_tokens` tokens with overlap), and
embedded locally with the same `memory.embeddings` model used for memory
recall — a small model like `nomic-embed-text` runs fine on CPU alongside
gemma4:e4b on 8 GB.

On each chat message, the query is embedded and the highest-similarity chunks
(up to `rag.top_k`, at or above `rag.min_similarity`) are injected into the
system context as clearly delimited reference material. Injected excerpts are
framed as untrusted data: the model is instructed to answer from them and cite
them, never to follow instructions found inside them. Total injected tokens
are hard-capped by `rag.max_context_tokens` so retrieval fits the 8 GB context
budget.

Replies that drew on documents show source chips (document name + part) under
the message, and the same source list is persisted in the message metadata.
Retrieval and ingestion failures never break chat: a failed document shows a
`failed` status in the Docs tab, and a failed retrieval simply injects
nothing. RAG requires `memory.embeddings.enabled: true`; everything stays
local.

## Tool System

Forge ships a permissioned tool substrate. Everything defaults OFF:

- `tools.enabled` is the master switch. When false, chat runs exactly as
  before — one completion per turn, no tools advertised to the model.
- Each tool declares a permission level: `safe`, `network`, `filesystem`, or
  `sensitive`. A tool runs only when the master switch AND its level toggle
  (`tools.levels.<level>`) are both true.
- `filesystem`-level tools are additionally bound by
  `tools.filesystem.readable_dirs` / `writable_dirs`. Empty lists deny every
  path even when the level is on. The gate is checked twice per call: on the
  requested path, and again on the symlink-resolved real path.
- Every tool call — allowed or denied, success or failure — is logged to
  `dbs/tools.db` (`tool_calls` table) with the tool name, an arguments
  summary, its permission level, the decision, duration, and any error.
- Tool output is treated as untrusted data: results are wrapped in a JSON
  envelope, the model is instructed never to follow instructions found inside
  them, and nothing in a tool result can enable further permissions.

Built-in tools, by permission level (each stays inert until `tools.enabled`
and its `tools.levels.<level>` toggle are both true):

- `safe` — read-only recall over local data: `memory_search` (saved
  memories, hybrid keyword + semantic), `history_search` (full-text search
  over past conversation messages), `document_search` (passages from
  uploaded documents), `list_reminders` (pending reminders), and
  `get_status` (the model's authoritative self-report: enabled features,
  every tool with whether it is currently allowed, and data counts).
- `network` — `web_search` and `fetch_url` (see "Local Web Search
  (SearXNG)"), plus `generate_image` when `imagegen.enabled` is on.
- `filesystem` — read-only file access, additionally bound by the
  `tools.filesystem.readable_dirs` allowlist: `read_file` (UTF-8 text files
  only, capped at `max_read_bytes`, default 256 KiB) and `list_dir` (entry
  names, types, and sizes), plus `analyze_image` when `vision.enabled` is on
  (see "Image Analysis (Vision)"). Nothing writes; `writable_dirs` is
  reserved for a possible future write tool.
- `sensitive` — `set_reminder` and `cancel_reminder`, which schedule and
  unschedule future unattended output (see "Scheduler" → Reminders).

The registry (`src/services/tools/registry.ts`) is the extension point for
more.

## Local Web Search (SearXNG)

The `web_search` tool queries a self-hosted [SearXNG](https://docs.searxng.org)
metasearch instance; the `fetch_url` tool fetches a single public page and
returns size-capped readable text. No query or URL ever leaves the machine
except through SearXNG's own upstream calls.

Run SearXNG locally with Docker:

```powershell
docker run -d --name searxng -p 8888:8080 -v searxng-data:/etc/searxng --restart unless-stopped searxng/searxng
```

SearXNG rejects JSON requests by default. Enable the json format once, then
restart the container:

```powershell
docker exec searxng sh -c "sed -i 's/formats:/formats:\n    - json/' /etc/searxng/settings.yml"
docker restart searxng
```

(Or edit `settings.yml` in the `searxng-data` volume and add `json` under
`search: formats:`.) Point `search.searxng_url` in `forge.config.yaml` at the
instance (default `http://localhost:8888`), then enable `tools.enabled` and
`tools.levels.network`.

Safety notes:

- Both tools time out (`search.timeout_ms`), cap their output, and convert
  failures (unreachable, non-200, empty results) into structured errors the
  model sees — they never crash a chat turn.
- Web content is untrusted: results pass through the same agent-loop envelope
  and never-follow-instructions contract as every other tool result.
- `fetch_url` refuses private, loopback, and internal addresses so injected
  instructions inside a fetched page cannot use it to probe the local network.

## Cloud Fallback

`llm.fallback` adds an optional OpenAI-compatible cloud fallback used ONLY
when the local Ollama call fails, and ONLY when `llm.fallback.enabled` is
true. The API key is read from the environment variable named by
`llm.fallback.api_key_env` (default `FORGE_FALLBACK_API_KEY`) and never lives
in config. With fallback disabled (the default), Forge makes no cloud calls of
any kind. Streamed replies do not fall back; only whole-turn completions do.

## Tuning For An 8 GB GPU

The defaults target a gemma4:e4b variant on an 8 GB card (e.g. RTX 2060 SUPER).

Set these environment variables for the Ollama server process (System
Properties > Environment Variables on Windows, then restart Ollama):

```text
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KV_CACHE_TYPE=q8_0
```

- `OLLAMA_FLASH_ATTENTION=1` enables flash attention and is a prerequisite for
  KV cache quantization.
- `OLLAMA_KV_CACHE_TYPE=q8_0` stores the KV cache at q8_0 instead of f16,
  roughly halving its VRAM use at negligible quality cost.

The rule: **keep everything in VRAM.** After a chat, run:

```powershell
ollama ps
```

The model must show `100% GPU`. Any CPU share means the model or KV cache
spilled to system RAM and generation slows dramatically — lower
`llm.ollama.options.num_ctx` until it fits.

Path from the default `num_ctx: 8192` to `16384`: set both environment
variables above, raise `num_ctx` to `16384` in `forge.config.yaml`, restart
Forge, then verify `ollama ps` still reports `100% GPU`.

## Web UI

Start Forge and open:

```text
http://127.0.0.1:6800
```

Forge requires a local auth token by default. On first run, the server prints the generated token and saves it to:

```text
logs/web-auth-token
```

Paste that token into the login screen.

The UI has four tabs:

- **Chat** — streaming replies with per-message metadata, RAG source chips, a
  prompt inspector, optional mic input and `speak` playback, and generated
  images rendered inline
- **Memory** — review auto-captured and manual memories, prune wrong ones, and
  inspect the capture log
- **Docs** — upload, list, and delete RAG documents with per-document status
- **Settings** — instance info, Ollama health and installed models, database
  health, embedding-index progress with a reindex action, and the identity
  reflection toggle

Model selection is read-only in the UI. Edit `forge.config.yaml` to change the
selected model.

## Automatic Memory

With `memory.auto.enabled: true` (the default), Forge captures memories
automatically: after each reply, an async background pass asks the local model
to extract durable facts (user facts, preferences, projects, relationships),
dedupes them against existing memories — exact matches always, embedding
similarity when the vector index is enabled — and saves survivors tagged
`auto`. A failed extraction never blocks or delays the chat reply.

Review what was captured in the web UI's **Memory** tab:

- list all / auto-captured / manual memories with created time and the source
  message they came from
- delete wrong captures with one click
- inspect the **Capture log**, which records every extraction outcome
  (created, duplicate, invalid, error) so a small model's mistakes are easy to
  catch

Set `memory.auto.enabled: false` to return to manual-only memory.

## Memory Commands

`/remember` and `/forget` remain as manual overrides:

Save an explicit memory:

```text
/remember <text>
```

Forget a memory by ID:

```text
/forget <memory-id>
```

Memory behavior:

- Explicit memories are stored in SQLite.
- FTS5 searches exact words and remains the always-available local fallback.
- When enabled, the configured local embedding model creates vectors for explicit memories and question text.
- Forge merges lexical and semantic matches, removes duplicates, and adds only the best few memories to the system context.
- New memories are indexed best-effort after they are saved; a failed or missing embedding model never prevents `/remember` from succeeding.
- Existing memories are backfilled automatically in the background and can be reindexed from Settings.
- Changing the embedding model leaves old vectors unused until the current model has been indexed.
- Message history is saved locally.
- No cloud embedding or vector service is used.

## Conversation Continuity

Ollama models do not retain chat state between requests. Forge provides bounded recent conversation history by rebuilding each request from a limited window of recent user and assistant messages stored in `messages.db`, scoped per channel (and per chat on Telegram).

Recent turns provide short-term continuity, while long-term memory comes from automatic capture and `/remember`. Older chat turns are removed from the active prompt when the configured Ollama context window is reached.

With `memory.summary.enabled: true` (the default), those removed turns are not lost outright: after each reply whose history overflowed the window, an async background pass folds the fallen-out turns into a compact rolling per-conversation summary (capped at `memory.summary.max_chars`, stored in `messages.db`), which is injected into the system context on later turns as an explicitly imperfect "Earlier Conversation" digest. Like automatic memory capture, the pass runs after the reply is sent and never blocks or fails a chat turn.

Previous attachment contents are not stored or resent. Only attachment metadata and the visible user message remain in history.

## Backups & Memory Hygiene

Two background maintenance tasks keep a long-running companion healthy. Both
are local-only, run one at a time, never block a chat turn, and log every run
to `scheduler_runs` in `tools.db` — visible in the web UI's **Activity** tab.

**Backups** (`backup.*`, default on, every 7 days): each run writes a dated
folder `backups/forge-backup-YYYYMMDD-HHmmss/` containing a live-safe online
copy of all four SQLite databases (`documents.db`, `memory.db`, `messages.db`,
`tools.db` — memories, message history, document chunks, audit logs) plus a
recursive copy of the `identity/` directory. That is everything that makes
your companion yours. After each run, only the newest `backup.keep` folders
are retained; older ones are pruned. The `backups/` directory is gitignored.
To restore, stop Forge and copy the `.db` files back into `dbs/` and the
identity files back into `identity/`.

**Memory consolidation** (`memory.consolidation.*`, default on, nightly):

- Near-duplicate cleanup: active memories whose embeddings (same local model)
  are at/above `dedupe_similarity` cosine similarity are collapsed — the newer
  memory is kept, the older is marked superseded with a history entry pointing
  at its replacement.
- Stale-auto archiving: auto-captured memories (tagged `auto`) that were never
  retrieved into a conversation (access count 0) and are older than
  `memory.retention_days` are archived.

Manual memories — anything you saved with `/remember` — are **never**
auto-archived or auto-superseded by the stale pass; only `auto`-tagged
memories age out. Superseded and archived memories disappear from the Memory
tab's default list (it shows active memories) but remain in `memory.db` with
full history.

## Privacy Model

Local by default:

- Chat and embedding calls go only to local Ollama.
- Memory, vectors, message history, tool/scheduler audit logs, document
  chunks, and generated images are all stored locally (SQLite + local dirs).
- Identity files are stored locally.
- Voice transcription and synthesis run as local CPU subprocesses.
- Image generation talks only to the local SD backend you configure.
- No tools can execute commands or write files; the only filesystem tools
  are read-only and confined to the `readable_dirs` allowlist, which
  defaults to empty.

Opt-in exceptions — each defaults OFF and is a deliberate switch:

- `tools.levels.network` + SearXNG: `web_search` queries your self-hosted
  SearXNG instance, whose upstream engines see the search terms; `fetch_url`
  fetches the one public URL it is given (private/loopback addresses refused).
- `channels.telegram`: messages transit Telegram's servers. Use the web UI
  when everything must stay on the machine.
- `llm.fallback`: when explicitly enabled, a failed local completion is
  retried against the configured cloud endpoint.

Everything the model does with reach is audit-logged: tool calls (allowed and
denied) in `tools.db`, scheduled runs in `scheduler_runs`, memory captures in
`memory_captures`.

### Threat Model

Forge assumes one trusted user on one trusted machine:

- The web server binds to localhost, protected by a single locally generated
  token (`logs/web-auth-token`). There are no user accounts: anyone who can
  reach the port with the token, or read the repo directory, is trusted. Do
  not bind it to other interfaces or port-forward it.
- The model is not trusted with enforcement. Model output is a proposal:
  every tool call is permission-gated at execution time, filesystem access is
  read-only against an allowlist that defaults to empty, and identity edits
  require your approval. This holds regardless of which model you configure —
  including uncensored community builds.
- Tool output is untrusted input. Web pages, fetched URLs, documents, and
  incoming Telegram messages can contain prompt injection. Containment is the
  permission gates and allowlists, not the model's judgment: a hostile page
  can influence what the model says, but not what it is allowed to do.
- The Telegram bridge only processes chats on `allowed_chat_ids`; anyone else
  gets a single reply naming their chat id (so you can allowlist yourself)
  and never reaches the pipeline.

Runtime state is gitignored:

- `dbs/`
- `logs/`
- `identity/`
- `images/`
- `backups/`
- `.env`

## Troubleshooting

First stop: ask the companion for its own status. With tools enabled, the
`get_status` tool (safe level) reports every feature's on/off state plus a
diagnostics map naming the exact blocker for anything unhealthy — a model tag
that is not pulled, an unreachable SearXNG or SD backend, an empty allowlist,
a disabled prerequisite level.

### Ollama Not Running

Start Ollama and run the configured model:

```powershell
ollama run <model-of-choice>
```

### Model Not Installed

If the Settings page says the selected model is missing, pull/run the model named in `llm.model`:

```powershell
ollama run <model-from-config>
```

### Embedding Model Not Installed Or Offline

Forge continues with FTS5-only memory recall when the embedding model is
missing or Ollama is offline. To enable semantic recall, pull the model named
in `memory.embeddings.model`, then enable that block in `forge.config.yaml`:

```powershell
ollama pull <embedding-model-from-config>
```

Use the **Memory** section of Settings to confirm embedding health and run a
reindex after enabling or changing the embedding model.

### Wrong Base URL

Check:

```yaml
llm:
  ollama:
    base_url: http://localhost:11434
```

### Port Already In Use

Stop the other process or change:

```yaml
services:
  web:
    port: 6800
```

### Auth Token Missing

Check:

```text
logs/web-auth-token
```

If needed, stop Forge, remove that file, and start Forge again to generate a new token.

### Model Slow Or Out Of Memory

Try a smaller model or lower Ollama context/generation settings:

```yaml
llm:
  ollama:
    options:
      num_ctx: 4096
      num_predict: 512
```

## Roadmap

Shipped:

- Local web companion shell with streaming chat (Ollama-only backend)
- Hybrid FTS5 + local-embedding memory, automatic capture, review/prune UI
- Identity files with model-proposed, user-approved changes
- Safe tool system: explicit permission levels, audit logs, user control
- Web search + page fetch via self-hosted SearXNG
- Document RAG with token-capped retrieval and source attribution
- Local CPU voice I/O (whisper.cpp + Piper)
- On-demand local image generation with SD/E4B VRAM handoff
- Telegram channel bridge over a generic adapter interface, with opt-in
  photo attachments routed to the vision tool
- Cron scheduler for unattended agent turns with channel delivery, plus
  one-shot reminders
- Rolling conversation summary so context survives the sliding window
- Read-only filesystem tools (`read_file`/`list_dir`) behind a directory
  allowlist
- An `analyze_image` vision tool backed by a dedicated local vision model
- `get_status` self-report with blocking diagnostics (what is off, and why)
- Activity tab: read-only audit views over tool calls, scheduled runs, and
  reminders
- Scheduled local backups, memory consolidation, and identity notes
  maintenance
- Identity prompt budget: oversized identity files truncate by priority
  instead of blocking chat

Possible next:

- WhatsApp Cloud adapter on the existing channel interface
- ANN index (e.g. sqlite-vec) behind the existing RAG retrieve() seam
- Autostart on login and a desktop shell (tray icon, own window)

## Development Notes

Useful checks:

```powershell
npm run typecheck
npm test
```

Principles to keep while extending:

- Local-first: anything that leaves the machine is a separate opt-in switch,
  default OFF.
- Deny-by-default permissions; every capability with reach gets an audit log.
- Model output is a proposal, tool output is untrusted data — validation and
  approval live in the substrate, never in the model.
- Failures degrade (structured errors, skipped passes), they never take chat
  down.
- No command execution. File access is read-only behind the allowlist gate;
  write access, if it ever ships, starts behind the same deny-by-default
  gates.

## License

MIT — see [LICENSE](LICENSE).
