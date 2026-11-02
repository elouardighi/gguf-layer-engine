import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { MODEL_PRESETS, findPreset } from "@/lib/presets"

export const dynamic = "force-dynamic"

/** Ensure the default preset models exist as rows so the UI can list them */
async function ensurePresets() {
  for (const preset of MODEL_PRESETS) {
    const existing = await db.model.findFirst({ where: { repo: preset.repo } })
    if (existing) continue
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
  }
}

export async function GET() {
  await ensurePresets()
  const models = await db.model.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { layers: true } } },
  })
  return NextResponse.json({
    items: models.map((m) => ({
      id: m.id,
      repo: m.repo,
      name: m.name,
      quant: m.quant,
      family: m.family,
      contextSize: m.contextSize,
      sizeBytes: Number(m.sizeBytes),
      layersCount: m.layersCount,
      status: m.status,
      isPreset: !!findPreset(m.repo),
      createdAt: m.createdAt,
    })),
  })
}
