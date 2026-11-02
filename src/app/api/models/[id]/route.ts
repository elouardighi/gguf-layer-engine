import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const m = await db.model.findUnique({ where: { id } })
  if (!m) return NextResponse.json({ error: "not found" }, { status: 404 })
  return NextResponse.json({
    id: m.id,
    repo: m.repo,
    name: m.name,
    quant: m.quant,
    family: m.family,
    contextSize: m.contextSize,
    sizeBytes: Number(m.sizeBytes),
    layersCount: m.layersCount,
    status: m.status,
    localPath: m.localPath,
    createdAt: m.createdAt,
  })
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  await db.model.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
