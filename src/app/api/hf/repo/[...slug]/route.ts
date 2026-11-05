import { NextRequest, NextResponse } from "next/server"
import { getHfRepo } from "@/lib/hf"

export const dynamic = "force-dynamic"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await ctx.params
  const repo = slug.join("/")
  try {
    const info = await getHfRepo(repo)
    const siblings = (info.siblings ?? []).filter((s) => s.rfilename.endsWith(".gguf"))
    const all = info.siblings ?? []
    const isLayerPackage = all.some((s) => s.rfilename === "model-package.json")
    const packageBytes = isLayerPackage
      ? all
          .filter(
            (s) =>
              s.rfilename === "model-package.json" ||
              /^(shared|layers|projectors)\/[^/]+\.gguf$/i.test(s.rfilename),
          )
          .reduce((sum, s) => sum + (s.size ?? 0), 0)
      : 0
    return NextResponse.json({
      id: info.id,
      author: info.author,
      downloads: info.downloads,
      likes: info.likes,
      lastModified: info.lastModified,
      tags: info.tags,
      sha: info.sha,
      isLayerPackage,
      packageBytes,
      siblings: siblings.map((s) => ({ rfilename: s.rfilename, size: s.size })),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 200 })
  }
}
