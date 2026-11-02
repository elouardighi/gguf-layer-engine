"use client"

import { useEffect } from "react"
import { useStudio } from "@/hooks/use-studio"
import { TopBar } from "@/components/studio/TopBar"
import { ModelBrowser } from "@/components/studio/ModelBrowser"
import { ChatPanel } from "@/components/studio/ChatPanel"
import { LayerVisualizer } from "@/components/studio/LayerVisualizer"
import { HardwareMonitor } from "@/components/studio/HardwareMonitor"
import { LayerControls } from "@/components/studio/LayerControls"
import { InferenceLog } from "@/components/studio/InferenceLog"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Layers, Sparkles, Activity, Gauge } from "lucide-react"

export default function Home() {
  const { connect, loadModels, currentModelId } = useStudio()

  useEffect(() => {
    connect()
    loadModels()
  }, [connect, loadModels])

  return (
    <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
      <TopBar />

      <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0">
        {/* Left: Model browser */}
        <ResizablePanel defaultSize={22} minSize={16} maxSize={32} className="bg-sidebar/40 border-r border-border">
          <ModelBrowser />
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Center: Chat */}
        <ResizablePanel defaultSize={42} minSize={28}>
          <ChatPanel />
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right: Layer visualizer + hardware + controls + log */}
        <ResizablePanel defaultSize={36} minSize={28} maxSize={48} className="bg-sidebar/40 border-l border-border">
          <ResizablePanelGroup direction="vertical">
            <ResizablePanel defaultSize={55} minSize={30}>
              <SectionHeader icon={<Layers className="h-3.5 w-3.5 text-primary" />} title="Layer visualizer" />
              <div className="h-[calc(100%-2rem)]">
                <LayerVisualizer />
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={20} minSize={12}>
              <HardwareMonitor />
              <LayerControls />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={25} minSize={12}>
              <SectionHeader icon={<Activity className="h-3.5 w-3.5 text-primary" />} title="Inference log" />
              <div className="h-[calc(100%-2rem)]">
                <InferenceLog />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>

      <footer className="border-t border-border bg-background/85 backdrop-blur px-4 py-1.5 flex items-center gap-4 text-[10px] font-mono text-muted-foreground">
        <span className="flex items-center gap-1">
          <Sparkles className="h-3 w-3 text-primary" />
          Layered AI Studio
        </span>
        <span className="hidden sm:inline">click a layer to pin it to GPU · shift-click to unpin</span>
        <span className="ml-auto">
          {currentModelId ? "engine: ready" : "engine: idle"}
        </span>
      </footer>
    </div>
  )
}

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="h-8 border-b border-border bg-muted/15 flex items-center gap-1.5 px-3">
      {icon}
      <span className="text-xs font-medium">{title}</span>
    </div>
  )
}
