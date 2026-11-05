"use client"

import { create } from "zustand"
import { io as IoClient, type Socket } from "socket.io-client"

export type Strategy = "speed" | "balanced" | "memory" | "manual"
export type LayerLocation = "gpu" | "ram" | "nvme"

export interface ModelInfo {
  id: string
  repo: string
  name: string
  quant: string | null
  family: string | null
  contextSize: number
  sizeBytes: number
  layersCount: number
  status: string
  isPreset: boolean
  createdAt: string
}

export interface LayerInfo {
  index: number
  fileName: string
  sizeBytes: number
  location: LayerLocation
  pinned: boolean
  lastMs: number
  hits: number
}

export interface HardwareSnapshot {
  vramUsed: number
  vramTotal: number
  ramUsed: number
  ramTotal: number
  nvmeUsed: number
  nvmeTotal: number
  contextBytes: number
}

export interface ChatMessage {
  id?: string
  role: "user" | "assistant" | "system"
  content: string
  tokensOut?: number
  tokensPerSec?: number
  strategy?: string
  createdAt?: string
}

interface StudioState {
  // connection
  socket: Socket | null
  connected: boolean
  connect: () => void

  // models
  models: ModelInfo[]
  loadModels: () => Promise<void>
  currentModelId: string | null
  selectModel: (id: string | null) => void

  // sessions
  sessionId: string | null
  messages: ChatMessage[]
  streaming: boolean
  streamingText: string
  ensureSession: () => Promise<void>

  // layers + hw
  layers: LayerInfo[]
  activeLayerIndex: number | null
  activeLayerPaged: boolean
  hardware: HardwareSnapshot | null
  lastTokenStats: {
    tokensOut: number
    elapsedSec: number
    tokensPerSec: number
    pagedHits: number
    totalMs: number
  } | null

  // strategy
  strategy: Strategy
  setStrategy: (s: Strategy) => Promise<void>

  // engine status
  engineMode: "real" | "demo" | "unknown"
  engineRunning: boolean

  // forward-pass log — filled by socket events, capped at 50 entries
  passLog: PassLogEntry[]
  passLogRunId: number
  clearPassLog: () => void

  // actions
  loadEngine: () => Promise<void>
  sendChat: (prompt: string, opts?: { temperature?: number; maxTokens?: number; systemPrompt?: string }) => Promise<void>
  stopChat: () => void
  pinLayer: (index: number, location: LayerLocation, pinned: boolean) => Promise<void>

  // internal setters
  _set: <K extends keyof StudioState>(k: K, v: StudioState[K]) => void
}

export interface PassLogEntry {
  id: number
  layerIndex: number
  location: LayerLocation
  durationMs: number
  paged: boolean
  ts: number
}

const WS_PORT = 3003
// NEXT_PUBLIC_WS_URL (e.g. http://127.0.0.1:3003) connects straight to the
// inference service. The XTransformPort fallback only works behind the Caddy
// proxy on :81; opening the app on :3000 directly leaves the handshake with
// nowhere to go and the socket silently never connects.
const WS_URL = process.env.NEXT_PUBLIC_WS_URL

