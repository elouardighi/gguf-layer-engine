import { NextRequest, NextResponse } from "next/server"
import { getHfRepo } from "@/lib/hf"

export const dynamic = "force-dynamic"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await ctx.params
  const repo = slug.join("/")
  try {
    const info = await getHfRepo(repo)
    const siblings = (info.siblings ?? []).filter((s) => s.rfilename.endsWith(".gguf"))
    return NextResponse.json({
      id: info.id,
      author: info.author,
      downloads: info.downloads,
      likes: info.likes,
      lastModified: info.lastModified,
      tags: info.tags,
      sha: info.sha,
      siblings: siblings.map((s) => ({ rfilename: s.rfilename, size: s.size })),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 200 })
  }
}
