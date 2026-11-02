import { NextRequest, NextResponse } from "next/server"
import { stopEngine } from "@/lib/llama"

export const dynamic = "force-dynamic"

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  await stopEngine()
  return NextResponse.json({ ok: true, modelId: id })
}
