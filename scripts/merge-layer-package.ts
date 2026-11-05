/**
 * Merge a Mesh LLM layer package back into one GGUF file.
 *
 * A package is a metadata "spine" (`shared/metadata.gguf`, which carries the
 * complete tensor table but no tensor data) plus one GGUF per layer and the
 * shared embedding/output artifacts. Each part carries the tensors for its
 * slice at file-local offsets; the spine records, for every tensor, which part
 * holds it, its global offset, its byte size and its alignment.
 *
 * The package is a lossless split of the original GGUF, so writing every part's
 * data section at its recorded global offset reconstructs a single GGUF that
 * llama.cpp can mmap and partially offload. No tensor is re-quantised or
 * decompressed — only byte ranges are copied.
 *
 * Usage:
 *   bun scripts/merge-layer-package.ts <package-dir> [--force]
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { basename, dirname, join, resolve } from "node:path"

const GGUF_MAGIC = 0x46554747
const COPY_CHUNK = 16 * 1024 * 1024

class Reader {
  buf: Buffer
  off = 0
  constructor(buf: Buffer) {
    this.buf = buf
  }
  u8() {
    return this.buf.readUInt8(this.off++)
  }
  u16() {
    const v = this.buf.readUInt16LE(this.off)
    this.off += 2
    return v
  }
  u32() {
    const v = this.buf.readUInt32LE(this.off)
    this.off += 4
    return v
  }
  u64() {
    const v = Number(this.buf.readBigUInt64LE(this.off))
    this.off += 8
    return v
  }
  str() {
    const n = this.u64()
    if (this.off + n > this.buf.length) throw new Error("GGUF string overruns header")
    const s = this.buf.toString("utf8", this.off, this.off + n)
    this.off += n
    return s
  }
  skip(type: number) {
    switch (type) {
      case 0:
      case 1:
      case 7:
        this.off += 1
        break
      case 2:
      case 3:
        this.off += 2
        break
      case 4:
      case 5:
      case 6:
        this.off += 4
        break
      case 8: {
        const n = this.u64()
        this.off += n
        break
      }
      case 9: {
        const item = this.u32()
        const n = this.u64()
        for (let i = 0; i < n; i++) this.skip(item)
        break
      }
      case 10:
      case 11:
      case 12:
        this.off += 8
        break
      default:
        throw new Error(`Unknown GGUF metadata type ${type}`)
    }
  }
}

interface TensorInfo {
  name: string
  dims: number[]
  type: number
  offset: number
}

interface GgufFile {
  path: string
  size: number
  version: number
  alignment: number
  dataStart: number
  dataLength: number
  tensors: TensorInfo[]
  kv: { key: string; raw: Buffer }[]
}

function alignUp(n: number, a: number) {
  return Math.ceil(n / a) * a
}

function parseGguf(path: string): GgufFile {
  const fd = openSync(path, "r")
  let buf: Buffer
  try {
    const size = fstatSync(fd).size
    // The spine is ~11 MB; part files carry the same KV block. Read enough for
    // the header and fall back to the whole file for very large headers.
    const window = Math.min(size, 128 * 1024 * 1024)
    buf = Buffer.alloc(window)
    readSync(fd, buf, 0, window, 0)
  } finally {
    closeSync(fd)
  }

  const r = new Reader(buf)
  if (r.u32() !== GGUF_MAGIC) throw new Error(`Not a GGUF file: ${path}`)
  const version = r.u32()
  const tensorCount = r.u64()
  const kvCount = r.u64()

  const kv: { key: string; raw: Buffer }[] = []
  let alignment = 32
  for (let i = 0; i < kvCount; i++) {
    const start = r.off
    const key = r.str()
    const type = r.u32()
    if (key === "general.alignment" && type === 4) {
      alignment = r.buf.readUInt32LE(r.off)
    }
    r.skip(type)
    kv.push({ key, raw: buf.subarray(start, r.off) })
  }

  const tensors: TensorInfo[] = []
  for (let i = 0; i < tensorCount; i++) {
    const name = r.str()
    const n = r.u32()
    const dims: number[] = []
    for (let d = 0; d < n; d++) dims.push(r.u64())
    const type = r.u32()
    const offset = r.u64()
    tensors.push({ name, dims, type, offset })
  }

  const dataStart = alignUp(r.off, alignment)
  return {
    path,
    size: statSync(path).size,
    version,
    alignment,
    dataStart,
    dataLength: statSync(path).size - dataStart,
    tensors,
    kv,
  }
}

/** Read the `skippy.package.*` locator arrays from the spine's KV block. */
function readSkippyLocator(spine: GgufFile) {
  const fd = openSync(spine.path, "r")
  const head = Buffer.alloc(spine.dataStart)
  try {
    readSync(fd, head, 0, head.length, 0)
  } finally {
    closeSync(fd)
  }
  const r = new Reader(head)
  r.u32()
  r.u32()
  r.u64()
  const kvCount = r.u64()
  const values: Record<string, unknown> = {}
  for (let i = 0; i < kvCount; i++) {
    const key = r.str()
    const type = r.u32()
    if (key.startsWith("skippy.package.") && type === 9) {
      const itemType = r.u32()
      const n = r.u64()
      const out: number[] = []
      for (let j = 0; j < n; j++) {
        if (itemType === 4) out.push(r.u32())
        else if (itemType === 10) out.push(r.u64())
        else if (itemType === 0) out.push(r.u8())
        else throw new Error(`Unsupported locator item type ${itemType}`)
      }
      values[key] = out
    } else {
      r.skip(type)
    }
  }
  return {
    parts: values["skippy.package.tensor_part"] as number[] | undefined,
    offsets: values["skippy.package.tensor_offset"] as number[] | undefined,
    sizes: values["skippy.package.tensor_size"] as number[] | undefined,
    alignments: values["skippy.package.tensor_alignment"] as number[] | undefined,
  }
}

