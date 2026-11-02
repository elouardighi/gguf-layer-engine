import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const modelId = req.nextUrl.searchParams.get("modelId")
  const items = await db.chatSession.findMany({
    where: modelId ? { modelId } : undefined,
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { messages: true } } },
  })
  return NextResponse.json({
    items: items.map((s) => ({
      id: s.id,
      modelId: s.modelId,
      title: s.title,
      systemPrompt: s.systemPrompt,
      temperature: s.temperature,
      topP: s.topP,
      maxTokens: s.maxTokens,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s._count.messages,
    })),
  })
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    modelId: string
    title?: string
    systemPrompt?: string
    temperature?: number
    topP?: number
    maxTokens?: number
  }
  const session = await db.chatSession.create({
    data: {
      modelId: body.modelId,
      title: body.title ?? "New chat",
      systemPrompt: body.systemPrompt ?? "",
      temperature: body.temperature ?? 0.7,
      topP: body.topP ?? 0.95,
      maxTokens: body.maxTokens ?? 2048,
    },
  })
  return NextResponse.json({ id: session.id })
}
