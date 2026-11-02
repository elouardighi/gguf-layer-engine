"use client"

import { useEffect, useRef, useState } from "react"
import { useStudio } from "@/hooks/use-studio"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Slider } from "@/components/ui/slider"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Send, Square, Sparkles, Cpu, Activity, Layers } from "lucide-react"
import { formatTokensPerSec } from "@/lib/format"

export function ChatPanel() {
  const {
    currentModelId,
    models,
    sessionId,
    messages,
    streaming,
    streamingText,
    sendChat,
    stopChat,
    engineRunning,
    loadEngine,
    lastTokenStats,
  } = useStudio()
  const [input, setInput] = useState("")
  const [temperature, setTemperature] = useState(0.7)
  const [maxTokens, setMaxTokens] = useState(512)
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful AI assistant running on a layered GGUF model.")
  const scrollRef = useRef<HTMLDivElement>(null)

  const current = models.find((m) => m.id === currentModelId)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streamingText, streaming])

  async function handleSend() {
    const text = input.trim()
    if (!text || !sessionId || streaming) return
    setInput("")
    await sendChat(text, { temperature, maxTokens, systemPrompt })
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border px-4 py-2 flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          <span className="text-sm font-medium">Chat</span>
        </div>
        <div className="text-[10px] text-muted-foreground font-mono truncate">
          {current?.repo ?? "—"}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {lastTokenStats && (
            <Badge variant="outline" className="text-[9px] py-0 px-1.5 h-4 font-mono">
              <Activity className="h-2.5 w-2.5 mr-1 text-primary" />
              {formatTokensPerSec(lastTokenStats.tokensPerSec)}
            </Badge>
          )}
          {lastTokenStats && (
            <Badge variant="outline" className="text-[9px] py-0 px-1.5 h-4 font-mono">
              <Layers className="h-2.5 w-2.5 mr-1 text-ram" style={{ color: "var(--ram)" }} />
              {lastTokenStats.pagedHits} paged
            </Badge>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
        {!engineRunning && (
          <div className="text-center py-12">
            <Cpu className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-50" />
            <p className="text-sm text-muted-foreground mb-1">No model loaded</p>
            <p className="text-xs text-muted-foreground/70 mb-4">
              Pick a model on the left and click <span className="font-mono text-foreground/80">Load into engine</span> to start chatting.
            </p>
            {current && (
              <Button size="sm" variant="default" onClick={() => loadEngine()} className="h-7 text-[11px]">
                Load {current.name}
              </Button>
            )}
          </div>
        )}

        {engineRunning && messages.length === 0 && !streaming && (
          <div className="text-center py-12">
            <Sparkles className="h-10 w-10 text-primary/50 mx-auto mb-3" />
            <p className="text-sm font-medium mb-1">Engine ready</p>
            <p className="text-xs text-muted-foreground mb-4 max-w-xs mx-auto">
              The layer pager has placed your layers across GPU / RAM / NVMe. Send a prompt to start the forward pass.
            </p>
          </div>
        )}

        {messages.map((m, i) => (
          <MessageBubble key={m.id ?? i} role={m.role} content={m.content} tps={m.tokensPerSec} tokens={m.tokensOut} />
        ))}

        {streaming && (
          <MessageBubble role="assistant" content={streamingText || "…"} streaming />
        )}
      </div>

      {/* Controls */}
      <div className="border-t border-border px-4 py-2 bg-muted/10">
        <div className="grid grid-cols-2 gap-3 mb-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground w-20 shrink-0">temp</span>
            <Slider
              value={[temperature]}
              min={0}
              max={1.5}
              step={0.05}
              onValueChange={(v) => setTemperature(v[0])}
              className="flex-1"
            />
            <span className="text-[10px] font-mono w-8 text-right">{temperature.toFixed(2)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground w-20 shrink-0">max tok</span>
            <Slider
              value={[maxTokens]}
              min={64}
              max={2048}
              step={64}
              onValueChange={(v) => setMaxTokens(v[0])}
              className="flex-1"
            />
            <span className="text-[10px] font-mono w-10 text-right">{maxTokens}</span>
          </div>
        </div>

        <div className="relative">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={engineRunning ? "Send a message — Enter to send, Shift+Enter for newline" : "Load a model to start chatting"}
            disabled={!engineRunning}
            className="min-h-[60px] max-h-[120px] resize-none text-sm bg-muted/30 border-border pr-24"
          />
          <div className="absolute right-2 bottom-2 flex items-center gap-1">
            {streaming ? (
              <Button size="sm" variant="destructive" onClick={stopChat} className="h-7 text-[11px]">
                <Square className="h-3 w-3 mr-1" /> Stop
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleSend}
                disabled={!engineRunning || !input.trim()}
                className="h-7 text-[11px]"
              >
                <Send className="h-3 w-3 mr-1" /> Send
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function MessageBubble({
  role,
  content,
  streaming,
  tps,
  tokens,
}: {
  role: "user" | "assistant" | "system"
  content: string
  streaming?: boolean
  tps?: number
  tokens?: number
}) {
  const isUser = role === "user"
  return (
    <div className={"flex gap-3 " + (isUser ? "flex-row-reverse" : "")}>
      <div
        className={
          "h-7 w-7 shrink-0 rounded-md flex items-center justify-center text-[10px] font-mono " +
          (isUser ? "bg-muted text-muted-foreground" : "bg-primary/15 text-primary border border-primary/30")
        }
      >
        {isUser ? "you" : "ai"}
      </div>
      <div className={"max-w-[80%] " + (isUser ? "items-end" : "items-start")}>
        <div
          className={
            "rounded-lg px-3 py-2 text-sm leading-relaxed " +
            (isUser
              ? "bg-muted/40 text-foreground"
              : "bg-card border border-border/80 text-foreground") +
            (streaming ? " stream-caret" : "")
          }
        >
          <p className="whitespace-pre-wrap break-words">{content}</p>
        </div>
        {!isUser && (tps !== undefined || tokens !== undefined) && (
          <div className="mt-1 flex items-center gap-2 text-[9px] text-muted-foreground font-mono">
            {tokens !== undefined && <span>{tokens} tok</span>}
            {tps !== undefined && tps > 0 && <span>· {formatTokensPerSec(tps)}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
