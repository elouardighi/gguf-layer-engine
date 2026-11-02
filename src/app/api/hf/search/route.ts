import { NextRequest, NextResponse } from "next/server"
import { searchHfModels } from "@/lib/hf"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? ""
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 30)
  try {
    const items = await searchHfModels({ query: q, limit })
    const publicItems = items.filter((m) => !m.private)
    return NextResponse.json({ items: publicItems })
  } catch (err) {
    return NextResponse.json({ error: String(err), items: [] }, { status: 200 })
  }
}
