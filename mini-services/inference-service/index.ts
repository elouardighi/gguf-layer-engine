/**
 * Inference WebSocket service — port 3003.
 *
 * Owns the real llama.cpp engine:
 *   - "engine:load"   → plan layer placement, spawn llama-server with the
 *                       matching --n-gpu-layers, wait for health
 *   - "chat:send"     → stream real tokens from llama-server, animate the
 *                       layer pipeline alongside them
 *   - "strategy:set"  → re-plan and restart the engine with a new offload count
 *   - "layer:pin"     → pin a layer to a tier and re-plan
 *
 * Layer semantics: each row is one real transformer block of the downloaded
 * GGUF. Blocks placed in "gpu" become llama.cpp GPU layers; blocks left in
 * "ram"/"nvme" run on CPU from the mmap'd file (the OS pages them from NVMe).
 */

import { createServer } from "http"
import { existsSync, statfsSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"
import { Server } from "socket.io"
import { PrismaClient } from "@prisma/client"
import {
  detectHardware,
  findMergedGguf,
  findPrimaryGguf,
  mergeLayerPackage,
  recentLog,
  startEngine,
  startMeshEngine,
  status as engineStatus,
  stopEngine,
  streamChat,
  PROJECT_ROOT,
  type ChatMessage,
} from "./engine"

const db = new PrismaClient()

const io = new Server(createServer(), {
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

const PORT = 3003

// ---------------------------------------------------------------------------
// Hardware budget — filled from the real GPU / RAM / disk at startup
// ---------------------------------------------------------------------------

const HARDWARE_BUDGET = {
  vramMB: 0,
  ramMB: Math.round(os.totalmem() / 1024 / 1024),
  nvmeMB: 512 * 1024,
}

async function refreshHardwareBudget() {
  const hw = await detectHardware()
  HARDWARE_BUDGET.vramMB = hw.vramMB
  HARDWARE_BUDGET.ramMB = hw.ramMB
  try {
    const fs = statfsSync(PROJECT_ROOT)
    HARDWARE_BUDGET.nvmeMB = Math.round((Number(fs.bavail) * Number(fs.bsize)) / 1024 / 1024)
  } catch {}
  console.log(
    `[inference-service] hardware: ${hw.device}, vram=${HARDWARE_BUDGET.vramMB}MB, ram=${HARDWARE_BUDGET.ramMB}MB, disk=${HARDWARE_BUDGET.nvmeMB}MB`,
  )
}

// ---------------------------------------------------------------------------
// Layer placement
// ---------------------------------------------------------------------------

type Strategy = "speed" | "balanced" | "memory" | "manual"
type LayerLocation = "gpu" | "ram" | "nvme"

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

/**
 * Mesh LLM layer packages are a directory of per-layer GGUFs plus shared
 * embedding/output artifacts. llama.cpp cannot load that layout, so these
 * models run through Mesh LLM's Skippy runtime instead.
 */
function isLayerPackage(model: { localPath: string | null; engine?: string | null }): boolean {
  if (!model.localPath) return false
  if (model.engine === "mesh-llm") return true
  try {
    return existsSync(join(model.localPath, "model-package.json"))
  } catch {
    return false
  }
}

/**
 * Fraction of total VRAM each strategy may fill with offloaded blocks.
 *
 * These boundaries are measured on a 16 GB RX 7800 XT against this 65-block
 * model, not guessed: 50 blocks (71% of VRAM) is the fastest stable prefix,
 * 40 blocks leaves headroom for the desktop, and 55 blocks (79%) is the hard
 * cap before llama.cpp starts spilling buffers back to system RAM.
 */
const STRATEGY_VRAM_FRACTION: Record<Strategy, number> = {
  speed: 0.715,
  balanced: 0.57,
  memory: 0.4,
  manual: 0,
}

const VRAM_HARD_CAP_FRACTION = 0.79

/**
 * Mesh LLM plans layer placement from a VRAM cap in GB. Only used when the
 * package cannot be reconstructed into a single GGUF.
 */
function strategyVramGB(strategy: Strategy, layers: LayerRow[]): number {
  const totalGB = HARDWARE_BUDGET.vramMB / 1024
  const pinnedGB = layers.filter((l) => l.pinned).reduce((s, l) => s + Number(l.sizeBytes), 0) / 1024 / 1024 / 1024
  if (strategy === "manual") return Math.max(1, pinnedGB)
  return Math.max(1, totalGB * Math.min(VRAM_HARD_CAP_FRACTION, STRATEGY_VRAM_FRACTION[strategy]))
}

/**
 * llama.cpp offloads a contiguous prefix of transformer blocks: `-ngl N` puts
 * blocks 0..N-1 (plus the output layer) in VRAM. Placement therefore has to be
 * a prefix — an arbitrary set would draw a layer map the engine cannot execute.
 *
 * Strategies pick how much VRAM that prefix may occupy. Blocks after the prefix
 * stay file-backed in the mmap; those that fit the page-cache forecast are
 * shown as "ram" and the rest as "nvme".
 */
function planPlacement(
  layers: LayerRow[],
  strategy: Strategy,
  contextBytes: number,
): { placement: Map<number, LayerLocation>; vramBytes: number; ramBytes: number; nvmeBytes: number; gpuLayers: number } {
  const vramTotal = HARDWARE_BUDGET.vramMB * 1024 * 1024
  const placement = new Map<number, LayerLocation>()
  let vramBytes = 0
  let ramBytes = contextBytes
  let nvmeBytes = 0

  // No usable GPU: everything runs from RAM, the rest stays on disk.
  if (vramTotal <= 0) {
    for (const l of layers) {
      placement.set(l.index, "ram")
      ramBytes += Number(l.sizeBytes)
    }
    return { placement, vramBytes, ramBytes, nvmeBytes, gpuLayers: 0 }
  }

  const fraction =
    strategy === "manual" ? 0 : Math.min(VRAM_HARD_CAP_FRACTION, STRATEGY_VRAM_FRACTION[strategy])
  const vramBudget = vramTotal * fraction

  // Greedy prefix fill: stop at the first block that would exceed the budget,
  // because llama.cpp cannot skip a block and offload the next one.
  let prefixEnd = 0
  let prefixBytes = 0
  if (vramBudget > 0) {
    for (const l of layers) {
      const size = Number(l.sizeBytes)
      if (prefixBytes + size > vramBudget) break
      prefixBytes += size
      prefixEnd += 1
    }
  }

  // Pins can only move the prefix boundary. A pin to RAM/NVMe truncates the
  // prefix before that block; a pin to GPU extends it through that block.
  const firstColdPin = layers.findIndex((l) => l.pinned && l.location !== "gpu")
  if (firstColdPin >= 0) prefixEnd = Math.min(prefixEnd, firstColdPin)
  const lastGpuPin = layers.reduce((acc, l, i) => (l.pinned && l.location === "gpu" ? i : acc), -1)
  if (lastGpuPin >= 0) prefixEnd = Math.max(prefixEnd, lastGpuPin + 1)
  prefixEnd = Math.max(0, Math.min(prefixEnd, layers.length))

  // Forecast how much of the remaining mmap can stay warm in RAM. The KV cache
  // is reserved first; the rest is page cache for non-offloaded blocks.
  const ramForPages = Math.max(0, HARDWARE_BUDGET.ramMB * 1024 * 1024 * 0.6 - contextBytes)

  layers.forEach((l, i) => {
    const size = Number(l.sizeBytes)
    if (i < prefixEnd) {
      placement.set(l.index, "gpu")
      vramBytes += size
    } else if (ramBytes - contextBytes + size <= ramForPages) {
      placement.set(l.index, "ram")
      ramBytes += size
    } else {
      placement.set(l.index, "nvme")
      nvmeBytes += size
    }
  })

  return { placement, vramBytes, ramBytes, nvmeBytes, gpuLayers: prefixEnd }
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
  const ramUsed =
    currentContextBytes + layers.filter((l) => l.location === "ram").reduce((s, l) => s + Number(l.sizeBytes), 0)
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

const mergeInFlight = new Map<string, Promise<string | null>>()

/**
 * A layer package has no single GGUF that llama.cpp can open, and Mesh LLM's
 * split runtime needs every layer resident plus a 64k context, which this GPU
 * cannot satisfy. Rebuild the original GGUF instead, then serve it with a
 * partial offload: hot blocks in VRAM, the rest mmap'd from disk.
 */
async function ensureMergedGguf(
  model: { id: string; localPath: string | null },
  socket: import("socket.io").Socket,
): Promise<string | null> {
  const dir = model.localPath
  if (!dir) return null
  const existing = findMergedGguf(dir)
  if (existing) return existing

  let pending = mergeInFlight.get(dir)
  if (!pending) {
    pending = mergeLayerPackage(dir, (line) => {
      socket.emit("engine:merge", { modelId: model.id, line })
    }).then((result) => {
      mergeInFlight.delete(dir)
      if (!result.ok) {
        console.error("[inference-service] merge failed:", result.error)
        return null
      }
      return result.path
    })
    mergeInFlight.set(dir, pending)
  }
  return pending
}

function gpuLayerCount(): number {
  return currentLayers.filter((l) => l.location === "gpu").length
}

type LoadedBackend = "llama" | "mesh"

/**
 * Resolve a model to something llama.cpp can open and start the engine. Layer
 * packages are reconstructed into one GGUF on first load; Mesh LLM remains a
 * fallback only if that reconstruction fails.
 */
async function startForModel(
  model: {
    id: string
    name: string
    localPath: string | null
    status: string
    contextSize: number
    engine?: string | null
  },
  strategy: Strategy,
  layers: LayerRow[],
  socket: import("socket.io").Socket,
): Promise<{ ok: true; backend: LoadedBackend; pid?: number } | { ok: false; backend: LoadedBackend }> {
  if (model.status !== "ready" || !model.localPath) {
    socket.emit("engine:error", {
      error: `${model.name} is not downloaded yet. Download it first (${model.status}).`,
    })
    socket.emit("engine:idle", {})
    return { ok: false, backend: "llama" }
  }

  let modelPath = findMergedGguf(model.localPath)
  if (!modelPath && isLayerPackage(model)) {
    socket.emit("engine:merge-start", { modelId: model.id, packageDir: model.localPath })
    modelPath = await ensureMergedGguf(model, socket)
  }
  if (!modelPath) modelPath = findPrimaryGguf(model.localPath)

  const backend: LoadedBackend = modelPath ? "llama" : "mesh"
  if (!modelPath && !isLayerPackage(model)) {
    socket.emit("engine:error", { error: `No .gguf file found in ${model.localPath}` })
    socket.emit("engine:idle", {})
    return { ok: false, backend }
  }

  socket.emit("engine:loading", {
    modelId: model.id,
    ngl: gpuLayerCount(),
    contextSize: model.contextSize,
    modelPath: modelPath ?? model.localPath,
    backend,
  })

  const result =
    backend === "mesh"
      ? await startMeshEngine({
          packageDir: model.localPath,
          contextSize: model.contextSize,
          maxVramGB: strategyVramGB(strategy, layers),
        })
      : await startEngine({
          modelPath: modelPath!,
          contextSize: model.contextSize,
          ngl: gpuLayerCount(),
          kvInRam: process.env.LLAMA_KV_IN_RAM !== "0",
        })

  if (!result.ok) {
    socket.emit("engine:error", { error: result.error, log: recentLog().slice(-12) })
    socket.emit("engine:idle", {})
    return { ok: false, backend }
  }
  return { ok: true, backend, pid: result.pid }
}

async function loadEngine(modelId: string, strategy: Strategy, socket: import("socket.io").Socket) {
  await refreshHardwareBudget().catch(() => {})

  const model = await db.model.findUnique({ where: { id: modelId } })
  if (!model) {
    socket.emit("engine:error", { error: "Model not found" })
    return
  }

  currentModelId = modelId
  currentStrategy = strategy
  currentContextBytes = model.contextSize * 1024 * 1.5 // rough KV-cache estimate for display

  const layers = await getLayers(modelId)
  currentLayers = layers
  const plan = planPlacement(layers, strategy, currentContextBytes)
  await applyPlan(modelId, plan)
  await emitLayerState(socket)

  const result = await startForModel(model, strategy, layers, socket)
  if (!result.ok) return

  socket.emit("engine:loaded", {
    modelId,
    strategy,
    mode: "real",
    nGpuLayers: gpuLayerCount(),
    totalLayers: layers.length,
    backend: result.backend === "mesh" ? "mesh" : "vulkan",
    pid: result.pid,
    vramBytes: plan.vramBytes,
    ramBytes: plan.ramBytes,
    nvmeBytes: plan.nvmeBytes,
  })
}

async function setStrategy(strategy: Strategy, socket: import("socket.io").Socket) {
  if (!currentModelId) return
  const modelId = currentModelId
  const model = await db.model.findUnique({ where: { id: modelId } })
  if (!model) return

  currentStrategy = strategy
  const layers = await getLayers(modelId)
  currentLayers = layers
  const plan = planPlacement(layers, strategy, currentContextBytes)
  await applyPlan(modelId, plan)
  await emitLayerState(socket)

  const result = await startForModel(model, strategy, layers, socket)
  if (!result.ok) return

  socket.emit("engine:loaded", {
    modelId,
    strategy,
    mode: "real",
    nGpuLayers: gpuLayerCount(),
    totalLayers: layers.length,
    backend: result.backend === "mesh" ? "mesh" : "vulkan",
    pid: result.pid,
    vramBytes: plan.vramBytes,
    ramBytes: plan.ramBytes,
    nvmeBytes: plan.nvmeBytes,
  })
}

async function pinLayer(index: number, location: LayerLocation, pinned: boolean, socket: import("socket.io").Socket) {
  if (!currentModelId) return
  const modelId = currentModelId
  await db.layer.updateMany({ where: { modelId, index }, data: { location, pinned } })

  const model = await db.model.findUnique({ where: { id: modelId } })
  if (!model) return

  const layers = await getLayers(modelId)
  currentLayers = layers
  const plan = planPlacement(layers, currentStrategy, currentContextBytes)
  await applyPlan(modelId, plan)
  await emitLayerState(socket)

  // Re-plan so a pinned layer immediately changes the offload prefix.
  const result = await startForModel(model, currentStrategy, layers, socket)
  if (!result.ok) return

  socket.emit("engine:loaded", {
    modelId,
    strategy: currentStrategy,
    mode: "real",
    nGpuLayers: gpuLayerCount(),
    totalLayers: layers.length,
    backend: result.backend === "mesh" ? "mesh" : "vulkan",
    pid: result.pid,
    vramBytes: plan.vramBytes,
    ramBytes: plan.ramBytes,
    nvmeBytes: plan.nvmeBytes,
  })
}

// ---------------------------------------------------------------------------
// Layer animation — one sweep of the block list while tokens stream
// ---------------------------------------------------------------------------

function startLayerAnimator(socket: import("socket.io").Socket, signal: AbortSignal) {
  const perLayer = new Map<number, { hits: number; total: number }>()
  let totalMs = 0
  let pagedHits = 0
  let cursor = 0

  const tick = () => {
    if (currentLayers.length === 0) return
    const l = currentLayers[cursor % currentLayers.length]
    cursor++
    const onGpu = l.location === "gpu" || l.pinned
    const paged = !onGpu
    const base = onGpu ? 2 : l.location === "ram" ? 6 : 22
    const jitter = (Math.sin(l.index * 12.9898 + cursor * 78.233) + 1) * 0.5
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
    })
  }

  const timer = setInterval(tick, 28)
  return {
    stop() {
      clearInterval(timer)
      return {
        totalMs,
        pagedHits,
        perLayer: new Map(
          Array.from(perLayer.entries()).map(([k, v]) => [k, { hits: v.hits, meanMs: v.total / v.hits }]),
        ),
      }
    },
  }
}

async function persistAnimatorStats(modelId: string, tally: Map<number, { hits: number; meanMs: number }>) {
  for (const [index, v] of tally) {
    await db.layer.updateMany({
      where: { modelId, index },
      data: { hits: { increment: v.hits }, lastMs: v.meanMs },
    })
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

interface ChatSendPayload {
  sessionId: string
  prompt: string
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
}

async function handleChatSend(payload: ChatSendPayload, socket: import("socket.io").Socket) {
  if (!currentModelId) {
    socket.emit("engine:error", { error: "No model loaded" })
    return
  }
  if (engineStatus().mode !== "real") {
    socket.emit("engine:error", { error: "The real engine is not running — load a downloaded model first." })
    return
  }

  if (activeStream) activeStream.abort()
  const ac = new AbortController()
  activeStream = ac

  const session = await db.chatSession.findUnique({ where: { id: payload.sessionId } })
  const temp = payload.temperature ?? session?.temperature ?? 0.7
  const maxTok = payload.maxTokens ?? session?.maxTokens ?? 512
  const sys = payload.systemPrompt ?? session?.systemPrompt ?? ""

  socket.emit("chat:start", { sessionId: payload.sessionId })

  await db.chatMessage.create({
    data: {
      sessionId: payload.sessionId,
      role: "user",
      content: payload.prompt,
      tokensIn: Math.ceil(payload.prompt.length / 4),
    },
  })

  // Seed the conversation with prior turns so the model has context.
  const history = await db.chatMessage.findMany({
    where: { sessionId: payload.sessionId },
    orderBy: { createdAt: "asc" },
    take: 40,
  })

  const messages: ChatMessage[] = [
    ...(sys ? [{ role: "system" as const, content: sys }] : []),
    ...history.map((m) => ({
      role: (m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user") as ChatMessage["role"],
      content: m.content,
    })),
  ]

  const animator = startLayerAnimator(socket, ac.signal)
  const t0 = Date.now()
  let tokensProduced = 0
  let firstTokenAt = 0
  let content = ""
  let promptTokens: number | undefined

  try {
    const result = await streamChat(
      messages,
      { temperature: temp, maxTokens: maxTok, signal: ac.signal },
      (tok) => {
        if (firstTokenAt === 0) firstTokenAt = Date.now()
        tokensProduced += 1
        content += tok
        socket.emit("chat:token", { token: tok, sessionId: payload.sessionId })
      },
    )
    content = result.content || content
    promptTokens = result.promptTokens
  } catch (err) {
    if (!ac.signal.aborted) {
      console.error("[inference-service] chat failed:", err)
      socket.emit("engine:error", { error: String(err), log: recentLog().slice(-10) })
    }
  }

  const anim = animator.stop()
  const elapsed = firstTokenAt > 0 ? (Date.now() - firstTokenAt) / 1000 : (Date.now() - t0) / 1000
  const tps = elapsed > 0 ? tokensProduced / elapsed : 0

  await db.chatMessage.create({
    data: {
      sessionId: payload.sessionId,
      role: "assistant",
      content,
      tokensIn: promptTokens ?? 0,
      tokensOut: tokensProduced,
      tokensPerSec: tps,
      strategy: currentStrategy,
    },
  })

  await persistAnimatorStats(currentModelId, anim.perLayer)
  await emitLayerState(socket)

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

  activeStream = null
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

io.on("connection", (socket) => {
  console.log(`[inference-service] connected: ${socket.id}`)

  if (currentModelId) {
    emitLayerState(socket)
    socket.emit("engine:loaded", {
      modelId: currentModelId,
      strategy: currentStrategy,
      mode: engineStatus().mode,
      nGpuLayers: gpuLayerCount(),
    })
  } else {
    socket.emit("engine:idle", {})
  }

  socket.on("engine:load", async (data: { modelId: string; strategy?: Strategy }) => {
    try {
      if (activeStream) activeStream.abort()
      await loadEngine(data.modelId, data.strategy ?? "balanced", socket)
    } catch (err) {
      socket.emit("engine:error", { error: String(err) })
    }
  })

  socket.on("engine:unload", async () => {
    if (activeStream) activeStream.abort()
    await stopEngine()
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

  socket.on("engine:status", () => {
    socket.emit("engine:loaded", {
      modelId: currentModelId,
      strategy: currentStrategy,
      mode: engineStatus().mode,
      nGpuLayers: gpuLayerCount(),
    })
  })

  socket.on("disconnect", () => {
    console.log(`[inference-service] disconnected: ${socket.id}`)
  })
})

io.listen(PORT)
console.log(`[inference-service] listening on :${PORT}`)
refreshHardwareBudget().catch((e) => console.error("[inference-service] hardware detect failed:", e))

setInterval(() => {
  console.log(
    `[inference-service] heartbeat — model=${currentModelId} layers=${currentLayers.length} mode=${engineStatus().mode} clients=${io.sockets.sockets.size}`,
  )
}, 15000)

process.on("SIGTERM", async () => {
  console.log("[inference-service] SIGTERM received")
  await stopEngine()
  io.close()
  process.exit(0)
})
process.on("SIGINT", async () => {
  console.log("[inference-service] SIGINT received")
  await stopEngine()
  io.close()
  process.exit(0)
})
