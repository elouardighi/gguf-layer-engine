"use client"

import { useStudio } from "@/hooks/use-studio"
import { Progress } from "@/components/ui/progress"
import { MemoryStick, HardDrive, Database, Gauge } from "lucide-react"
import { formatBytes, formatPercent } from "@/lib/format"

export function HardwareMonitor() {
  const { hardware, lastTokenStats } = useStudio()

  if (!hardware) {
    return (
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 mb-2">
          <Gauge className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-medium">Hardware</span>
        </div>
        <div className="text-center py-3 text-[10px] text-muted-foreground">No engine loaded</div>
      </div>
    )
  }

  const vramPct = (hardware.vramUsed / hardware.vramTotal) * 100
  const ramPct = (hardware.ramUsed / hardware.ramTotal) * 100
  const nvmePct = (hardware.nvmeUsed / hardware.nvmeTotal) * 100

  return (
    <div className="border-b border-border px-3 py-2">
      <div className="flex items-center gap-1.5 mb-2">
        <Gauge className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium">Hardware</span>
        {lastTokenStats && (
          <span className="ml-auto text-[9px] font-mono text-muted-foreground">
            {lastTokenStats.tokensPerSec > 0 ? `${lastTokenStats.tokensPerSec.toFixed(1)} tok/s` : "—"}
          </span>
        )}
      </div>

      <div className="space-y-2">
        <GaugeBar
          icon={<MemoryStick className="h-3 w-3" />}
          label="VRAM"
          color="gpu"
          used={hardware.vramUsed}
          total={hardware.vramTotal}
          pct={vramPct}
          sublabel="hot layers"
        />
        <GaugeBar
          icon={<Database className="h-3 w-3" />}
          label="RAM"
          color="ram"
          used={hardware.ramUsed}
          total={hardware.ramTotal}
          pct={ramPct}
          sublabel={`ctx ${formatBytes(hardware.contextBytes)}`}
        />
        <GaugeBar
          icon={<HardDrive className="h-3 w-3" />}
          label="NVMe"
          color="nvme"
          used={hardware.nvmeUsed}
          total={hardware.nvmeTotal}
          pct={nvmePct}
          sublabel="paged"
        />
      </div>
    </div>
  )
}

function GaugeBar({
  icon,
  label,
  color,
  used,
  total,
  pct,
  sublabel,
}: {
  icon: React.ReactNode
  label: string
  color: "gpu" | "ram" | "nvme"
  used: number
  total: number
  pct: number
  sublabel?: string
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] font-mono mb-1">
        <span style={{ color: `var(--${color})` }}>{icon}</span>
        <span className="text-muted-foreground">{label}</span>
        <span className="ml-auto text-foreground">{formatBytes(used)}</span>
        <span className="text-muted-foreground">/ {formatBytes(total)}</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{
            width: `${Math.min(100, pct)}%`,
            backgroundColor: `var(--${color})`,
            boxShadow: `0 0 6px var(--${color}-glow)`,
          }}
        />
      </div>
      <div className="mt-0.5 flex items-center justify-between text-[9px] font-mono text-muted-foreground">
        <span>{sublabel}</span>
        <span>{formatPercent(pct)}</span>
      </div>
    </div>
  )
}
