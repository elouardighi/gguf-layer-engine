"use client"

import { useEffect } from "react"
import { useStudio } from "@/hooks/use-studio"
import { useToast } from "@/hooks/use-toast"
import { Badge } from "@/components/ui/badge"
import { Cpu, Wifi, WifiOff, Zap } from "lucide-react"

export function TopBar() {
  const { connected, engineMode, engineRunning, currentModelId, models, strategy, connect } = useStudio()
  const { toast } = useToast()

  useEffect(() => {
    connect()
  }, [connect])

  const current = models.find((m) => m.id === currentModelId)

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/85 backdrop-blur px-4">
      <div className="flex items-center gap-2">
        <div className="relative flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 border border-primary/30">
          <Zap className="h-4 w-4 text-primary" />
        </div>
        <div className="flex flex-col leading-none">
          <span className="text-sm font-semibold tracking-tight">Layered AI Studio</span>
          <span className="text-[10px] text-muted-foreground font-mono">GGUF layer engine</span>
        </div>
      </div>

      <div className="ml-2 hidden md:flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{current?.repo ?? "no model"}</span>
        {current?.quant && (
          <Badge variant="outline" className="text-[10px] py-0 px-1.5 h-4 border-primary/40 text-primary">
            {current.quant}
          </Badge>
        )}
        {current && (
          <Badge variant="outline" className="text-[10px] py-0 px-1.5 h-4">
            {current.layersCount} layers
          </Badge>
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-[11px]">
          <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground font-mono">strategy:</span>
          <Badge variant="secondary" className="text-[10px] py-0 px-1.5 h-4 capitalize">
            {strategy}
          </Badge>
        </div>

        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-muted-foreground font-mono">engine:</span>
          <Badge
            variant="outline"
            className={
              "text-[10px] py-0 px-1.5 h-4 capitalize " +
              (engineMode === "real"
                ? "border-primary/50 text-primary"
                : engineMode === "demo"
                ? "border-ram/50 text-ram"
                : "border-muted-foreground/40 text-muted-foreground")
            }
            style={
              engineMode === "demo"
                ? { color: "var(--ram)", borderColor: "var(--ram)" }
                : undefined
            }
          >
            {engineMode === "unknown" ? "idle" : engineMode}
          </Badge>
        </div>

        <button
          onClick={() => toast({ title: "Studio ready", description: "Layer engine connected" })}
          className="flex items-center gap-1.5 text-[11px] rounded-md border border-border px-2 py-1 hover:border-primary/40 transition-colors"
          aria-label="connection status"
        >
          {connected ? (
            <>
              <Wifi className="h-3.5 w-3.5 text-primary live-pulse" />
              <span className="font-mono text-primary">connected</span>
            </>
          ) : (
            <>
              <WifiOff className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-mono text-muted-foreground">offline</span>
            </>
          )}
        </button>
      </div>
    </header>
  )
}
