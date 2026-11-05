/**
 * Real Hugging Face GGUF downloader.
 *
 * Spawned detached by POST /api/hf/download so a multi-gigabyte download does
 * not block a Next.js request (or die on hot reload). It:
 *   1. streams each queued file to models/<repo-slug>/ with live progress in DB
 *   2. reads the GGUF header to learn the real transformer-layer count
 *   3. replaces placeholder layers with one row per real block
 *   4. marks the model "ready" so the engine can load it
 *
 * Usage: bun scripts/model-download.ts <modelId>
 */

import { PrismaClient } from "@prisma/client"
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { readGgufMeta } from "../src/lib/gguf"

const db = new PrismaClient()
const modelId = process.argv[2]

if (!modelId) {
  console.error("usage: bun scripts/model-download.ts <modelId>")
  process.exit(1)
}

const HF_BASE = "https://huggingface.co"

function log(path: string, ...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`
  process.stdout.write(line)
  try {
    appendFileSync(path, line)
  } catch {}
}

function guessQuant(fileName: string): string | null {
  const m = fileName.match(/(IQ\d[A-Z0-9_]*|Q\d[A-Z0-9_]*|BF16|F16|F32)/i)
  return m ? m[1].toUpperCase() : null
}

function prettyFamily(arch?: string): string | null {
  if (!arch) return null
  const known: Record<string, string> = {
    qwen2: "Qwen2",
    qwen3: "Qwen3",
    llama: "Llama",
    mistral: "Mistral",
    gemma3: "Gemma3",
    phi3: "Phi3",
    deepseek2: "DeepSeek",
  }
  return known[arch] ?? arch.charAt(0).toUpperCase() + arch.slice(1)
}

async function downloadOne(
  row: { id: string; fileName: string },
  repo: string,
  revision: string,
  dir: string,
  logPath: string,
): Promise<{ path: string; bytes: number }> {
  const url = `${HF_BASE}/${repo}/resolve/${encodeURIComponent(revision)}/${row.fileName}`
  const outPath = rowPath(dir, row.fileName)
  mkdirSync(dirname(outPath), { recursive: true })

  // If the file is already complete, keep it.
  const existing = existsSync(outPath) ? statSync(outPath).size : 0
  const head = await fetch(url, { method: "HEAD" })
  const expected = Number(head.headers.get("content-length") ?? 0)

  if (existing > 0 && expected > 0 && existing === expected) {
    await db.hfDownload.update({
      where: { id: row.id },
      data: { status: "done", totalBytes: BigInt(expected), downloadedBytes: BigInt(existing), finishedAt: new Date() },
    })
    log(logPath, `skip (already complete):`, row.fileName)
    return { path: outPath, bytes: existing }
  }

  log(logPath, `GET`, url)
  try {
    await db.hfDownload.update({
      where: { id: row.id },
      data: { status: "running", totalBytes: BigInt(expected), downloadedBytes: BigInt(0), startedAt: new Date() },
    })
  } catch {}

  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} for ${row.fileName}`)
  }

  const total = Number(res.headers.get("content-length") ?? 0) || expected
  const out = createWriteStream(outPath)
  let received = 0
  let lastFlush = 0

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength
      if (!out.write(chunk)) {
        await new Promise<void>((r) => out.once("drain", () => r()))
      }
      const now = Date.now()
      if (now - lastFlush > 2500) {
        lastFlush = now
        // Progress is best-effort: a brief SQLite lock must not abort a
        // multi-hundred-megabyte transfer.
        try {
          await db.hfDownload.update({
            where: { id: row.id },
            data: { downloadedBytes: BigInt(received) },
          })
        } catch {}
        log(logPath, `progress`, row.fileName, `${received}/${total || "?"}`)
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
  } catch (err) {
    out.destroy()
    try {
      unlinkSync(outPath)
    } catch {}
    throw err
  }

  const bytes = statSync(outPath).size
  // The file is complete; retry the bookkeeping so a transient lock does not
  // force a full re-download on the next run.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await db.hfDownload.update({
        where: { id: row.id },
        data: {
          status: "done",
          totalBytes: BigInt(total || bytes),
          downloadedBytes: BigInt(bytes),
          finishedAt: new Date(),
        },
      })
      break
    } catch (err) {
      if (attempt === 4) log(logPath, `warn: could not mark done`, row.fileName, String(err))
      else await new Promise((r) => setTimeout(r, 1000))
    }
  }
  log(logPath, `done`, row.fileName, `${bytes} bytes`)
  return { path: outPath, bytes }
}

function firstModelFile(dir: string): string | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".gguf"))
  if (files.length === 0) return null
  // Prefer the first shard of a split GGUF
  const shard = files.find((f) => /-00001-of-\d+\.gguf$/i.test(f))
  return join(dir, shard ?? files.sort()[0])
}