function findPartFiles(packageDir: string): string[] {
  const files: string[] = []
  for (const sub of ["shared", "layers"]) {
    const dir = join(packageDir, sub)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).sort()) {
      if (!name.toLowerCase().endsWith(".gguf")) continue
      if (name === "metadata.gguf" && sub === "shared") continue
      files.push(join(dir, name))
    }
  }
  return files
}

function copyRange(srcFd: number, dstFd: number, srcStart: number, dstStart: number, length: number, progress?: (done: number) => void) {
  const buf = Buffer.allocUnsafe(Math.min(COPY_CHUNK, Math.max(1, length)))
  let done = 0
  while (done < length) {
    const want = Math.min(buf.length, length - done)
    readSync(srcFd, buf, 0, want, srcStart + done)
    writeSync(dstFd, buf, 0, want, dstStart + done)
    done += want
    progress?.(done)
  }
}

/** Byte-compare equal-length ranges of two files (used to verify duplicate tensor copies). */
function rangesEqual(aPath: string, aStart: number, bPath: string, bStart: number, length: number): boolean {
  const fdA = openSync(aPath, "r")
  const fdB = openSync(bPath, "r")
  try {
    const bufA = Buffer.allocUnsafe(COPY_CHUNK)
    const bufB = Buffer.allocUnsafe(COPY_CHUNK)
    let done = 0
    while (done < length) {
      const want = Math.min(COPY_CHUNK, length - done)
      readSync(fdA, bufA, 0, want, aStart + done)
      readSync(fdB, bufB, 0, want, bStart + done)
      if (!bufA.subarray(0, want).equals(bufB.subarray(0, want))) return false
      done += want
    }
    return true
  } finally {
    closeSync(fdA)
    closeSync(fdB)
  }
}

