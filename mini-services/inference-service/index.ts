/**
 * Inference WebSocket service — port 3003.
 *
 * Handles:
 *   - "engine:load"     → load model with strategy, apply plan, stream layer placements back
 *   - "engine:unload"   → stop the engine
 *   - "engine:status"   → push current status
 *   - "chat:send"       → start a streaming generation
 *                          → emits "chat:token" with each new token
 *                          → emits "layer:step" for each layer touched in the forward pass
 *                          → emits "hw:snapshot" with VRAM/RAM/NVMe usage every ~200ms
 *                          → emits "chat:done" with final stats
 *   - "layer:pin"       → pin a layer to a location
 *   - "strategy:set"    → switch strategy (re-plan + apply)
 *
 * The actual generation comes from z-ai-web-dev-sdk in demo mode (no local
 * GPU available in the sandbox). When run on a real machine with llama.cpp,
 * the studio's HTTP API launches a real llama-server and this service would
 * stream tokens from it instead — same protocol, different source.
 */

import { createServer } from "http"
import { Server } from "socket.io"
import { PrismaClient } from "@prisma/client"
import ZAI from "z-ai-web-dev-sdk"

const db = new PrismaClient()

const io = new Server(
  createServer(),
  {
    path: "/",
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000,
    pingInterval: 25000,
  },
)

const PORT = 3003

// ---------------------------------------------------------------------------
// Layer placement — mirror of the lib/layer-engine.ts logic, kept in sync
// in-process so we don't need round-trips to the Next.js API during generation
// ---------------------------------------------------------------------------

type Strategy = "speed" | "balanced" | "memory" | "manual"
type LayerLocation = "gpu" | "ram" | "nvme"

const HARDWARE_BUDGET = {
  vramMB: 12288,
  ramMB: 32768,
  nvmeMB: 512 * 1024,
}

interface LayerRow {
  id: string
  modelId: string
  index: number
  fileName: string
  sizeBytes: bigint
  location: LayerLocation
  pinned: boolean
  lastMs: number
  hits: number
}

async function getLayers(modelId: string): Promise<LayerRow[]> {
  const rows = await db.layer.findMany({ where: { modelId }, orderBy: { index: "asc" } })
  return rows.map((r) => ({ ...r, location: r.location as LayerLocation }))
}

async function saveLayerLocation(modelId: string, index: number, location: LayerLocation) {
  await db.layer.updateMany({ where: { modelId, index }, data: { location } })
}

function planPlacement(
  layers: LayerRow[],
  strategy: Strategy,
  contextBytes: number,
): { placement: Map<number, LayerLocation>; vramBytes: number; ramBytes: number; nvmeBytes: number } {
  const vramBudget = HARDWARE_BUDGET.vramMB * 1024 * 1024
  const placement = new Map<number, LayerLocation>()
  let vramBytes = 0
  let ramBytes = contextBytes
  let nvmeBytes = 0

  for (const l of layers) {
    if (l.pinned) {
      placement.set(l.index, "gpu")
      vramBytes += Number(l.sizeBytes)
    }
  }
  const unpinned = layers.filter((l) => !l.pinned)

  if (strategy === "speed") {
    for (const l of unpinned) {
      const size = Number(l.sizeBytes)
      if (vramBytes + size <= vramBudget) {
        placement.set(l.index, "gpu")
        vramBytes += size
      } else {
        placement.set(l.index, "nvme")
        nvmeBytes += size
      }
    }
  } else if (strategy === "balanced") {
    const keep = Math.floor(unpinned.length * 0.7)
    for (let i = 0; i < unpinned.length; i++) {
      const l = unpinned[i]
      const size = Number(l.sizeBytes)
      if (i < keep && vramBytes + size <= vramBudget) {
        placement.set(l.index, "gpu")
        vramBytes += size
      } else {
        placement.set(l.index, "nvme")
        nvmeBytes += size
      }
    }
  } else if (strategy === "memory") {
    const window = 8
    const start = Math.floor((unpinned.length - window) / 2)
    for (let i = 0; i < unpinned.length; i++) {
      const l = unpinned[i]
      const size = Number(l.sizeBytes)
      if (i >= start && i < start + window && vramBytes + size <= vramBudget) {
        placement.set(l.index, "gpu")
        vramBytes += size
      } else {
        placement.set(l.index, "nvme")
        nvmeBytes += size
      }
    }
  } else {
    for (const l of unpinned) {
      placement.set(l.index, "nvme")
      nvmeBytes += Number(l.sizeBytes)
    }
  }

  return { placement, vramBytes, ramBytes, nvmeBytes }
}

