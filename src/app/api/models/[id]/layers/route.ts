import { NextRequest, NextResponse } from "next/server"
import { getLayersForModel, planPlacement, applyPlan, type Strategy } from "@/lib/layer-engine"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const layers = await getLayersForModel(id)
  return NextResponse.json({ items: layers })
}

/** Re-apply a strategy (or pin/unpin a layer) without launching the engine */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = (await req.json()) as { strategy?: Strategy }
  const model = await db.model.findUnique({ where: { id } })
  if (!model) return NextResponse.json({ error: "not found" }, { status: 404 })
  const layers = await getLayersForModel(id)
  const plan = planPlacement(layers, body.strategy ?? "balanced", {
    contextBytes: model.contextSize * 4096,
  })
  await applyPlan(id, plan)
  return NextResponse.json({
    strategy: plan.strategy,
    vramBytes: plan.vramBytes,
    ramBytes: plan.ramBytes,
    nvmeBytes: plan.nvmeBytes,
  })
}
