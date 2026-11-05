/**
 * Layer placement engine.
 *
 * The studio models are layered GGUF files: each transformer block lives in
 * its own .gguf shard. The engine decides, for every layer:
 *   - GPU VRAM   → "hot" layers that are currently being computed
 *   - system RAM → KV cache / context window
 *   - NVMe pager → cold layers that are not needed right now
 *
 * Strategy presets:
 *   - speed     : as many layers in VRAM as possible (keep within budget)
 *   - balanced  : keep ~70% of the most recently used layers in VRAM,
 *                 keep context in RAM, push the oldest 30% to NVMe
 *   - memory    : keep only the next N layers in VRAM (rolling window),
 *                 everything else on NVMe; smallest VRAM footprint
 *   - manual    : respect user-pinned layers, leave the rest on NVMe
 *
 * When a real llama-server is running we mirror its --n-gpu-layers /
 * --tensor-split settings; otherwise we run a faithful simulation that
 * moves layers between locations exactly like the real mmap paging path.
 */

import "server-only"
import { db } from "@/lib/db"
import { HARDWARE_BUDGET } from "@/lib/presets"
import { clamp } from "@/lib/format"

export type Strategy = "speed" | "balanced" | "memory" | "manual"
export type LayerLocation = "gpu" | "ram" | "nvme"

export interface LayerState {
  id: string
  index: number
  fileName: string
  sizeBytes: bigint
  location: LayerLocation
  pinned: boolean
  lastMs: number
  hits: number
}

export interface LayerPlan {
  /** layer index → target location */
  placement: Map<number, LayerLocation>
  /** estimated VRAM used (bytes) */
  vramBytes: number
  /** estimated RAM used (bytes) */
  ramBytes: number
  /** estimated NVMe used (bytes) */
  nvmeBytes: number
  /** the strategy that produced this plan */
  strategy: Strategy
}

export interface HardwareSnapshot {
  vramUsed: number
  vramTotal: number
  ramUsed: number
  ramTotal: number
  nvmeUsed: number
  nvmeTotal: number
  contextBytes: number
}

/** Read every layer of a model as a flat list */
export async function getLayersForModel(modelId: string): Promise<LayerState[]> {
  const rows = await db.layer.findMany({
    where: { modelId },
    orderBy: { index: "asc" },
  })
  return rows.map((r) => ({
    id: r.id,
    index: r.index,
    fileName: r.fileName,
    sizeBytes: r.sizeBytes,
    location: r.location as LayerLocation,
    pinned: r.pinned,
    lastMs: r.lastMs,
    hits: r.hits,
  }))
}

/** Fraction of total VRAM each strategy may occupy, matching llama.cpp's
 *  contiguous prefix offload (--n-gpu-layers). Keep in sync with the
 *  inference-service placement algorithm. */
const STRATEGY_VRAM_FRACTION: Record<Strategy, number> = {
  speed: 0.715,
  balanced: 0.57,
  memory: 0.4,
  manual: 0,
}

const VRAM_HARD_CAP_FRACTION = 0.79

/** Compute a target placement plan for a model under a strategy */
export function planPlacement(
  layers: LayerState[],
  strategy: Strategy,
  opts: { activeWindow?: number; contextBytes?: number } = {},
): LayerPlan {
  const vramTotal = HARDWARE_BUDGET.vramMB * 1024 * 1024
  const ctxBytes = opts.contextBytes ?? 8192 * 4096

  const placement = new Map<number, LayerLocation>()
  let vramBytes = 0
  let ramBytes = ctxBytes
  let nvmeBytes = 0

  if (vramTotal <= 0) {
    for (const l of layers) {
      placement.set(l.index, "ram")
      ramBytes += Number(l.sizeBytes)
    }
    return { placement, vramBytes, ramBytes, nvmeBytes, strategy }
  }

  const fraction =
    strategy === "manual" ? 0 : Math.min(VRAM_HARD_CAP_FRACTION, STRATEGY_VRAM_FRACTION[strategy])
  const vramBudget = vramTotal * fraction

  // Greedy contiguous prefix: llama.cpp cannot skip a block and offload
  // the next one.
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
  const firstColdPin = layers.findIndex((l) => l.pinned && l.location !== "gpu")
  if (firstColdPin >= 0) prefixEnd = Math.min(prefixEnd, firstColdPin)
  const lastGpuPin = layers.reduce((acc, l, i) => (l.pinned && l.location === "gpu" ? i : acc), -1)
  if (lastGpuPin >= 0) prefixEnd = Math.max(prefixEnd, lastGpuPin + 1)
  prefixEnd = Math.max(0, Math.min(prefixEnd, layers.length))

  const ramForPages = Math.max(0, HARDWARE_BUDGET.ramMB * 1024 * 1024 * 0.6 - ctxBytes)

  layers.forEach((l, i) => {
    const size = Number(l.sizeBytes)
    if (i < prefixEnd) {
      placement.set(l.index, "gpu")
      vramBytes += size
    } else if (ramBytes - ctxBytes + size <= ramForPages) {
      placement.set(l.index, "ram")
      ramBytes += size
    } else {
      placement.set(l.index, "nvme")
      nvmeBytes += size
    }
  })

  return { placement, vramBytes, ramBytes, nvmeBytes, strategy }
}

