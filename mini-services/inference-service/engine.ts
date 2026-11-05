/**
 * llama.cpp engine controller for the inference service.
 *
 * Spawns the real `llama-server` binary (Vulkan build) with a layer offload
 * count derived from the studio's placement plan, waits for /health, and
 * streams real chat completions back to the UI.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import os from "node:os"

const SERVICE_DIR = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = join(SERVICE_DIR, "..", "..")

const BIN_NAME = process.platform === "win32" ? "llama-server.exe" : "llama-server"
export const LLAMA_SERVER_BIN =
  process.env.LLAMA_SERVER_BIN ??
  [
    join(PROJECT_ROOT, "bin", "llama", BIN_NAME),
    join(PROJECT_ROOT, "bin", BIN_NAME),
  ].find((p) => existsSync(p)) ??
  BIN_NAME

export const LLAMA_HOST = "127.0.0.1"
export const LLAMA_PORT = Number(process.env.LLAMA_PORT ?? 8080)
export const LLAMA_ENDPOINT = `http://${LLAMA_HOST}:${LLAMA_PORT}`
export const MESH_PORT = Number(process.env.MESH_PORT ?? 9337)
export const MESH_ENDPOINT = `http://${LLAMA_HOST}:${MESH_PORT}`

export type EngineMode = "real" | "demo" | "unknown"
export type EngineBackend = "llama" | "mesh"

const MESH_BIN =
  process.env.MESH_LLM_BIN ??
  [
    join(PROJECT_ROOT, "bin", "mesh", "mesh-bundle", process.platform === "win32" ? "mesh-llm.exe" : "mesh-llm"),
    join(PROJECT_ROOT, "bin", "mesh", process.platform === "win32" ? "mesh-llm.exe" : "mesh-llm"),
  ].find((p) => existsSync(p)) ??
  "mesh-llm"

interface EngineStatus {
  mode: EngineMode
  running: boolean
  backend: EngineBackend
  pid?: number
  ngl?: number
  contextSize?: number
  port?: number
}

let child: ChildProcess | null = null
let currentMode: EngineMode = "unknown"
let currentBackend: EngineBackend = "llama"
let currentNgl = 0
let currentCtx = 0
let currentEndpoint = LLAMA_ENDPOINT
let currentModelName = ""
let logTail: string[] = []

function pushLog(line: string) {
  logTail.push(line)
  if (logTail.length > 60) logTail.shift()
}

export function status(): EngineStatus {
  return {
    mode: currentMode,
    running: child !== null,
    backend: currentBackend,
    pid: child?.pid,
    ngl: currentNgl,
    contextSize: currentCtx,
    port: currentBackend === "mesh" ? MESH_PORT : LLAMA_PORT,
  }
}

export function recentLog(): string[] {
  return [...logTail]
}

export function serverAvailable(): boolean {
  return existsSync(LLAMA_SERVER_BIN) || !LLAMA_SERVER_BIN.includes("\\")
}

export function findPrimaryGguf(dir: string): string | null {
  try {
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".gguf"))
    if (files.length === 0) return null
    const firstShard = files.find((f) => /-00001-of-\d+\.gguf$/i.test(f))
    return join(dir, firstShard ?? files.sort()[0])
  } catch {
    return null
  }
}

/**
 * A Mesh LLM layer package can be reconstructed into one GGUF (see
 * scripts/merge-layer-package.ts). When that derived file exists we prefer it:
 * llama.cpp can then mmap it and partially offload layers, which is the only
 * way to run a 65-layer package on a single 16 GB GPU.
 */
export function findMergedGguf(dir: string): string | null {
  try {
    const mergedDir = join(dir, "merged")
    if (!existsSync(mergedDir)) return null
    const files = readdirSync(mergedDir).filter((f) => f.toLowerCase().endsWith(".gguf"))
    if (files.length === 0) return null
    const preferred = files.find((f) => f.toLowerCase().endsWith(".merged.gguf")) ?? files.sort()[0]
    return join(mergedDir, preferred)
  } catch {
    return null
  }
}