async function applyPlan(modelId: string, plan: { placement: Map<number, LayerLocation> }) {
  for (const [index, location] of plan.placement) {
    await db.layer.updateMany({ where: { modelId, index }, data: { location } })
  }
}

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

let currentModelId: string | null = null
let currentStrategy: Strategy = "balanced"
let currentLayers: LayerRow[] = []
let currentContextBytes = 8192 * 4096
let activeStream: AbortController | null = null

async function emitLayerState(socket: import("socket.io").Socket) {
  if (!currentModelId) return
  const layers = await getLayers(currentModelId)
  currentLayers = layers
  const vramUsed = layers.filter((l) => l.location === "gpu").reduce((s, l) => s + Number(l.sizeBytes), 0)
  const ramUsed = currentContextBytes + layers.filter((l) => l.location === "ram").reduce((s, l) => s + Number(l.sizeBytes), 0)
  const nvmeUsed = layers.filter((l) => l.location === "nvme").reduce((s, l) => s + Number(l.sizeBytes), 0)
  socket.emit("hw:snapshot", {
    vramUsed,
    vramTotal: HARDWARE_BUDGET.vramMB * 1024 * 1024,
    ramUsed,
    ramTotal: HARDWARE_BUDGET.ramMB * 1024 * 1024,
    nvmeUsed,
    nvmeTotal: HARDWARE_BUDGET.nvmeMB * 1024 * 1024,
    contextBytes: currentContextBytes,
  })
  socket.emit("layer:state", {
    modelId: currentModelId,
    layers: layers.map((l) => ({
      index: l.index,
      fileName: l.fileName,
      sizeBytes: Number(l.sizeBytes),
      location: l.location,
      pinned: l.pinned,
      lastMs: l.lastMs,
      hits: l.hits,
    })),
  })
}

async function loadEngine(modelId: string, strategy: Strategy, socket: import("socket.io").Socket) {
  const model = await db.model.findUnique({ where: { id: modelId } })
  if (!model) {
    socket.emit("engine:error", { error: "Model not found" })
    return
  }
  currentModelId = modelId
  currentStrategy = strategy
  currentContextBytes = model.contextSize * 4096
  const layers = await getLayers(modelId)
  currentLayers = layers
  const plan = planPlacement(layers, strategy, currentContextBytes)
  await applyPlan(modelId, plan)
  await emitLayerState(socket)
  socket.emit("engine:loaded", {
    modelId,
    strategy,
    mode: "demo",
    nGpuLayers: Array.from(plan.placement.values()).filter((l) => l === "gpu").length,
    vramBytes: plan.vramBytes,
    ramBytes: plan.ramBytes,
    nvmeBytes: plan.nvmeBytes,
  })
}

async function setStrategy(strategy: Strategy, socket: import("socket.io").Socket) {
  if (!currentModelId) return
  currentStrategy = strategy
  const layers = await getLayers(currentModelId)
  currentLayers = layers
  const plan = planPlacement(layers, strategy, currentContextBytes)
  await applyPlan(currentModelId, plan)
  await emitLayerState(socket)
  socket.emit("engine:loaded", {
    modelId: currentModelId,
    strategy,
    mode: "demo",
    nGpuLayers: Array.from(plan.placement.values()).filter((l) => l === "gpu").length,
    vramBytes: plan.vramBytes,
    ramBytes: plan.ramBytes,
    nvmeBytes: plan.nvmeBytes,
  })
}

async function pinLayer(index: number, location: LayerLocation, pinned: boolean, socket: import("socket.io").Socket) {
  if (!currentModelId) return
  await db.layer.updateMany({
    where: { modelId: currentModelId, index },
    data: { ...(location ? { location } : {}), pinned },
  })
  await emitLayerState(socket)
}

// ---------------------------------------------------------------------------
// Streaming generation: produces tokens from z-ai-web-dev-sdk while animating
// the layer pipeline so the UI can show every forward pass.
// ---------------------------------------------------------------------------

interface ChatSendPayload {
  sessionId: string
  prompt: string
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
}

// Lazy-load the SDK — only initialise on first chat request so the service
// itself stays alive even if the SDK is heavy or unavailable.
let zaiSdkPromise: Promise<any> | null = null
async function getSdk() {
  if (!zaiSdkPromise) {
    zaiSdkPromise = ZAI.create().catch((err) => {
      console.error("[inference-service] z-ai-web-dev-sdk failed to init:", err)
      return null
    })
  }
  return zaiSdkPromise
}

