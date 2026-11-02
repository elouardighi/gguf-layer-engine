import { NextRequest, NextResponse } from "next/server"
import { currentStatus } from "@/lib/llama"

export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json(currentStatus())
}