/**
 * Reconstruct a layer package into a single GGUF so llama.cpp can mmap and
 * partially offload it. The merge is a pure byte-range copy driven by the
 * package's own tensor spine, so it is lossless; see
 * scripts/merge-layer-package.ts.
 */
export async function mergeLayerPackage(
  packageDir: string,
  onLog?: (line: string) => void,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const existing = findMergedGguf(packageDir)
  if (existing) return { ok: true, path: existing }

  const script = join(PROJECT_ROOT, "scripts", "merge-layer-package.ts")
  if (!existsSync(script)) return { ok: false, error: `Merge script not found: ${script}` }

  // The script is TypeScript, so it must run under Bun. `process.execPath` is
  // Bun when the service itself runs under Bun; otherwise fall back to `bun`.
  const runner = process.versions.bun ? process.execPath : (process.env.BUN_BIN ?? "bun")
  console.log(`[engine] merging layer package ${packageDir}`)
  const proc = spawn(runner, [script, packageDir], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    cwd: PROJECT_ROOT,
  })

  let failure = ""
  const absorb = (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (!line.trim()) continue
      pushLog(line)
      if (/failed|error/i.test(line)) failure = line
      onLog?.(line)
    }
  }
  proc.stdout?.on("data", absorb)
  proc.stderr?.on("data", absorb)

  const code = await new Promise<number | null>((resolve) => {
    proc.on("error", (err) => {
      failure = String(err)
      resolve(null)
    })
    proc.on("exit", (c) => resolve(c))
  })

  if (code !== 0) return { ok: false, error: failure || `merge exited with code ${code}` }
  const merged = findMergedGguf(packageDir)
  if (!merged) return { ok: false, error: "merge finished but no merged GGUF was found" }
  console.log(`[engine] merged package -> ${merged}`)
  return { ok: true, path: merged }
}

/** Ask llama.cpp how much VRAM the selected device really has. */
let hwPromise: Promise<{ vramMB: number; ramMB: number; device: string }> | null = null
export function detectHardware() {
  if (!hwPromise) {
    hwPromise = (async () => {
      const ramMB = Math.round(os.totalmem() / 1024 / 1024)
      let vramMB = Number(process.env.LLAMA_VRAM_MB ?? 0)
      let device = "CPU"
      if (!vramMB && existsSync(LLAMA_SERVER_BIN)) {
        try {
          const out = await new Promise<string>((resolve) => {
            const p = spawn(LLAMA_SERVER_BIN, ["--list-devices"], { windowsHide: true })
            let buf = ""
            p.stdout?.on("data", (d) => (buf += d))
            p.stderr?.on("data", (d) => (buf += d))
            p.on("exit", () => resolve(buf))
            p.on("error", () => resolve(""))
          })
          const m = out.match(/(Vulkan0|CUDA0|ROCm0):\s*([^(]+)\((\d+)\s*MiB/)
          if (m) {
            device = m[2].trim()
            vramMB = Number(m[3])
          }
        } catch {}
      }
      return { vramMB, ramMB, device }
    })()
  }
  return hwPromise
}

export async function startEngine(opts: {
  modelPath: string
  contextSize: number
  ngl: number
  threads?: number
  kvInRam?: boolean
}): Promise<{ ok: true; pid?: number } | { ok: false; error: string }> {
  await stopEngine()

  if (!existsSync(LLAMA_SERVER_BIN) && LLAMA_SERVER_BIN.includes("\\")) {
    return { ok: false, error: `llama-server not found at ${LLAMA_SERVER_BIN}` }
  }

  const ngl = Math.max(0, Math.min(opts.ngl, 999))
  const ctx = Math.max(512, Math.min(opts.contextSize, 131072))
  const threads = opts.threads ?? Math.max(1, Math.floor(os.cpus().length / 2))

  const args = [
    "-m", opts.modelPath,
    "--host", LLAMA_HOST,
    "--port", String(LLAMA_PORT),
    "-c", String(ctx),
    "-ngl", String(ngl),
    "-t", String(threads),
    "--parallel", "1",
    "--no-webui",
    "--jinja",
    // Flash attention accepts an optional on|off|auto value; passing it bare
    // makes llama.cpp consume the next flag as the value.
    "-fa", "auto",
    // Keep the KV cache (the model's "context") in system RAM, as the studio
    // promises: only the transformer layers live in VRAM.
    ...(opts.kvInRam === false ? [] : ["--no-kv-offload"]),
  ]

  console.log("[engine] spawning", LLAMA_SERVER_BIN, args.join(" "))
  logTail = []

  const proc = spawn(LLAMA_SERVER_BIN, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  })
  child = proc
  currentBackend = "llama"
  currentEndpoint = LLAMA_ENDPOINT

  const absorb = (data: Buffer) => {
    const text = data.toString()
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      pushLog(line)
      if (/error|failed|load|offload|VRAM|device|listening|server is/i.test(line)) {
        console.log("[llama]", line)
      }
    }
  }
  proc.stdout?.on("data", absorb)
  proc.stderr?.on("data", absorb)

  proc.on("exit", (code) => {
    console.log(`[engine] llama-server exited code=${code}`)
    if (child === proc) {
      child = null
      currentMode = "unknown"
    }
  })
  proc.on("error", (err) => {
    console.error("[engine] spawn error:", err)
    pushLog(String(err))
    if (child === proc) {
      child = null
      currentMode = "unknown"
    }
  })

  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (!child) {
      return { ok: false, error: `llama-server exited during load\n${logTail.slice(-6).join("\n")}` }
    }
    try {
      const res = await fetch(`${LLAMA_ENDPOINT}/health`, { signal: AbortSignal.timeout(2500) })
      if (res.ok) {
        currentMode = "real"
        currentNgl = ngl
        currentCtx = ctx
        console.log(`[engine] ready pid=${proc.pid} ngl=${ngl} ctx=${ctx}`)
        return { ok: true, pid: proc.pid }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 700))
  }

  await stopEngine()
  return { ok: false, error: "llama-server did not become healthy in 180s" }
}