/** Resolve a repo-relative file name under the model directory, safely. */
function rowPath(dir: string, fileName: string): string {
  const parts = fileName.split(/[\\/]/).filter((p) => p && p !== "." && p !== "..")
  return join(dir, ...parts)
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

async function main() {
  const model = await db.model.findUnique({ where: { id: modelId } })
  if (!model) throw new Error(`Model ${modelId} not found`)

  const dir = model.localPath ?? ""
  if (!dir) throw new Error(`Model ${modelId} has no localPath`)
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, "download.log")
  log(logPath, `=== download ${model.repo} @ ${model.revision} -> ${dir}`)

  const rows = await db.hfDownload.findMany({ where: { modelId }, orderBy: { fileName: "asc" } })
  if (rows.length === 0) throw new Error("No queued files")

  const sourceRepo = model.repo
  const sourceRevision = model.revision

  let ok = 0
  const downloaded: { path: string; bytes: number }[] = []
  // Hugging Face throttles a single connection, so fetch several layer files
  // at once. Completed rows are skipped, which makes restarts cheap.
  const concurrency = Math.max(1, Math.min(Number(process.env.DL_CONCURRENCY ?? 3), 6))
  let cursor = 0

  async function downloadWorker() {
    while (true) {
      const idx = cursor++
      if (idx >= rows.length) return
      const row = rows[idx]

      if (row.status === "done" && existsSync(rowPath(dir, row.fileName))) {
        downloaded.push({ path: rowPath(dir, row.fileName), bytes: Number(row.downloadedBytes) })
        ok++
        continue
      }
      let finished = false
      for (let attempt = 1; attempt <= 3 && !finished; attempt++) {
        try {
          downloaded.push(await downloadOne(row, sourceRepo, sourceRevision, dir, logPath))
          ok++
          finished = true
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (attempt < 3) {
            log(logPath, `retry ${attempt}/3`, row.fileName, msg)
            await new Promise((r) => setTimeout(r, 1500 * attempt))
            continue
          }
          log(logPath, `FAILED`, row.fileName, msg)
          try {
            await db.hfDownload.update({
              where: { id: row.id },
              data: { status: "failed", error: msg.slice(0, 500), finishedAt: new Date() },
            })
          } catch {}
        }
      }
    }
  }

  log(logPath, `downloading ${rows.length} files with concurrency=${concurrency}`)
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => downloadWorker()))

  if (ok === 0) {
    await db.model.update({ where: { id: modelId }, data: { status: "error" } })
    log(logPath, "=== all files failed")
    return
  }

  const primary = firstModelFile(dir)
  const pkgPath = join(dir, "model-package.json")

  // Mesh LLM layer package: one GGUF per transformer layer plus shared
  // embedding/output/metadata artifacts. llama.cpp cannot load this layout,
  // so the engine runs it through Mesh LLM instead.
  if (existsSync(pkgPath)) {
    let pkg: any = null
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    } catch {}

    const layerFiles = walk(join(dir, "layers"))
      .filter((f) => /layer-\d+\.gguf$/i.test(f))
      .sort()
    if (layerFiles.length === 0) throw new Error("Layer package has no layer files")

    await db.layer.deleteMany({ where: { modelId } })
    await db.layer.createMany({
      data: layerFiles.map((p, i) => ({
        modelId,
        index: i,
        fileName: relative(dir, p).replace(/\\/g, "/"),
        sizeBytes: BigInt(statSync(p).size),
        location: "nvme",
      })),
    })

    const totalBytes = walk(dir)
      .filter((f) => f.toLowerCase().endsWith(".gguf"))
      .reduce((s, f) => s + statSync(f).size, 0)
    const modelIdLabel = String(pkg?.model_id ?? "")
    const quant = modelIdLabel.includes(":") ? modelIdLabel.split(":").pop()! : guessQuant(model.repo)

    await db.model.update({
      where: { id: modelId },
      data: {
        status: "ready",
        sizeBytes: BigInt(totalBytes),
        layersCount: layerFiles.length,
        quant,
        family: "Qwen3",
        contextSize: Math.min(model.contextSize, 8192),
        engine: "mesh-llm",
        revision: String(pkg?.source_model?.revision ?? model.revision),
      },
    })

    log(logPath, `=== layer package ready: ${layerFiles.length} layers, ${totalBytes} bytes, quant=${quant}`)
    return
  }

  if (!primary) throw new Error("Download finished but no .gguf file was found")

  let meta: ReturnType<typeof readGgufMeta> | null = null
  try {
    meta = readGgufMeta(primary)
    log(logPath, "gguf:", JSON.stringify(meta))
  } catch (err) {
    log(logPath, "gguf metadata read failed:", String(err))
  }

  const ggufFiles = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".gguf"))
  const totalBytes = ggufFiles.reduce((s, f) => s + statSync(join(dir, f)).size, 0)
  const blockCount = Math.max(1, meta?.blockCount ?? 1)
  const perBlock = Math.floor(totalBytes / blockCount)
  const primaryName = primary.split(/[\\/]/).pop() ?? "model.gguf"

  // Rebuild layers as real transformer blocks so placement maps 1:1 to
  // llama.cpp's --n-gpu-layers offload.
  await db.layer.deleteMany({ where: { modelId } })
  await db.layer.createMany({
    data: Array.from({ length: blockCount }, (_, i) => ({
      modelId,
      index: i,
      fileName: `${primaryName}#blk${String(i).padStart(2, "0")}`,
      sizeBytes: BigInt(i === blockCount - 1 ? totalBytes - perBlock * i : perBlock),
      location: "nvme",
    })),
  })

  const quant = guessQuant(primaryName) ?? model.quant
  await db.model.update({
    where: { id: modelId },
    data: {
      status: "ready",
      sizeBytes: BigInt(totalBytes),
      layersCount: blockCount,
      quant,
      family: prettyFamily(meta?.architecture) ?? model.family,
      contextSize: Math.min(model.contextSize, meta?.contextLength ?? model.contextSize),
      engine: "llama.cpp",
    },
  })

  log(logPath, `=== ready: ${blockCount} layers, ${totalBytes} bytes, quant=${quant}`)
}

main()
  .catch(async (err) => {
    console.error("[model-download] fatal:", err)
    try {
      const model = await db.model.findUnique({ where: { id: modelId } })
      if (model?.localPath) {
        appendFileSync(join(model.localPath, "download.log"), `[fatal] ${String(err)}\n`)
      }
      await db.model.update({ where: { id: modelId }, data: { status: "error" } })
    } catch {}
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
