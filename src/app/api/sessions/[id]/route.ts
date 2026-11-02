import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const session = await db.chatSession.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  })
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 })
  return NextResponse.json({
    id: session.id,
    modelId: session.modelId,
    title: session.title,
    systemPrompt: session.systemPrompt,
    temperature: session.temperature,
    topP: session.topP,
    maxTokens: session.maxTokens,
    messages: session.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      tokensIn: m.tokensIn,
      tokensOut: m.tokensOut,
      tokensPerSec: m.tokensPerSec,
      strategy: m.strategy,
      createdAt: m.createdAt,
    })),
  })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = (await req.json()) as Partial<{
    title: string
    systemPrompt: string
    temperature: number
    topP: number
    maxTokens: number
  }>
  const session = await db.chatSession.update({ where: { id }, data: body })
  return NextResponse.json({ id: session.id })
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  await db.chatSession.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
