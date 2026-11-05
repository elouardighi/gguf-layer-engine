import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { findPreset } from "@/lib/presets"

export const dynamic = "force-dynamic"

export async function GET() {
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
      engine: m.engine,
      isPreset: !!findPreset(m.repo),
      isReady: m.status === "ready",
      createdAt: m.createdAt,
    })),
  })
}
