/**
 * Minimal GGUF metadata reader.
 *
 * We only need the header metadata (architecture, block/layer count, context
 * length, name) so the studio can model a downloaded model as its real
 * transformer layers instead of an opaque blob. Tensor data is never read.
 */

import { closeSync, openSync, readSync, fstatSync } from "node:fs"

export interface GgufMeta {
  version: number
  tensorCount: number
  kvCount: number
  architecture?: string
  blockCount?: number
  contextLength?: number
  embeddingLength?: number
  name?: string
}

const GGUF_MAGIC = 0x46554747 // "GGUF" little-endian
const MAX_HEADER_BYTES = 256 * 1024 * 1024

class Cursor {
  offset = 0
  constructor(private buf: Buffer) {}

  get remaining() {
    return this.buf.length - this.offset
  }

  u8() {
    this.ensure(1)
    return this.buf.readUInt8(this.offset++)
  }

  u16() {
    this.ensure(2)
    const v = this.buf.readUInt16LE(this.offset)
    this.offset += 2
    return v
  }

  u32() {
    this.ensure(4)
    const v = this.buf.readUInt32LE(this.offset)
    this.offset += 4
    return v
  }

  i32() {
    this.ensure(4)
    const v = this.buf.readInt32LE(this.offset)
    this.offset += 4
    return v
  }

  u64() {
    this.ensure(8)
    const v = this.buf.readBigUInt64LE(this.offset)
    this.offset += 8
    return Number(v)
  }

  i64() {
    this.ensure(8)
    const v = this.buf.readBigInt64LE(this.offset)
    this.offset += 8
    return Number(v)
  }

  f32() {
    this.ensure(4)
    const v = this.buf.readFloatLE(this.offset)
    this.offset += 4
    return v
  }

  f64() {
    this.ensure(8)
    const v = this.buf.readDoubleLE(this.offset)
    this.offset += 8
    return v
  }

  str() {
    const len = this.u64()
    if (len > this.remaining) throw new Error(`GGUF string overruns header (${len} bytes)`)
    const s = this.buf.toString("utf8", this.offset, this.offset + len)
    this.offset += len
    return s
  }

  ensure(n: number) {
    if (this.offset + n > this.buf.length) {
      throw new Error("GGUF metadata is larger than the read window")
    }
  }

  /** Skip a value of `type` without allocating strings. */
  skip(type: number) {
    switch (type) {
      case 0:
      case 1:
        this.offset += 1
        break
      case 2:
      case 3:
        this.offset += 2
        break
      case 4:
      case 5:
        this.offset += 4
        break
      case 6:
        this.offset += 4
        break
      case 7:
        this.offset += 1
        break
      case 8: {
        const len = this.u64()
        this.offset += len
        break
      }
      case 9: {
        const itemType = this.u32()
        const count = this.u64()
        for (let i = 0; i < count; i++) this.skip(itemType)
        break
      }
      case 10:
      case 11:
      case 12:
        this.offset += 8
        break
      default:
        throw new Error(`Unknown GGUF metadata type ${type}`)
    }
    this.ensure(0)
  }

  value(type: number): string | number | boolean | null {
    switch (type) {
      case 0:
        return this.u8()
      case 1:
        return this.u8() << 24 >> 24
      case 2:
        return this.u16()
      case 3:
        return this.u16() << 16 >> 16
      case 4:
        return this.u32()
      case 5:
        return this.i32()
      case 6:
        return this.f32()
      case 7:
        return this.u8() !== 0
      case 8:
        return this.str()
      case 10:
        return this.u64()
      case 11:
        return this.i64()
      case 12:
        return this.f64()
      case 9: {
        // Arrays are not interesting for us — skip them.
        this.u32() // item type
        const count = this.u64()
        this.offset += 0
        // We can't skip without the item type, so re-read from the right spot.
        // (Kept for completeness; handled in readGgufMeta instead.)
        void count
        throw new Error("Array values are skipped by the caller")
      }
      default:
        throw new Error(`Unknown GGUF metadata type ${type}`)
    }
  }
}

/** Read metadata from a GGUF file. Returns only the fields the studio needs. */
export function readGgufMeta(filePath: string): GgufMeta {
  const fd = openSync(filePath, "r")
  try {
    const size = fstatSync(fd).size
    const window = Math.min(size, MAX_HEADER_BYTES)
    const buf = Buffer.alloc(window)
    readSync(fd, buf, 0, window, 0)

    const c = new Cursor(buf)
    const magic = c.u32()
    if (magic !== GGUF_MAGIC) throw new Error("Not a GGUF file")

    const version = c.u32()
    const tensorCount = c.u64()
    const kvCount = c.u64()

    const meta: GgufMeta = { version, tensorCount, kvCount }

    for (let i = 0; i < kvCount; i++) {
      if (c.remaining < 8) break
      const key = c.str()
      const type = c.u32()

      if (type === 9) {
        // Array — skip contents, we don't need them.
        const itemType = c.u32()
        const count = c.u64()
        const saved = c.offset
        try {
          for (let j = 0; j < count; j++) c.skip(itemType)
        } catch {
          c.offset = saved
          break
        }
        continue
      }

      const value = c.value(type)

      if (key === "general.architecture" && typeof value === "string") meta.architecture = value
      else if (key === "general.name" && typeof value === "string") meta.name = value
      else if (key.endsWith(".block_count") && typeof value === "number") meta.blockCount = value
      else if (key.endsWith(".context_length") && typeof value === "number") meta.contextLength = value
      else if (key.endsWith(".embedding_length") && typeof value === "number") meta.embeddingLength = value

      // Everything we care about is near the top; once we have it we can stop.
      if (meta.architecture && meta.blockCount && meta.contextLength && meta.name) break
    }

    return meta
  } finally {
    closeSync(fd)
  }
}