async function merge(packageDir: string, force: boolean) {
  const pkg = resolve(packageDir)
  const manifestPath = join(pkg, "model-package.json")
  if (!existsSync(manifestPath)) throw new Error(`Not a layer package (no model-package.json): ${pkg}`)
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    model_id?: string
    package_id?: string
    layer_count?: number
    source_model?: { primary_file?: string }
  }

  const spinePath = join(pkg, "shared", "metadata.gguf")
  if (!existsSync(spinePath)) throw new Error(`Missing package spine: ${spinePath}`)

  const spine = parseGguf(spinePath)
  const locator = readSkippyLocator(spine)
  const partFiles = findPartFiles(pkg)
  if (partFiles.length === 0) throw new Error("No package part files found")

  const parts = partFiles.map(parseGguf)
  if (
    !locator.offsets ||
    !locator.sizes ||
    locator.offsets.length !== spine.tensors.length ||
    locator.sizes.length !== spine.tensors.length
  ) {
    throw new Error("Package spine is missing the per-tensor locator tables")
  }
  const offsets = locator.offsets

  // Shared tensors — e.g. the hyper-connection weights, which every part of this
  // model physically carries a copy of — mean a name can occur in many files.
  // The locator's offset records where the tensor sits inside its home part, so
  // the recorded offset picks the right copy; when several files claim the same
  // offset their bytes are verified identical instead of trusting one of them.
  const candidates = new Map<string, { file: GgufFile; tensor: TensorInfo }[]>()
  for (const file of parts) {
    for (const tensor of file.tensors) {
      const arr = candidates.get(tensor.name)
      if (arr) arr.push({ file, tensor })
      else candidates.set(tensor.name, [{ file, tensor }])
    }
  }

  const byName = new Map<string, { file: GgufFile; tensor: TensorInfo }>()
  for (let i = 0; i < spine.tensors.length; i++) {
    const name = spine.tensors[i].name
    const hits = (candidates.get(name) ?? []).filter((c) => c.file.dataStart + c.tensor.offset === offsets[i])
    if (hits.length === 0) throw new Error(`No part file holds ${name} at the recorded locator offset`)
    for (let j = 1; j < hits.length; j++) {
      if (hits[j].file.path === hits[0].file.path) continue
      if (!rangesEqual(hits[0].file.path, offsets[i], hits[j].file.path, offsets[i], locator.sizes[i])) {
        throw new Error(`Tensor ${name} appears in more than one part with differing bytes`)
      }
    }
    byName.set(name, hits[0])
  }
  const baseByPath = new Map<string, number>()

  // Verify the spine covers every tensor exactly once, and that each part's
  // tensors all sit at one constant delta from their global offsets.
  const missing: string[] = []
  const globalOffsets = new Map<string, number>()
  for (const tensor of spine.tensors) {
    const part = byName.get(tensor.name)
    if (!part) {
      missing.push(tensor.name)
      continue
    }
    const delta = tensor.offset - part.tensor.offset
    if (delta < 0) throw new Error(`Negative global offset delta for ${tensor.name}`)
    const existing = baseByPath.get(part.file.path)
    if (existing === undefined) baseByPath.set(part.file.path, delta)
    else if (existing !== delta) throw new Error(`Inconsistent global base for ${part.file.path}`)
    globalOffsets.set(tensor.name, tensor.offset)
  }
  if (missing.length > 0) throw new Error(`Spine references ${missing.length} tensors with no part file: ${missing.slice(0, 5).join(", ")}`)
  if (byName.size !== spine.tensors.length) throw new Error(`Part files contain ${byName.size} tensors but the spine declares ${spine.tensors.length}`)

  // Cross-check the recorded sizes against the spine's tensor table. The
  // locator offset is the tensor's absolute offset inside its part file, while
  // the spine stores the tensor's global offset in the merged model.
  if (locator.offsets && locator.sizes) {
    for (let i = 0; i < spine.tensors.length; i++) {
      const t = spine.tensors[i]
      const part = byName.get(t.name)
      if (!part) continue
      if (locator.offsets[i] !== part.file.dataStart + part.tensor.offset) {
        throw new Error(`Locator offset mismatch for ${t.name}`)
      }
      const localNext = part.file.tensors
        .filter((x) => x.offset > part.tensor.offset)
        .sort((a, b) => a.offset - b.offset)[0]
      const localEnd = localNext ? localNext.offset : part.file.dataLength
      if (locator.sizes[i] > localEnd - part.tensor.offset) {
        throw new Error(`Recorded size for ${t.name} overruns its part file`)
      }
    }
  }

  // The merged file keeps the spine's tensor table (offsets are already global)
  // but drops the package locator keys, which only describe the split layout.
  const keptKv = spine.kv.filter((x) => !x.key.startsWith("skippy.package."))
  const kvBytes = Buffer.concat(keptKv.map((x) => x.raw))

  const tensorInfoChunks: Buffer[] = []
  for (const t of spine.tensors) {
    const nameBuf = Buffer.from(t.name, "utf8")
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(BigInt(nameBuf.length))
    const nDims = Buffer.alloc(4)
    nDims.writeUInt32LE(t.dims.length)
    const dims = Buffer.alloc(8 * t.dims.length)
    t.dims.forEach((d, i) => dims.writeBigUInt64LE(BigInt(d), i * 8))
    const type = Buffer.alloc(4)
    type.writeUInt32LE(t.type)
    const offset = Buffer.alloc(8)
    offset.writeBigUInt64LE(BigInt(t.offset))
    tensorInfoChunks.push(len, nameBuf, nDims, dims, type, offset)
  }
  const tensorInfoBytes = Buffer.concat(tensorInfoChunks)

  const header = Buffer.alloc(24)
  header.writeUInt32LE(GGUF_MAGIC, 0)
  header.writeUInt32LE(spine.version, 4)
  header.writeBigUInt64LE(BigInt(spine.tensors.length), 8)
  header.writeBigUInt64LE(BigInt(keptKv.length), 16)

  const prefixLength = 24 + kvBytes.length + tensorInfoBytes.length
  const dataStart = alignUp(prefixLength, spine.alignment)

  if (!locator.sizes || locator.sizes.length !== spine.tensors.length) {
    throw new Error("Package spine is missing the per-tensor size table")
  }

  let maxEnd = 0
  for (let i = 0; i < spine.tensors.length; i++) {
    const t = spine.tensors[i]
    const part = byName.get(t.name)!
    const localEnd = part.tensor.offset + locator.sizes[i]
    if (localEnd > part.file.dataLength) throw new Error(`Tensor ${t.name} overruns its part file`)
    const end = t.offset + locator.sizes[i]
    if (end > maxEnd) maxEnd = end
  }
  const totalSize = dataStart + maxEnd

  const outDir = join(pkg, "merged")
  // The primary file lives in a quant subdir (e.g. `UD-IQ4_XS/model.gguf`);
  // flatten to a single file inside `merged/` because findMergedGguf reads
  // that directory non-recursively.
  const outName =
    basename((manifest.source_model?.primary_file ?? `${basename(pkg)}.gguf`).replace(/\.gguf$/i, "")) +
    ".merged.gguf"
  const finalPath = join(outDir, outName)
  if (existsSync(finalPath) && statSync(finalPath).size === totalSize && !force) {
    console.log(`[merge] already complete: ${finalPath} (${(totalSize / 1e9).toFixed(2)} GB)`)
    return { path: finalPath, bytes: totalSize }
  }

  mkdirSync(dirname(finalPath), { recursive: true })
  const tempPath = `${finalPath}.part`
  rmSync(tempPath, { force: true })

  console.log(
    `[merge] ${spine.tensors.length} tensors from ${parts.length} parts -> ${finalPath} (${(totalSize / 1e9).toFixed(2)} GB)`,
  )
  const started = Date.now()
  const dst = openSync(tempPath, "w")
  try {
    writeSync(dst, header, 0, header.length, 0)
    writeSync(dst, kvBytes, 0, kvBytes.length, header.length)
    writeSync(dst, tensorInfoBytes, 0, tensorInfoBytes.length, header.length + kvBytes.length)
    ftruncateSync(dst, totalSize)

    let copiedBytes = 0
    const openCache = new Map<string, number>()
    try {
      for (let i = 0; i < spine.tensors.length; i++) {
        const t = spine.tensors[i]
        const part = byName.get(t.name)!
        let src = openCache.get(part.file.path)
        if (src === undefined) {
          src = openSync(part.file.path, "r")
          openCache.set(part.file.path, src)
        }
        copyRange(src, dst, part.file.dataStart + part.tensor.offset, dataStart + t.offset, locator.sizes[i])
        copiedBytes += locator.sizes[i]
        if (i % 64 === 0 || i === spine.tensors.length - 1) {
          const secs = (Date.now() - started) / 1000
          console.log(
            `[merge] ${i + 1}/${spine.tensors.length} tensors, ${(copiedBytes / 1e9).toFixed(2)} GB, ${(copiedBytes / 1e6 / Math.max(1, secs)).toFixed(0)} MB/s`,
          )
        }
      }
    } finally {
      for (const fd of openCache.values()) closeSync(fd)
    }
  } finally {
    closeSync(dst)
  }

  const finalSize = statSync(tempPath).size
  if (finalSize !== totalSize) throw new Error(`Merged size mismatch: expected ${totalSize}, got ${finalSize}`)
  renameSync(tempPath, finalPath)

  const digest = createHash("sha256")
  // Hash only the header + tensor table so the report is cheap; tensor bytes
  // are verified by size and locator metadata.
  digest.update(header)
  digest.update(kvBytes)
  digest.update(tensorInfoBytes)
  writeFileSync(
    join(outDir, "merge.json"),
    JSON.stringify(
      {
        package_id: manifest.package_id,
        model_id: manifest.model_id,
        layers: manifest.layer_count,
        tensors: spine.tensors.length,
        parts: parts.length,
        bytes: finalSize,
        header_sha256: digest.digest("hex"),
        created_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  )

  console.log(`[merge] done in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${finalPath}`)
  return { path: finalPath, bytes: finalSize }
}

const args = process.argv.slice(2)
const packageDir = args.find((a) => !a.startsWith("--"))
if (!packageDir) {
  console.error("Usage: bun scripts/merge-layer-package.ts <package-dir> [--force]")
  process.exit(1)
}

merge(packageDir, args.includes("--force"))
  .then((r) => {
    console.log(JSON.stringify(r))
    process.exit(0)
  })
  .catch((err) => {
    console.error("[merge] failed:", err instanceof Error ? err.message : err)
    process.exit(1)
  })
