import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { seedModelFromPreset, getHfRepo } from "@/lib/hf"
import { findPreset } from "@/lib/presets"

export const dynamic = "force-dynamic"

interface DownloadReq {
  repo: string
  /** Optional: which layer files to fetch. If omitted, fetch all .gguf siblings */
  files?: string[]
  /** Use the preset layer sizes (no real network download) */
  presetSizes?: boolean
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as DownloadReq
  if (!body.repo) return NextResponse.json({ error: "repo required" }, { status: 400 })

  // Always create / fetch the Model + Layer rows (from preset if known,
  // otherwise from a quick HF repo lookup).
  let modelId: string | null = null
  const preset = findPreset(body.repo)
  if (preset) {
    modelId = await seedModelFromPreset(body.repo)
  } else {
    // Fall back to HF repo metadata — create placeholder layers per .gguf file
    let info
    try {
      info = await getHfRepo(body.repo)
    } catch (err) {
      return NextResponse.json({ error: `Cannot reach HF repo: ${err}` }, { status: 200 })
    }
    const ggufFiles = (info.siblings ?? []).filter((s) => s.rfilename.endsWith(".gguf"))
    if (ggufFiles.length === 0) {
      return NextResponse.json({ error: "Repo has no .gguf files" }, { status: 200 })
    }
    const existing = await db.model.findFirst({ where: { repo: body.repo } })
    if (existing) {
      modelId = existing.id
    } else {
      const totalBytes = ggufFiles.reduce((s, f) => s + (f.size ?? 0), 0)
      const model = await db.model.create({
        data: {
          repo: body.repo,
          name: body.repo.split("/").pop() ?? body.repo,
          family: "unknown",
          contextSize: 4096,
          sizeBytes: BigInt(totalBytes),
          layersCount: ggufFiles.length,
          status: "pending",
        },
      })
      await db.layer.createMany({
        data: ggufFiles.map((f, i) => ({
          modelId: model.id,
          index: i,
          fileName: f.rfilename.split("/").pop() ?? f.rfilename,
          sizeBytes: BigInt(f.size ?? 250 * 1024 * 1024),
          location: "nvme",
        })),
      })
      modelId = model.id
    }
  }

  // Decide what to "download"
  // For preset models, use the preset layer file names.
  // For non-preset models, list the layers we just created from the repo info.
  let targetFiles: string[] = []
  if (body.files && body.files.length > 0) {
    targetFiles = body.files
  } else if (preset) {
    targetFiles = preset.layers.map((l) => l.fileName)
  } else {
    // Pull the file names from the layers we just created
    const layers = await db.layer.findMany({
      where: { modelId: modelId! },
      orderBy: { index: "asc" },
    })
    targetFiles = layers.map((l) => l.fileName)
  }

  // Create one HfDownload row per file so the UI can track progress per shard
  const downloads = await db.$transaction(
    targetFiles.map((fileName) =>
      db.hfDownload.create({
        data: {
          modelId: modelId!,
          fileName,
          totalBytes: BigInt(0),
          downloadedBytes: BigInt(0),
          status: "pending",
        },
      }),
    ),
  )

  // Mark the model as "downloading"
  await db.model.update({ where: { id: modelId }, data: { status: "downloading" } })

  return NextResponse.json({ modelId, downloads: downloads.map((d) => ({ id: d.id, fileName: d.fileName })) })
}
