/**
 * Built-in model presets.
 *
 * The flagship preset is the layered Qwen3.8-27B-UD-Q4_K_XL mentioned by the user,
 * with the exact 50 layer files (layer-00000.gguf ... layer-00049.gguf) and the
 * approximate per-layer sizes the user pasted. These are used as a default seed
 * so the studio has something to visualise even before any download is started.
 */

export interface LayerPreset {
  index: number
  fileName: string
  sizeMB: number
}

export interface ModelPreset {
  repo: string
  name: string
  quant: string
  family: string
  contextSize: number
  layers: LayerPreset[]
  description: string
}

// Approximate per-layer sizes (in MB) taken from the user's HF repo listing.
const QWEN_LAYER_SIZES_MB = [
  236, 229, 233, 259, 243, 247, 260, 231, 229, 223,
  229, 228, 226, 216, 201, 215, 225, 234, 223, 219,
  257, 250, 258, 265, 279, 279, 275, 253, 268, 223,
  246, 233, 236, 229, 250, 251, 257, 255, 257, 260,
  267, 268, 268, 261, 223, 235, 232, 222, 261, 256,
]

function buildLayers(prefix: string, count: number, sizesMB: number[]): LayerPreset[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    fileName: `${prefix}-${String(i).padStart(5, "0")}.gguf`,
    sizeMB: sizesMB[i] ?? 230,
  }))
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    repo: "Qwen/Qwen3.8-27B-UD-Q4_K_XL-layers",
    name: "Qwen3.8-27B UD Q4_K_XL (Layered)",
    quant: "Q4_K_XL",
    family: "Qwen3",
    contextSize: 8192,
    description:
      "Layered Qwen3.8 27B model split across 50 .gguf shards (~12 GB total). " +
      "Each shard is one transformer block — the studio pages them between GPU VRAM, " +
      "system RAM (context) and NVMe (cold layers) on demand.",
    layers: buildLayers("layer", 50, QWEN_LAYER_SIZES_MB),
  },
  {
    repo: "bartowski/Qwen2.5-7B-Instruct-GGUF",
    name: "Qwen2.5-7B Instruct",
    quant: "Q4_K_M",
    family: "Qwen2.5",
    contextSize: 8192,
    description:
      "Compact 7B instruct model, single GGUF file. Useful as a smoke test before " +
      "pulling the full 27B layered variant.",
    layers: buildLayers("qwen2.5-7b", 32, Array.from({ length: 32 }, () => 180 + Math.floor(Math.random() * 60))),
  },
  {
    repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    name: "Llama-3.2-3B Instruct",
    quant: "Q4_K_M",
    family: "Llama3.2",
    contextSize: 4096,
    description:
      "Tiny Llama 3.2 3B model — runs on almost any GPU with 4 GB VRAM.",
    layers: buildLayers("llama-3.2-3b", 28, Array.from({ length: 28 }, () => 90 + Math.floor(Math.random() * 30))),
  },
]

export function findPreset(repo: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.repo === repo)
}

/** Recommended hardware budget for the studio (used by the layer engine). */
export const HARDWARE_BUDGET = {
  /** Mock VRAM budget when running without a real GPU — 12 GB */
  vramMB: 12288,
  /** Mock system RAM for KV cache / context — 32 GB */
  ramMB: 32768,
  /** Mock NVMe pager capacity — effectively unlimited, just for display */
  nvmeMB: 512 * 1024,
}