export async function startMeshEngine(opts: {
  packageDir: string
  contextSize: number
  maxVramGB: number
  parallel?: number
}): Promise<{ ok: true; pid?: number } | { ok: false; error: string }> {
  await stopEngine()

  if (!existsSync(MESH_BIN) && MESH_BIN.includes("\\")) {
    return { ok: false, error: `mesh-llm not found at ${MESH_BIN}` }
  }

  const pkgDir = resolve(opts.packageDir)
  if (!existsSync(pkgDir)) {
    return { ok: false, error: `Layer package directory not found: ${pkgDir}` }
  }

  const ctx = Math.max(512, Math.min(opts.contextSize, 131072))
  const baseArgs = [
    "serve",
    "--model", pkgDir,
    "--port", String(MESH_PORT),
    "--console", String(MESH_PORT + 1),
    "--ctx-size", String(ctx),
    "--parallel", String(opts.parallel ?? 1),
    "--llama-flavor", "vulkan",
    // Do not advertise this machine's hardware on the network.
    "--no-enumerate-host",
  ]
  // --max-vram is expressed in GB. 0 keeps the planner unconstrained.
  if (opts.maxVramGB > 0) baseArgs.push("--max-vram", opts.maxVramGB.toFixed(1))

  // `--local-model-only` is the lightest path (no mesh networking). Some
  // packages can only be materialised by the staged runtime, so fall back to
  // the documented `--split` mode if it fails.
  const modes: { label: string; extra: string[]; timeoutMs: number }[] = [
    { label: "local", extra: ["--local-model-only"], timeoutMs: 240_000 },
    { label: "split", extra: ["--split"], timeoutMs: 900_000 },
  ]

  let lastError = "mesh-llm failed to start"

  for (const mode of modes) {
    const args = [...baseArgs, ...mode.extra]
    console.log(`[engine] spawning mesh-llm (${mode.label})`, MESH_BIN, args.join(" "))
    logTail = []

    const proc = spawn(MESH_BIN, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MESH_LLM_NO_ANALYTICS: "1" },
      cwd: dirname(MESH_BIN),
    })
    child = proc
    currentBackend = "mesh"
    currentEndpoint = MESH_ENDPOINT

    const absorb = (data: Buffer) => {
      const text = data.toString()
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        pushLog(line)
        if (/error|failed|load|offload|VRAM|device|listening|ready|stage|layer|split/i.test(line)) {
          console.log("[mesh]", line)
        }
      }
    }
    proc.stdout?.on("data", absorb)
    proc.stderr?.on("data", absorb)

    let exited = false
    proc.on("exit", (code) => {
      exited = true
      console.log(`[engine] mesh-llm (${mode.label}) exited code=${code}`)
      if (child === proc) {
        child = null
        currentMode = "unknown"
      }
    })
    proc.on("error", (err) => {
      exited = true
      console.error("[engine] mesh spawn error:", err)
      pushLog(String(err))
      if (child === proc) {
        child = null
        currentMode = "unknown"
      }
    })

    // Mesh LLM materialises every stage before it can serve, which for a
    // 65-layer package on disk takes longer than a plain llama.cpp load.
    const deadline = Date.now() + mode.timeoutMs
    while (Date.now() < deadline) {
      if (exited || !child) {
        lastError = `mesh-llm (${mode.label}) exited during load\n${logTail.slice(-8).join("\n")}`
        break
      }
      try {
        const res = await fetch(`${MESH_ENDPOINT}/v1/models`, { signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          const body = await res.json().catch(() => null)
          const models = Array.isArray(body?.data) ? body.data.map((m: { id?: string }) => m.id).filter(Boolean) : []
          if (models.length > 0) {
            currentMode = "real"
            currentNgl = 0
            currentCtx = ctx
            currentModelName = models[0]
            console.log(`[engine] mesh ready pid=${proc.pid} mode=${mode.label} model=${models[0]} ctx=${ctx}`)
            return { ok: true, pid: proc.pid }
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1500))
    }

    await stopEngine()
    if (!exited) lastError = `mesh-llm (${mode.label}) did not become healthy in ${mode.timeoutMs / 1000}s`
    console.log(`[engine] mesh ${mode.label} failed: ${lastError.split("\n")[0]}`)
  }

  return { ok: false, error: lastError }
}