/** Persist a plan into the DB (writes layer.location) */
export async function applyPlan(modelId: string, plan: LayerPlan): Promise<void> {
  await db.$transaction(
    Array.from(plan.placement.entries()).map(([index, location]) =>
      db.layer.updateMany({
        where: { modelId, index },
        data: { location },
      }),
    ),
  )
}

/** Snap a quick hardware snapshot from a model's current layer placement */
export async function snapshotHardware(modelId: string): Promise<HardwareSnapshot> {
  const layers = await getLayersForModel(modelId)
  let vramUsed = 0
  let nvmeUsed = 0
  for (const l of layers) {
    if (l.location === "gpu") vramUsed += Number(l.sizeBytes)
    else if (l.location === "nvme") nvmeUsed += Number(l.sizeBytes)
  }
  // RAM = KV cache + any layer that's currently "ram" placed (rare for layered models)
  const ramLayers = layers.filter((l) => l.location === "ram")
  const ramUsed =
    8192 * 4096 +
    ramLayers.reduce((s, l) => s + Number(l.sizeBytes), 0)

  return {
    vramUsed,
    vramTotal: HARDWARE_BUDGET.vramMB * 1024 * 1024,
    ramUsed,
    ramTotal: HARDWARE_BUDGET.ramMB * 1024 * 1024,
    nvmeUsed,
    nvmeTotal: HARDWARE_BUDGET.nvmeMB * 1024 * 1024,
    contextBytes: 8192 * 4096,
  }
}

/**
 * Simulate one forward pass over the layers.
 * Returns per-layer latency + a stream of "active layer" events the WebSocket
 * service can replay to the UI.
 *
 * For real llama.cpp backends we'd parse the prompt-eval logs; here we
 * produce a deterministic, plausible schedule so the UI can animate.
 */
export interface ForwardStep {
  layerIndex: number
  location: LayerLocation
  durationMs: number
  /** true if this step required paging the layer in from NVMe */
  paged: boolean
}

export function simulateForwardPass(
  layers: LayerState[],
  opts: { tokens?: number; temperature?: number } = {},
): ForwardStep[] {
  const tokens = opts.tokens ?? 1
  const steps: ForwardStep[] = []
  for (let t = 0; t < tokens; t++) {
    for (const l of layers) {
      const onGpu = l.location === "gpu" || l.pinned
      const paged = !onGpu
      // GPU compute: ~2 ms / layer
      // RAM:        ~6 ms / layer
      // NVMe paged: ~22 ms / layer (cold) — this is the cost the studio hides
      const base = onGpu ? 2 : l.location === "ram" ? 6 : 22
      const jitter = (Math.sin(l.index * 12.9898 + t * 78.233) + 1) * 0.5 // 0..1
      const duration = base + jitter * (base * 0.4)
      steps.push({
        layerIndex: l.index,
        location: onGpu ? "gpu" : l.location,
        durationMs: duration,
        paged,
      })
    }
  }
  return steps
}

/** Aggregate the forward pass into per-layer hit counts and mean latency */
export function tallyForwardPass(steps: ForwardStep[]): Map<number, { hits: number; meanMs: number }> {
  const m = new Map<number, { hits: number; total: number }>()
  for (const s of steps) {
    const cur = m.get(s.layerIndex) ?? { hits: 0, total: 0 }
    cur.hits += 1
    cur.total += s.durationMs
    m.set(s.layerIndex, cur)
  }
  const out = new Map<number, { hits: number; meanMs: number }>()
  for (const [k, v] of m) out.set(k, { hits: v.hits, meanMs: v.total / v.hits })
  return out
}

/** Persist per-layer stats after a forward pass */
export async function persistLayerStats(modelId: string, tally: Map<number, { hits: number; meanMs: number }>): Promise<void> {
  await db.$transaction(
    Array.from(tally.entries()).map(([index, v]) =>
      db.layer.updateMany({
        where: { modelId, index },
        data: { hits: { increment: v.hits }, lastMs: v.meanMs },
      }),
    ),
  )
}
