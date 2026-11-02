import { NextRequest, NextResponse } from "next/server"
import { loadModel, currentStatus } from "@/lib/llama"
import type { Strategy } from "@/lib/layer-engine"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = (await req.json()) as { strategy?: Strategy }
  const status = await loadModel(id, body.strategy ?? "balanced")
  return NextResponse.json(status)
}
