import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

/** Persist a chat message after the WebSocket stream has finished */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = (await req.json()) as {
    role: string
    content: string
    tokensIn?: number
    tokensOut?: number
    tokensPerSec?: number
    strategy?: string
  }
  const msg = await db.chatMessage.create({
    data: {
      sessionId: id,
      role: body.role,
      content: body.content,
      tokensIn: body.tokensIn ?? 0,
      tokensOut: body.tokensOut ?? 0,
      tokensPerSec: body.tokensPerSec ?? 0,
      strategy: body.strategy ?? "balanced",
    },
  })
  // Bump session updatedAt so it floats to the top of the list
  await db.chatSession.update({ where: { id }, data: { updatedAt: new Date() } })
  return NextResponse.json({ id: msg.id })
}
