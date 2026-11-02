/**
 * Next.js instrumentation — runs once on server startup.
 *
 * We use this to spawn the inference WebSocket service as a child of the
 * Next.js dev server. Because Next.js itself is started by the platform's
 * dev.sh and is persistent, this is the most reliable way to keep the
 * WebSocket service alive in the sandbox.
 *
 * The child process inherits stdout/stderr from Next.js so its logs show
 * up in dev.log.
 */

export async function register() {
  // Only run on the server (not during build)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { spawn } = await import("node:child_process")
    const { join } = await import("node:path")
    const { existsSync } = await import("node:fs")

    const serviceDir = join(process.cwd(), "mini-services", "inference-service")
    const indexFile = join(serviceDir, "index.ts")
    if (!existsSync(indexFile)) {
      console.warn("[instrumentation] inference-service not found at", serviceDir)
      return
    }

    console.log("[instrumentation] spawning inference-service as a child process")
    const child = spawn("bun", ["index.ts"], {
      cwd: serviceDir,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        // Make sure Prisma can find the schema
        PRISMA_SCHEMA_PATH: join(process.cwd(), "prisma", "schema.prisma"),
      },
    })

    child.on("exit", (code, signal) => {
      console.log(`[instrumentation] inference-service exited code=${code} signal=${signal}`)
    })
    child.on("error", (err) => {
      console.error("[instrumentation] inference-service error:", err)
    })

    // Don't keep the event loop alive just for the child — Next.js manages
    // its own lifecycle. But _do_ unref so we don't block Next.js shutdown.
    child.unref()
  }
}