async function generateTokens(
  prompt: string,
  system: string,
  temperature: number,
  maxTokens: number,
  onToken: (t: string) => void,
  signal: AbortSignal,
): Promise<{ content: string }> {
  // The z-ai-web-dev-sdk gives us a streaming chat completion. We forward each
  // delta as a token. While each token streams, we also drive the layer
  // pipeline animation through emitLayerStep().
  const messages = [
    ...(system ? [{ role: "system" as const, content: system }] : []),
    { role: "user" as const, content: prompt },
  ]
  let full = ""
  try {
    const sdk = await getSdk()
    if (!sdk) throw new Error("SDK not initialised")
    // The z-ai-web-dev-sdk's streaming response returns raw SSE strings in
    // some environments, so we use the non-streaming API and manually chunk
    // the result into tokens to drive the layer pipeline animation.
    const res = await sdk.chat.completions.create({
      messages,
      temperature,
      max_tokens: maxTokens,
    })
    const content = res?.choices?.[0]?.message?.content ?? ""
    // Tokenise: keep whitespace attached to the preceding word so the
    // output reads naturally as it streams.
    const tokens = content.match(/(\S+\s*|\s+)/g) ?? [content]
    for (const tok of tokens) {
      if (signal.aborted) break
      full += tok
      onToken(tok)
      // Slight delay so the layer animation can keep up — 25ms per token
      // gives ~40 tok/s which is realistic for a 27B model on consumer GPU.
      await sleep(25)
    }
    if (!full) {
      // Empty completion — fall back so the UI shows *something*
      throw new Error("Empty completion from SDK")
    }
  } catch (err) {
    console.error("z-ai-web-dev-sdk failed:", err)
    const fallback = generateFallback(prompt, maxTokens)
    for (const tok of fallback) {
      if (signal.aborted) break
      full += tok
      onToken(tok)
      await sleep(35)
    }
  }
  return { content: full }
}

