"use client"

import { useStudio } from "@/hooks/use-studio"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Activity, ArrowDown } from "lucide-react"
import { formatMs } from "@/lib/format"

export function InferenceLog() {
  const { passLog, engineRunning, lastTokenStats } = useStudio()

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-3 py-2 flex items-center gap-1.5">
        <Activity className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium">Forward pass log</span>
        {lastTokenStats && (
          <span className="ml-auto text-[9px] font-mono text-muted-foreground">
            {lastTokenStats.tokensOut} tok · {formatMs(lastTokenStats.totalMs)} total
          </span>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-3 py-2 font-mono text-[10px] space-y-0.5">
          {passLog.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              <ArrowDown className="h-4 w-4 mx-auto mb-1 opacity-40" />
              <p>{engineRunning ? "no forward passes yet" : "engine not loaded"}</p>
              <p className="text-[9px] mt-1">send a chat message to see layer transitions</p>
            </div>
          ) : (
            passLog.map((e) => (
              <div key={e.id} className="flex items-center gap-2 hover:bg-muted/30 px-1 py-0.5 rounded">
                <span className="text-muted-foreground w-16 shrink-0">
                  L{String(e.layerIndex).padStart(3, "0")}
                </span>
                <span
                  className="shrink-0"
                  style={{
                    color: `var(--${e.location})`,
                  }}
                >
                  {e.location.toUpperCase().padEnd(4)}
                </span>
                <span
                  className="shrink-0"
                  style={e.paged ? { color: "var(--ram)" } : { color: "var(--muted-foreground)" }}
                >
                  {e.paged ? "PAGED" : "     "}
                </span>
                <span className="ml-auto text-muted-foreground">{formatMs(e.durationMs)}</span>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
