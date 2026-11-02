/** Tiny formatting helpers used across the studio */

export function formatBytes(bytes: number | bigint): string {
  const n = typeof bytes === "bigint" ? Number(bytes) : bytes
  if (!isFinite(n) || n <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`
}

export function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`
  if (ms < 1000) return `${ms.toFixed(1)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function formatTokensPerSec(t: number): string {
  if (!isFinite(t) || t <= 0) return "0 tok/s"
  if (t < 10) return `${t.toFixed(2)} tok/s`
  if (t < 100) return `${t.toFixed(1)} tok/s`
  return `${t.toFixed(0)} tok/s`
}

export function formatPercent(p: number): string {
  if (!isFinite(p)) return "0%"
  return `${p.toFixed(p >= 10 ? 0 : 1)}%`
}

export function timeAgo(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  return `${days}d ago`
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
