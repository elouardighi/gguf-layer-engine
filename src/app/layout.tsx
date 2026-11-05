import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Layered AI Studio — GGUF Layer Engine",
  description:
    "Local web AI studio for layered GGUF models. Connects to Hugging Face, streams inference through a GPU/RAM/NVMe layer pager. Default target: Qwen3.8-27B-UD-Q4_K_XL layer package (65 layers, Mesh LLM).",
  keywords: ["AI studio", "GGUF", "layered model", "llama.cpp", "Mesh LLM", "Hugging Face", "Qwen3", "VRAM", "NVMe pager"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground min-h-screen`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
