/**
 * Hugging Face Hub helpers.
 *
 * Uses only PUBLIC endpoints — no token required. We hit:
 *   - GET https://huggingface.co/api/models?search=...&filter=gguf
 *   - GET https://huggingface.co/api/models/{repo}
 *   - HEAD https://huggingface.co/{repo}/resolve/{rev}/{file}
 *
 * For downloads we stream the resolve URL through Node fetch and tee it into
 * our models directory while reporting progress to the DB.
 */

import "server-only"

import { db } from "@/lib/db"
import { findPreset } from "@/lib/presets"
import { slugify } from "@/lib/format"
import { mkdir, writeFile, rm, stat } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

export const HF_BASE = "https://huggingface.co"
export const MODELS_DIR = join(process.cwd(), "models")

export interface HfModelInfo {
  id: string
  author: string
  private: boolean
  downloads: number
  likes: number
  lastModified: string
  tags: string[]
  pipeline_tag: string | null
}

export interface HfSibling {
  rfilename: string
  size?: number
  blobId?: string
}

export interface HfRepoInfo extends HfModelInfo {
  siblings: HfSibling[]
  config?: Record<string, unknown>
  sha: string
}

export async function searchHfModels(opts: {
  query?: string
  filter?: string
  limit?: number
  sort?: string
}): Promise<HfModelInfo[]> {
  const params = new URLSearchParams()
  if (opts.query) params.set("search", opts.query)
  params.append("filter", "gguf")
  params.set("limit", String(opts.limit ?? 30))
  params.set("sort", opts.sort ?? "downloads")
  params.set("full", "false")
  params.set("direction", "-1")

  const url = `${HF_BASE}/api/models?${params.toString()}`
  const res = await fetch(url, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`HF search failed (${res.status})`)
  const data = (await res.json()) as HfModelInfo[]
  return data
}

export async function getHfRepo(repo: string, revision = "main"): Promise<HfRepoInfo> {
  // Don't encodeURIComponent the repo — the slash between author/name is
  // significant and HF rejects %2F. Path segments are safe without encoding.
  const url = `${HF_BASE}/api/models/${repo}/revision/${encodeURIComponent(revision)}?blobs=true`
  const res = await fetch(url, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`HF repo info failed (${res.status})`)
  return (await res.json()) as HfRepoInfo
}

export async function headHfFile(repo: string, file: string, revision = "main"): Promise<number> {
  const url = `${HF_BASE}/${repo}/resolve/${encodeURIComponent(revision)}/${file}`
  const res = await fetch(url, { method: "HEAD" })
  if (!res.ok) return 0
  const len = res.headers.get("content-length")
  return len ? Number(len) : 0
}

/** Resolve a single GGUF file URL */
export function resolveFileUrl(repo: string, file: string, revision = "main"): string {
  return `${HF_BASE}/${repo}/resolve/${encodeURIComponent(revision)}/${file}`
}

/** Stable local path for a model */
export function modelLocalPath(repo: string): string {
  return join(MODELS_DIR, slugify(repo))
}

/**
 * Seed a Model row from a preset (no download yet).
 * Returns the model row id.
 */
export async function seedModelFromPreset(repo: string) {
  const preset = findPreset(repo)
  if (!preset) throw new Error(`Unknown preset repo: ${repo}`)

  const existing = await db.model.findFirst({ where: { repo } })
  if (existing) return existing.id

  const totalBytes = preset.layers.reduce((s, l) => s + l.sizeMB * 1024 * 1024, 0)
  const model = await db.model.create({
    data: {
      repo: preset.repo,
      name: preset.name,
      quant: preset.quant,
      family: preset.family,
      contextSize: preset.contextSize,
      sizeBytes: BigInt(totalBytes),
      layersCount: preset.layers.length,
      status: "pending",
      localPath: modelLocalPath(preset.repo),
    },
  })

  await db.layer.createMany({
    data: preset.layers.map((l) => ({
      modelId: model.id,
      index: l.index,
      fileName: l.fileName,
      sizeBytes: BigInt(l.sizeMB * 1024 * 1024),
      location: "nvme",
    })),
  })

  return model.id
}