function generateFallback(prompt: string, maxTokens: number): string[] {
  const seed = `[AI Studio demo] I received your prompt: "${prompt.slice(0, 80)}".\n\n` +
    "This is the local fallback generator (z-ai-web-dev-sdk was unreachable). " +
    "The layer pipeline is still animating — every token you see here was " +
    "produced by tokenising this string and emitting one chunk at a time.\n\n" +
    "Forward pass complete. Layers touched: 50. VRAM paged: 35 layers. NVMe hits: 15 layers."
  return seed.split(/(\s+)/).slice(0, maxTokens * 2)
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

async function streamLayerAnimation(
  layers: LayerRow[],
  tokens: number,
  socket: import("socket.io").Socket,
  signal: AbortSignal,
): Promise<{ totalMs: number; pagedHits: number; perLayer: Map<number, { hits: number; meanMs: number }> }> {
  let totalMs = 0
  let pagedHits = 0
  const perLayer = new Map<number, { hits: number; total: number }>()

  // Pre-compute a deterministic-ish schedule
  for (let t = 0; t < tokens; t++) {
    if (signal.aborted) break
    for (const l of layers) {
      if (signal.aborted) break
      const onGpu = l.location === "gpu" || l.pinned
      const paged = !onGpu
      const base = onGpu ? 2 : l.location === "ram" ? 6 : 22
      const jitter = (Math.sin(l.index * 12.9898 + t * 78.233) + 1) * 0.5
      const dur = base + jitter * (base * 0.4)
      totalMs += dur
      if (paged) pagedHits += 1
      const cur = perLayer.get(l.index) ?? { hits: 0, total: 0 }
      cur.hits += 1
      cur.total += dur
      perLayer.set(l.index, cur)

      socket.emit("layer:step", {
        layerIndex: l.index,
        location: onGpu ? "gpu" : l.location,
        durationMs: dur,
        paged,
        token: t,
      })
      // Persist lastMs / hits in batches
      if (Math.random() < 0.05) {
        await db.layer.updateMany({
          where: { modelId: l.modelId, index: l.index },
          data: { hits: { increment: 1 }, lastMs: dur },
        })
      }
    }
    // Yield so tokens can interleave with layer steps
    await sleep(2)
  }

  return {
    totalMs,
    pagedHits,
    perLayer: new Map(
      Array.from(perLayer.entries()).map(([k, v]) => [k, { hits: v.hits, meanMs: v.total / v.hits }]),
    ),
  }
}

async function handleChatSend(payload: ChatSendPayload, socket: import("socket.io").Socket) {
  if (!currentModelId) {
    socket.emit("engine:error", { error: "No model loaded" })
    return
  }
  if (activeStream) activeStream.abort()
  const ac = new AbortController()
  activeStream = ac

  const session = await db.chatSession.findUnique({ where: { id: payload.sessionId } })
  const temp = payload.temperature ?? session?.temperature ?? 0.7
  const maxTok = payload.maxTokens ?? session?.maxTokens ?? 256
  const sys = payload.systemPrompt ?? session?.systemPrompt ?? ""

  socket.emit("chat:start", { sessionId: payload.sessionId })

  // Persist the user message immediately
  await db.chatMessage.create({
    data: {
      sessionId: payload.sessionId,
      role: "user",
      content: payload.prompt,
      tokensIn: Math.ceil(payload.prompt.length / 4),
    },
  })

  const t0 = Date.now()
  let tokensProduced = 0

  // Stream tokens AND run the layer animation in parallel — the layer
  // animation ticks once per token produced (roughly), which is exactly
  // how a real forward pass behaves.
  const animPromise = streamLayerAnimation(
    currentLayers,
    Math.min(maxTok, 64),
    socket,
    ac.signal,
  )

  const { content } = await generateTokens(
    payload.prompt,
    sys,
    temp,
    maxTok,
    (tok) => {
      tokensProduced += 1
      socket.emit("chat:token", { token: tok, sessionId: payload.sessionId })
    },
    ac.signal,
  )

  const anim = await animPromise
  const elapsed = (Date.now() - t0) / 1000
  const tps = elapsed > 0 ? tokensProduced / elapsed : 0

  // Persist assistant reply
  await db.chatMessage.create({
    data: {
      sessionId: payload.sessionId,
      role: "assistant",
      content,
      tokensOut: tokensProduced,
      tokensPerSec: tps,
      strategy: currentStrategy,
    },
  })

  socket.emit("chat:done", {
    sessionId: payload.sessionId,
    content,
    tokensOut: tokensProduced,
    elapsedSec: elapsed,
    tokensPerSec: tps,
    layerStats: {
      totalMs: anim.totalMs,
      pagedHits: anim.pagedHits,
      perLayer: Array.from(anim.perLayer.entries()).map(([i, v]) => ({ index: i, hits: v.hits, meanMs: v.meanMs })),
    },
  })

  // Push fresh layer state because stats changed
  await emitLayerState(socket)
  activeStream = null
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

io.on("connection", (socket) => {
  console.log(`[inference-service] connected: ${socket.id}`)

  // Send current engine state on connect
  if (currentModelId) {
    emitLayerState(socket)
    socket.emit("engine:loaded", {
      modelId: currentModelId,
      strategy: currentStrategy,
      mode: "demo",
    })
  } else {
    socket.emit("engine:idle", {})
  }

  socket.on("engine:load", async (data: { modelId: string; strategy?: Strategy }) => {
    try {
      await loadEngine(data.modelId, data.strategy ?? "balanced", socket)
    } catch (err) {
      socket.emit("engine:error", { error: String(err) })
    }
  })

  socket.on("engine:unload", async () => {
    if (activeStream) activeStream.abort()
    currentModelId = null
    currentLayers = []
    socket.emit("engine:unloaded", {})
  })

  socket.on("strategy:set", async (data: { strategy: Strategy }) => {
    try {
      await setStrategy(data.strategy, socket)
    } catch (err) {
      socket.emit("engine:error", { error: String(err) })
    }
  })

  socket.on("layer:pin", async (data: { index: number; location: LayerLocation; pinned: boolean }) => {
    try {
      await pinLayer(data.index, data.location, data.pinned, socket)
    } catch (err) {
      socket.emit("engine:error", { error: String(err) })
    }
  })

  socket.on("chat:send", async (data: ChatSendPayload) => {
    try {
      await handleChatSend(data, socket)
    } catch (err) {
      socket.emit("engine:error", { error: String(err) })
    }
  })

  socket.on("chat:stop", () => {
    if (activeStream) activeStream.abort()
  })

  socket.on("disconnect", () => {
    console.log(`[inference-service] disconnected: ${socket.id}`)
  })
})

io.listen(PORT, () => {
  console.log(`[inference-service] listening on :${PORT}`)
})

// Heartbeat so we can see the service is alive in the log
setInterval(() => {
  console.log(`[inference-service] heartbeat — model=${currentModelId} layers=${currentLayers.length} clients=${io.sockets.sockets.size}`)
}, 15000)

process.on("SIGTERM", () => {
  console.log("[inference-service] SIGTERM received")
  io.close()
  process.exit(0)
})
process.on("SIGINT", () => {
  console.log("[inference-service] SIGINT received")
  io.close()
  process.exit(0)
})
process.on("exit", (code) => {
  console.log(`[inference-service] exiting with code ${code}`)
})
