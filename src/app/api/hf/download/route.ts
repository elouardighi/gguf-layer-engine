import { NextRequest, NextResponse } from "next/server"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { db } from "@/lib/db"
import { getHfRepo, modelLocalPath } from "@/lib/hf"

export const dynamic = "force-dynamic"
export const maxDuration = 300

interface DownloadReq {
  repo: string
  /** Optional: explicit .gguf file(s), e.g. one quant from a repo with many. */
  files?: string[]
}

function guessQuant(fileName: string): string | null {
  const m = fileName.match(/(IQ\d[A-Z0-9_]*|Q\d[A-Z0-9_]*|BF16|F16|F32)/i)
  return m ? m[1].toUpperCase() : null
}

/** Prefer a normal 4-bit quant, otherwise the smallest file. */
function pickDefaultFile(files: { rfilename: string; size?: number }[]) {
  const prefer = [
    /q4_k_m/i,
    /q4_k_s/i,
    /iq4_xs/i,
    /q5_k_m/i,
    /q8_0/i,
    /q4_0/i,
  ]
  for (const re of prefer) {
    const hit = files.find((f) => re.test(f.rfilename))
    if (hit) return hit
  }
  return [...files].sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0]
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as DownloadReq
  if (!body.repo) return NextResponse.json({ error: "repo required" }, { status: 400 })

  let info
  try {
    info = await getHfRepo(body.repo)
  } catch (err) {
    return NextResponse.json({ error: `Cannot reach HF repo: ${err}` }, { status: 400 })
  }

  const ggufFiles = (info.siblings ?? []).filter((s) => s.rfilename.toLowerCase().endsWith(".gguf"))
  const allFiles = info.siblings ?? []
  const isLayerPackage = allFiles.some((s) => s.rfilename === "model-package.json")

  if (!isLayerPackage && ggufFiles.length === 0) {
    return NextResponse.json({ error: "This repo has no .gguf files" }, { status: 400 })
  }

  let chosen: { rfilename: string; size?: number }[]
  if (body.files && body.files.length > 0) {
    chosen = allFiles.filter((f) => body.files!.includes(f.rfilename))
    if (chosen.length === 0) {
      return NextResponse.json({ error: "None of the requested files exist in this repo" }, { status: 400 })
    }
  } else if (isLayerPackage) {
    // Whole Mesh LLM layer package: manifest + shared artifacts + every layer
    // (+ optional mmproj sidecars). llama.cpp cannot load this layout; the
    // engine routes it through Mesh LLM.
    chosen = allFiles.filter(
      (f) =>
        f.rfilename === "model-package.json" ||
        /^(shared|layers|projectors)\/[^/]+\.gguf$/i.test(f.rfilename),
    )
  } else {
    const picked = pickDefaultFile(ggufFiles)
    // If the default is one shard of a split GGUF, grab every shard.
    const shardMatch = picked.rfilename.match(/^(.*)-00001-of-(\d{5})\.gguf$/i)
    if (shardMatch) {
      const prefix = shardMatch[1]
      chosen = ggufFiles.filter((f) => f.rfilename.startsWith(prefix + "-") && f.rfilename.endsWith(".gguf"))
    } else {
      chosen = [picked]
    }
  }

  const totalBytes = chosen.reduce((s, f) => s + (f.size ?? 0), 0)
  const primaryName = chosen.find((f) => f.rfilename.toLowerCase().endsWith(".gguf"))?.rfilename.split("/").pop() ?? body.repo
  const localPath = modelLocalPath(body.repo)
  const layerFileCount = isLayerPackage
    ? chosen.filter((f) => /^layers\/layer-\d+\.gguf$/i.test(f.rfilename)).length
    : 0

  const existing = await db.model.findFirst({ where: { repo: body.repo } })
  let modelId: string
  const repoShort = info.id.split("/").pop() ?? body.repo
  const displayName = isLayerPackage ? repoShort.replace(/-layers$/i, "") : repoShort
  const packageQuant =
    (repoShort.match(/UD-[A-Za-z0-9_]+/i)?.[0] ?? guessQuant(repoShort)) ?? null

  if (existing) {
    modelId = existing.id
    await db.hfDownload.deleteMany({ where: { modelId } })
    await db.model.update({
      where: { id: modelId },
      data: {
        status: "downloading",
        localPath,
        sizeBytes: BigInt(totalBytes),
        quant: isLayerPackage ? packageQuant : guessQuant(primaryName) ?? existing.quant,
        family: isLayerPackage ? "Qwen3" : existing.family,
        layersCount: isLayerPackage ? layerFileCount : existing.layersCount,
        name: isLayerPackage ? displayName : existing.name,
        engine: isLayerPackage ? "mesh-llm" : "llama.cpp",
      },
    })
  } else {
    const model = await db.model.create({
      data: {
        repo: body.repo,
        name: displayName,
        revision: "main",
        quant: isLayerPackage ? packageQuant : guessQuant(primaryName),
        family: isLayerPackage ? "Qwen3" : null,
        localPath,
        sizeBytes: BigInt(totalBytes),
        layersCount: isLayerPackage ? layerFileCount : 0,
        status: "downloading",
        contextSize: 8192,
        engine: isLayerPackage ? "mesh-llm" : "llama.cpp",
      },
    })
    modelId = model.id
  }

  const downloads = await db.$transaction(
    chosen.map((f) =>
      db.hfDownload.create({
        data: {
          modelId,
          fileName: f.rfilename,
          totalBytes: BigInt(f.size ?? 0),
          downloadedBytes: BigInt(0),
          status: "pending",
        },
      }),
    ),
  )

  // Hand the actual transfer to a detached Bun worker (survives hot reloads).
  const script = join(process.cwd(), "scripts", "model-download.ts")
  const bun = process.execPath.toLowerCase().includes("bun") ? process.execPath : "bun"
  const child = spawn(bun, [script, modelId], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  })
  child.unref()

  return NextResponse.json({
    modelId,
    files: chosen.map((f) => f.rfilename),
    downloads: downloads.map((d) => ({ id: d.id, fileName: d.fileName })),
  })
}
