import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const rows = await db.hfDownload.findMany({ where: { modelId: id }, orderBy: { fileName: "asc" } })
  const model = await db.model.findUnique({ where: { id } })
  const totalBytes = rows.reduce((s, r) => s + Number(r.totalBytes), 0)
  const doneBytes = rows.reduce((s, r) => s + Number(r.downloadedBytes), 0)
  return NextResponse.json({
    modelId: id,
    status: model?.status,
    files: rows.map((r) => ({
      id: r.id,
      fileName: r.fileName,
      totalBytes: Number(r.totalBytes),
      downloadedBytes: Number(r.downloadedBytes),
      status: r.status,
      error: r.error,
    })),
    totalBytes,
    doneBytes,
    progress: totalBytes > 0 ? doneBytes / totalBytes : 0,
  })
}
