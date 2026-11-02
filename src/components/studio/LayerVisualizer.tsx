"use client"

import { useStudio, type LayerInfo } from "@/hooks/use-studio"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Layers, Pin } from "lucide-react"
import { formatBytes, formatMs } from "@/lib/format"
import { useState } from "react"

const COLS = 10

export function LayerVisualizer() {
  const { layers, activeLayerIndex, activeLayerPaged, engineRunning } = useStudio()

  const gpuCount = layers.filter((l) => l.location === "gpu").length
  const ramCount = layers.filter((l) => l.location === "ram").length
  const nvmeCount = layers.filter((l) => l.location === "nvme").length
  const pinnedCount = layers.filter((l) => l.pinned).length

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2 flex items-center gap-2">
        <Layers className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium">Layer pipeline</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Legend color="gpu" label="GPU" count={gpuCount} />
          <Legend color="ram" label="RAM" count={ramCount} />
          <Legend color="nvme" label="NVMe" count={nvmeCount} />
        </div>
      </div>

      {/* Active layer ticker */}
      <div className="border-b border-border px-3 py-1.5 bg-muted/15">
        <div className="flex items-center gap-2 text-[10px] font-mono">
          <span className="text-muted-foreground">active:</span>
          {activeLayerIndex !== null ? (
            <span className="text-foreground">
              layer-{String(activeLayerIndex).padStart(5, "0")}
              <span className="text-muted-foreground">.gguf</span>
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
          {activeLayerPaged && (
            <Badge variant="outline" className="text-[9px] py-0 px-1 h-3.5 border-ram/50" style={{ color: "var(--ram)", borderColor: "var(--ram)" }}>
              paged from NVMe
            </Badge>
          )}
          {pinnedCount > 0 && (
            <Badge variant="outline" className="text-[9px] py-0 px-1 h-3.5 ml-auto">
              <Pin className="h-2 w-2 mr-0.5" />
              {pinnedCount} pinned
            </Badge>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3">
          {layers.length === 0 ? (
            <div className="text-center py-10">
                  <Layers className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-40" />
                  <p className="text-xs text-muted-foreground">
                    {engineRunning ? "Loading layer state…" : "Load a model to see its layer map"}
                  </p>
                </div>
          ) : (
            <TooltipProvider delayDuration={120}>
              <div
                className="grid gap-1.5"
                style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }}
              >
                {layers.map((l) => (
                  <LayerCell key={l.index} layer={l} active={l.index === activeLayerIndex} />
                ))}
              </div>
            </TooltipProvider>
          )}
        </div>
      </ScrollArea>

      <div className="border-t border-border px-3 py-1.5 bg-muted/15 text-[10px] font-mono text-muted-foreground">
        {layers.length} layers · {formatBytes(layers.reduce((s, l) => s + l.sizeBytes, 0))} total
      </div>
    </div>
  )
}

function Legend({ color, label, count }: { color: "gpu" | "ram" | "nvme"; label: string; count: number }) {
  return (
    <div className="flex items-center gap-1">
      <span
        className="inline-block h-2 w-2 rounded-sm"
        style={{
          backgroundColor: `var(--${color})`,
          boxShadow: `0 0 4px var(--${color}-glow)`,
        }}
      />
      <span className="text-[9px] font-mono text-muted-foreground">{label}</span>
      <span className="text-[9px] font-mono text-foreground">{count}</span>
    </div>
  )
}

function LayerCell({ layer, active }: { layer: LayerInfo; active: boolean }) {
  const { pinLayer } = useStudio()
  const [menu, setMenu] = useState(false)

  const cls =
    "layer-cell relative h-7 rounded-sm cursor-pointer flex items-center justify-center text-[8px] font-mono " +
    `layer-cell-${layer.location}` +
    (active ? " layer-cell-active" : "") +
    (layer.pinned ? " layer-cell-pinned" : "")

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cls}
          onClick={(e) => {
            e.stopPropagation()
            // Click = pin to GPU, shift-click = unpin
            pinLayer(layer.index, layer.pinned ? "nvme" : "gpu", !layer.pinned)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu(!menu)
          }}
        >
          {layer.pinned && <Pin className="h-2.5 w-2.5" />}
          {!layer.pinned && <span className="opacity-70">{layer.index}</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[10px] font-mono p-2">
        <div className="space-y-0.5">
          <div className="text-foreground">{layer.fileName}</div>
          <div className="text-muted-foreground">{formatBytes(layer.sizeBytes)} · {layer.location.toUpperCase()}</div>
          <div className="text-muted-foreground">{formatMs(layer.lastMs)} · {layer.hits} hits</div>
          <div className="text-primary/80 pt-0.5 border-t border-border mt-0.5">click to {layer.pinned ? "unpin" : "pin to GPU"}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
