import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

/**
 * Body: { index: number, location: "gpu" | "ram" | "nvme", pinned?: boolean }
 *
 * Pinning a layer to GPU overrides whatever the strategy decided for it;
 * unpinning lets the strategy decide again on the next forward pass.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ modelId: string }> }) {
  const { modelId } = await ctx.params
  const body = (await req.json()) as { index: number; location?: "gpu" | "ram" | "nvme"; pinned?: boolean }
  const updated = await db.layer.updateMany({
    where: { modelId, index: body.index },
    data: {
      ...(body.location ? { location: body.location } : {}),
      ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
    },
  })
  return NextResponse.json({ ok: true, updated: updated.count })
}