export async function stopEngine(): Promise<void> {
  currentMode = "unknown"
  const proc = child
  child = null
  currentEndpoint = LLAMA_ENDPOINT
  currentModelName = ""
  if (!proc) return
  // Mesh LLM spawns native worker processes; kill the whole tree so a failed
  // `--local-model-only` attempt cannot keep ports/VRAM busy for the retry.
  if (process.platform === "win32" && proc.pid) {
    try {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    } catch {}
  } else {
    try {
      proc.kill()
    } catch {}
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 5000)
    proc.once("exit", () => {
      clearTimeout(t)
      resolve()
    })
  })
}

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/** Stream a chat completion from llama-server, invoking onToken per delta. */
export async function streamChat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal },
  onToken: (token: string) => void,
): Promise<{ content: string; promptTokens?: number; completionTokens?: number }> {
  const res = await fetch(`${currentEndpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(currentModelName ? { model: currentModelName } : {}),
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 512,
      stream_options: { include_usage: true },
    }),
    signal: opts.signal,
  })

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "")
    throw new Error(`llama-server ${res.status}: ${body.slice(0, 300)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let content = ""
  let promptTokens: number | undefined
  let completionTokens: number | undefined

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let nl: number
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === "[DONE]") continue
      try {
        const json = JSON.parse(payload)
        const delta = json?.choices?.[0]?.delta?.content
        if (typeof delta === "string" && delta.length > 0) {
          content += delta
          onToken(delta)
        }
        if (json?.usage) {
          promptTokens = json.usage.prompt_tokens ?? promptTokens
          completionTokens = json.usage.completion_tokens ?? completionTokens
        }
      } catch {
        // Partial JSON across chunks — put it back and wait for more.
        buffer = line + "\n" + buffer
        break
      }
    }
  }

  return { content, promptTokens, completionTokens }
}
