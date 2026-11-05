# gguf-layer-engine — Layered AI Studio

A web studio for running **huge GGUF models on consumer GPUs**. It reconstructs a
split *layer package* into a single mmap-able GGUF, serves it with llama.cpp using
strategy-driven partial offload, and shows you exactly where every transformer layer
is living — **GPU, RAM, or NVMe** — with per-layer latency while tokens stream.

Real inference only: the **engine: Real** badge in the top bar means llama.cpp is
doing the work. There is no mock/demo token path in this build.

> Reference model: `meshllm/Qwen3.8-Flash-Next-UD-IQ4_XS-layers` — 48 layers,
> UD-IQ4_XS quantization, ~90 GB as a 3-part split package. On a 16 GB RX 7800 XT
> that means a small prefix of layers on the GPU and the rest running from RAM/NVMe
> (≈1 tok/s decode). The whole point of this app is to make that trade-off visible,
> measurable and controllable instead of hiding it.

## Features

- **Auto-merge of layer packages** — `scripts/merge-layer-package.ts` folds the 51
  partial GGUFs of a package into one file llama.cpp can mmap. Duplicate
  `output_hc_*` hyper-connection tensors (copied into every part) are routed by
  locator-offset equation with a byte-compare guard, so all 1224 tensors resolve
  uniquely. Runs automatically on first **Load**, progress is shown in the Chat
  panel, the result is cached under `models/<slug>/merged/` and never re-merged.
- **Offload strategies** — Speed / Balanced / Memory / Manual VRAM budgets, backed
  by measured boundaries (see below). Switching strategy re-plans placement and
  restarts llama-server with the new `-ngl`.
- **Live layer map** — every layer color-coded by location (GPU / RAM / NVMe) with
  its measured latency (e.g. `2.5 ms` on GPU vs `30 ms` paged from NVMe). Click a
  layer to pin it to the GPU, shift-click to unpin (Manual strategy).
- **Streaming chat** — temp / max-tokens controls, real `tok · tok/s` stats per
  reply, persisted through Prisma + SQLite.
- **Model browser** — public Hugging Face GGUF repos only (no token required),
  with download progress.
- **Engine control** — Load / **Unload** / reload from the Chat panel header,
  live heartbeats (`mode=real`), hardware monitor and raw inference log.

## Architecture

```
Browser ── http://localhost:3000 ──▶ Next.js (Studio UI)
   │                                  │
   │                    src/instrumentation.ts spawns on boot
   │                                  ▼
   └── WebSocket ─────────▶ inference-service (bun, :3003, socket.io, path "/")
                                │  engine:load / engine:unload / strategy:set
                                │  chat:send → streamed tokens / heartbeats
                                ├── scripts/merge-layer-package.ts  (first load)
                                ├── Prisma + SQLite (db/custom.db)  (models, chats)
                                └── HTTP ▶ llama-server (llama.cpp Vulkan build, :8080)
                                                ▲
                     -ngl <prefix> in VRAM · tail stays in the OS mmap
                     (page-cache RAM, cold layers paged from NVMe)
```

llama.cpp can only offload a **contiguous prefix** of blocks (`-ngl N` puts blocks
`0..N-1` on the GPU), so each strategy computes the largest prefix that fits its
VRAM budget; everything after the prefix stays file-backed in the mmap and the UI
forecasts which of those pages will fit in RAM versus NVMe.

## Requirements