export const useStudio = create<StudioState>((set, get) => ({
  socket: null,
  connected: false,

  models: [],
  currentModelId: null,

  sessionId: null,
  messages: [],
  streaming: false,
  streamingText: "",

  layers: [],
  activeLayerIndex: null,
  activeLayerPaged: false,
  hardware: null,
  lastTokenStats: null,

  strategy: "balanced",

  engineMode: "unknown",
  engineRunning: false,

  passLog: [],
  passLogRunId: 0,
  clearPassLog: () => set({ passLog: [] }),

  _set: (k, v) => set({ [k]: v } as Pick<StudioState, typeof k>),

  connect: () => {
    if (get().socket) return
    // path: "/" MUST match the server's path: "/" — see mini-services/inference-service/index.ts
    const socket = IoClient(WS_URL || ("/?XTransformPort=" + WS_PORT), {
      path: "/",
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
    })
    socket.on("connect", () => set({ connected: true }))
    socket.on("disconnect", () => set({ connected: false }))

    socket.on("engine:loaded", (data: { modelId: string; strategy: Strategy; mode: "real" | "demo"; nGpuLayers?: number }) => {
      set((s) => ({
        engineMode: data.mode ?? "demo",
        engineRunning: true,
        strategy: data.strategy,
        passLog: [],
        passLogRunId: s.passLogRunId + 1,
      }))
    })
    socket.on("engine:unloaded", () => {
      set({ engineRunning: false, layers: [], hardware: null, currentModelId: null, passLog: [] })
    })
    socket.on("engine:idle", () => {
      set({ engineRunning: false })
    })
    socket.on("engine:error", (data: { error: string }) => {
      console.error("[engine:error]", data.error)
    })

    socket.on("layer:state", (data: { layers: LayerInfo[] }) => {
      set({ layers: data.layers })
    })
    let passLogId = 0
    socket.on("layer:step", (data: { layerIndex: number; paged: boolean; durationMs: number; location: LayerLocation }) => {
      set({ activeLayerIndex: data.layerIndex, activeLayerPaged: data.paged })
      set((s) => ({
        passLog: [
          {
            id: passLogId++,
            layerIndex: data.layerIndex,
            location: data.location,
            durationMs: data.durationMs,
            paged: data.paged,
            ts: Date.now(),
          },
          ...s.passLog,
        ].slice(0, 60),
      }))
    })
    socket.on("hw:snapshot", (data: HardwareSnapshot) => {
      set({ hardware: data })
    })

    socket.on("chat:start", () => {
      set({ streaming: true, streamingText: "" })
    })
    socket.on("chat:token", (data: { token: string }) => {
      set((s) => ({ streamingText: s.streamingText + data.token }))
    })
    socket.on("chat:done", (data: { content: string; tokensOut: number; elapsedSec: number; tokensPerSec: number; layerStats: { pagedHits: number; totalMs: number } }) => {
      const msg: ChatMessage = {
        role: "assistant",
        content: data.content,
        tokensOut: data.tokensOut,
        tokensPerSec: data.tokensPerSec,
      }
      set((s) => ({
        messages: [...s.messages, msg],
        streaming: false,
        streamingText: "",
        lastTokenStats: {
          tokensOut: data.tokensOut,
          elapsedSec: data.elapsedSec,
          tokensPerSec: data.tokensPerSec,
          pagedHits: data.layerStats?.pagedHits ?? 0,
          totalMs: data.layerStats?.totalMs ?? 0,
        },
        activeLayerIndex: null,
        activeLayerPaged: false,
      }))
      // Persist to DB so the session has it next load
      const sid = get().sessionId
      if (sid) {
        fetch(`/api/sessions/${sid}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: "assistant",
            content: data.content,
            tokensOut: data.tokensOut,
            tokensPerSec: data.tokensPerSec,
            strategy: get().strategy,
          }),
        }).catch(() => {})
      }
    })

    set({ socket })
  },

  loadModels: async () => {
    const res = await fetch("/api/models")
    const data = await res.json()
    set({ models: data.items ?? [] })
    // Auto-select the Qwen preset if nothing is selected
    if (!get().currentModelId && data.items.length > 0) {
      const qwen = data.items.find((m: ModelInfo) => m.repo.includes("Qwen3.8-27B"))
      get().selectModel(qwen?.id ?? data.items[0].id)
    }
  },

  selectModel: (id) => {
    set({ currentModelId: id, layers: [], hardware: null, messages: [], sessionId: null })
  },

  ensureSession: async () => {
    const modelId = get().currentModelId
    if (!modelId) return
    if (get().sessionId) return
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId, title: "New chat" }),
    })
    const data = await res.json()
    set({ sessionId: data.id })
  },

  loadEngine: async () => {
    const socket = get().socket
    const modelId = get().currentModelId
    if (!socket || !modelId) return
    await get().ensureSession()
    socket.emit("engine:load", { modelId, strategy: get().strategy })
  },

  unloadEngine: async () => {
    const socket = get().socket
    const modelId = get().currentModelId
    if (!socket || !modelId) return
    socket.emit("engine:unload")
  },

  setStrategy: async (s) => {
    set({ strategy: s })
    const socket = get().socket
    if (socket && get().engineRunning) {
      socket.emit("strategy:set", { strategy: s })
    }
    // Also re-apply on the REST API so a refresh keeps the placement
    const modelId = get().currentModelId
    if (modelId) {
      fetch(`/api/models/${modelId}/layers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: s }),
      }).catch(() => {})
    }
  },

  pinLayer: async (index, location, pinned) => {
    const socket = get().socket
    if (socket) {
      socket.emit("layer:pin", { index, location, pinned })
    }
    const modelId = get().currentModelId
    if (modelId) {
      fetch(`/api/layers/${modelId}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index, location, pinned }),
      }).catch(() => {})
    }
  },

  sendChat: async (prompt, opts) => {
    const socket = get().socket
    const sid = get().sessionId
    if (!socket || !sid) return
    // Optimistic user message
    set((s) => ({
      messages: [...s.messages, { role: "user", content: prompt }],
      streaming: true,
      streamingText: "",
    }))
    // Persist user message
    fetch(`/api/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "user", content: prompt, tokensIn: Math.ceil(prompt.length / 4) }),
    }).catch(() => {})

    socket.emit("chat:send", {
      sessionId: sid,
      prompt,
      systemPrompt: opts?.systemPrompt,
      temperature: opts?.temperature,
      maxTokens: opts?.maxTokens,
    })
  },

  stopChat: () => {
    const socket = get().socket
    socket?.emit("chat:stop")
    set({ streaming: false })
  },
}))