/**
 * Stream a single file from HF into the local models directory and update
 * the matching HfDownload row with progress.
 *
 * Run this on a worker — it returns once the file is fully written.
 */
export async function downloadLayerFile(
  downloadId: string,
  repo: string,
  fileName: string,
  revision = "main",
): Promise<{ bytes: number; sha: string }> {
  const dl = await db.hfDownload.findUnique({ where: { id: downloadId } })
  if (!dl) throw new Error("Download row not found")

  const dir = modelLocalPath(repo)
  await mkdir(dir, { recursive: true })
  const outPath = join(dir, fileName)

  const url = resolveFileUrl(repo, fileName, revision)
  await db.hfDownload.update({
    where: { id: downloadId },
    data: { status: "running", startedAt: new Date() },
  })

  const res = await fetch(url)
  if (!res.ok || !res.body) {
    await db.hfDownload.update({
      where: { id: downloadId },
      data: { status: "failed", error: `HTTP ${res.status}`, finishedAt: new Date() },
    })
    throw new Error(`Download failed: ${res.status}`)
  }

  const total = Number(res.headers.get("content-length") ?? 0) || dl.totalBytes || BigInt(0)
  await db.hfDownload.update({
    where: { id: downloadId },
    data: { totalBytes: BigInt(total) },
  })

  const hash = createHash("sha256")
  let received = 0
  let lastTick = 0

  // Tee the response body: write to file, feed sha, track bytes
  const nodeStream = Readable.fromWeb(res.body as any)
  const out = createWriteStream(outPath)

  const teed = new Readable({
    read() {},
  })
  nodeStream.on("data", (chunk: Buffer) => {
    received += chunk.length
    hash.update(chunk)
    out.write(chunk)
    teed.push(chunk)
    const now = Date.now()
    if (now - lastTick > 250) {
      lastTick = now
      db.hfDownload
        .update({
          where: { id: downloadId },
          data: { downloadedBytes: BigInt(received) },
        })
        .catch(() => {})
    }
  })
  nodeStream.on("end", () => {
    out.end(() => {
      teed.push(null)
    })
  })
  nodeStream.on("error", (err) => {
    out.destroy(err)
    teed.destroy(err)
    db.hfDownload
      .update({
        where: { id: downloadId },
        data: { status: "failed", error: String(err), finishedAt: new Date() },
      })
      .catch(() => {})
  })

  // Wait for out stream to finish
  await new Promise<void>((resolve, reject) => {
    out.on("finish", resolve)
    out.on("error", reject)
  })

  const sha = hash.digest("hex")
  const finalStat = await stat(outPath).catch(() => null)
  const bytes = finalStat?.size ?? received

  await db.hfDownload.update({
    where: { id: downloadId },
    data: {
      status: "done",
      downloadedBytes: BigInt(bytes),
      finishedAt: new Date(),
    },
  })

  return { bytes, sha }
}

/** Remove a model directory and its files */
export async function removeModelFiles(repo: string): Promise<void> {
  const dir = modelLocalPath(repo)
  await rm(dir, { recursive: true, force: true })
}

/**
 * Persist a placeholder marker file so we can list "downloaded" models
 * even when the real GGUF bytes haven't been fetched (demo mode).
 */
export async function writeModelMarker(repo: string, name: string): Promise<void> {
  const dir = modelLocalPath(repo)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, ".studio-marker.json"), JSON.stringify({ repo, name, createdAt: Date.now() }, null, 2))
}

/** Quick check whether a model directory exists locally */
export async function modelDirExists(repo: string): Promise<boolean> {
  const dir = modelLocalPath(repo)
  try {
    await stat(dir)
    return true
  } catch {
    return false
  }
}