- **[bun](https://bun.sh)** ≥ 1.4 — runs both the dev server and the inference service
- **llama.cpp `llama-server`** (Vulkan build) at `bin/llama/llama-server[.exe]`, or
  `bin/llama-server[.exe]`, or point `LLAMA_SERVER_BIN` at it — `bin/` is gitignored
- **A GPU with Vulkan** (Radeon RX 7800 XT 16 GB is the measured reference; without
  a usable GPU the engine falls back to RAM/NVMe placement)
- **Disk** for the split package *and* its merged copy (~2× model size)
- Model weights under `models/` (gitignored) in the HF layer-package layout — use
  the in-app browser to fetch public GGUF repos

## Quick start

```powershell
git clone https://github.com/elouardighi/gguf-layer-engine.git
cd gguf-layer-engine
bun install
bun run db:push      # create/refresh db/custom.db from prisma/schema.prisma
bun run dev          # Studio at http://localhost:3000
```

A `.env` is committed with the two required keys (no secrets — it's a local DB path
and a localhost URL); if you ever delete it, recreate it:

```ini
DATABASE_URL="file:../db/custom.db?connection_limit=1&socket_timeout=30"
NEXT_PUBLIC_WS_URL=http://127.0.0.1:3003
```

Then: open <http://localhost:3000> → click the model card → **Load into engine** →
the first load merges the package (progress in the Chat panel) → llama-server boots
(~45 s for a 90 GB model) → chat.

## Offload strategies

VRAM budget as a fraction of total VRAM (hard cap 79% — beyond it llama.cpp starts
spilling buffers back to system RAM). Boundaries were **measured** on a 16 GB
RX 7800 XT, not guessed: the fastest stable prefix fills ~71% of the card, ~57%
leaves headroom for the desktop, ~40% is the conservative setting.

| Strategy | VRAM budget | Reference model on 16 GB (48 layers) |
|----------|-------------|--------------------------------------|
| **Speed**    | 71.5% | 8 layers on GPU — fastest stable prefix |
| **Balanced** | 57%   | 6 layers on GPU — desktop-friendly headroom |
| **Memory**   | 40%   | smallest GPU prefix, most RAM headroom |
| **Manual**   | 0%    | only the layers you pin in the visualizer |

The strategy is persisted per model; changing it while the engine runs re-plans the
map immediately and restarts llama-server with the new offload count.

## Ports & configuration

| Port | What |
|------|------|
| 3000 | Next.js Studio (`bun run dev`) |
| 3003 | inference-service (socket.io, `path: "/"`), auto-spawned by `src/instrumentation.ts` |
| 8080 | llama-server HTTP (`LLAMA_PORT`) |

Environment variables (`.env`):

| Key | Purpose |
|-----|---------|
| `DATABASE_URL` | Prisma/SQLite connection (ships with `db/custom.db`) |
| `NEXT_PUBLIC_WS_URL` | **Direct WebSocket URL of the inference service.** The client falls back to `/?XTransformPort=3003`, which only works behind a Caddy proxy on `:81` (see `Caddyfile`) — without that proxy the socket silently never connects |
| `LLAMA_SERVER_BIN` | Override the llama-server binary location |
| `LLAMA_PORT` | llama-server port (default `8080`) |

## Performance expectations (honest numbers)

For the ~90 GB reference model on 16 GB VRAM / 16 GB RAM:

- **First token: 30–140 s** (page-cache warm-up; slower while RAM is tight)
- **Decode: ≈0.8–1.1 tok/s** — 42 of 48 layers execute on CPU at ~23 ms per layer
  per token

That is the hardware ceiling for 90 GB against ~11 GB of usable VRAM, not a bug in
the app. Strategies trade decode speed for headroom; the layer map shows exactly
where the time goes.

## Troubleshooting

- **Buttons do nothing / top bar says `offline`** — the WebSocket isn't connected.
  Check `NEXT_PUBLIC_WS_URL` in `.env`. This was the original "Load button dead"
  bug: the old `XTransformPort` path needs a Caddy proxy on `:81` that wasn't
  running, so every `engine:*` event was buffered forever.
- **`ErrorOutOfDeviceMemory` right after Unload → Load** — the previous instance
  hasn't released VRAM yet. The service retries automatically; or wait a few
  seconds before reloading.
- **The merge starts over** — keep `models/<slug>/merged/` including `merge.json`;
  it is skipped entirely when the merged GGUF exists.
- **`llama-server not found`** — put the Vulkan build at `bin/llama/llama-server[.exe]`
  or set `LLAMA_SERVER_BIN`.

## Project layout

```
src/
  app/                    Studio pages + REST routes (models, HF download, sessions)
  components/studio/      TopBar, ModelBrowser, ChatPanel, LayerVisualizer,
                          LayerControls, HardwareMonitor, InferenceLog
  hooks/use-studio.ts     Zustand store — socket client, engine state, chat stream
  lib/                    layer-engine (placement planning), gguf, hf, llama, presets
  instrumentation.ts      spawns the inference service on Next.js boot
mini-services/
  inference-service/
    index.ts              socket.io server: load/unload/strategy/chat + VRAM plans
    engine.ts             merge orchestration + llama-server process control
scripts/
  merge-layer-package.ts  split package → single GGUF (locator-offset routing)
  model-download.ts       HF GGUF downloader
prisma/                   schema.prisma → db/custom.db (SQLite, committed)
models/                   gitignored: layer packages + merged/*.merged.gguf cache
bin/                      gitignored: llama.cpp / mesh binaries
```

## Scope notes

- The mesh-split serving path (`bin/mesh/mesh-llm`) is kept for reference; the
  **single merged GGUF + llama.cpp offload** path is what actually serves traffic.
- SQLite chat history ships in `db/custom.db` — reset with `bun run db:reset` if
  you want a clean slate.

## License

No license file yet — all rights reserved by default. Add one before accepting
contributions.
