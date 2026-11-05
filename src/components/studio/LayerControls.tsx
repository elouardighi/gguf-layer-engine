"use client"

import { useStudio, type Strategy } from "@/hooks/use-studio"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Badge } from "@/components/ui/badge"
import { Zap, Scale, MemoryStick, Hand, Gauge } from "lucide-react"

const STRATEGIES: { id: Strategy; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: "speed", label: "Speed", icon: <Zap className="h-3 w-3" />, desc: "Largest GPU prefix (~71% VRAM) — fastest tokens, most VRAM used" },
  { id: "balanced", label: "Balanced", icon: <Scale className="h-3 w-3" />, desc: "~57% of VRAM as a GPU prefix — the rest is mmap'd from RAM/NVMe" },
  { id: "memory", label: "Memory", icon: <MemoryStick className="h-3 w-3" />, desc: "~40% GPU prefix — smallest VRAM footprint, more paging" },
  { id: "manual", label: "Manual", icon: <Hand className="h-3 w-3" />, desc: "Offload only through your last GPU-pinned layer" },
]

export function LayerControls() {
  const { strategy, setStrategy, engineRunning } = useStudio()

  return (
    <div className="border-b border-border px-3 py-2">
      <div className="flex items-center gap-1.5 mb-2">
        <Gauge className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium">Strategy</span>
        {!engineRunning && (
          <Badge variant="outline" className="text-[9px] py-0 px-1 h-3.5 ml-auto">
            engine idle
          </Badge>
        )}
      </div>

      <ToggleGroup
        type="single"
        value={strategy}
        onValueChange={(v) => {
          if (v) setStrategy(v as Strategy)
        }}
        className="grid grid-cols-4 gap-1"
      >
        {STRATEGIES.map((s) => (
          <ToggleGroupItem
            key={s.id}
            value={s.id}
            className="flex flex-col items-center gap-0.5 h-auto py-1.5 px-1 text-[10px] data-[state=on]:bg-primary/15 data-[state=on]:text-primary data-[state=on]:border-primary/40"
            aria-label={s.label}
          >
            {s.icon}
            <span>{s.label}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <p className="mt-1.5 text-[9px] text-muted-foreground leading-tight min-h-[24px]">
        {STRATEGIES.find((s) => s.id === strategy)?.desc}
      </p>
    </div>
  )
}
