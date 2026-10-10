// Durable ingestion journal (plan §3). Append-only segment files of framed records:
//   [magic "WJR1"][u32 payload length][u32 CRC32(payload)][payload = JSON]
// Frame kinds:  h = segment header {epoch}, r = record {j: jseq, ...}, m = auth-counter mark.
// A record is "captured" once append() returns (write + fsync done).
import {
  closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync, renameSync
} from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'

const MAGIC = Buffer.from('WJR1')
const HDR = 12
const MAX_RECORD = 16 * 1024 * 1024
const segName = n => `${String(n).padStart(8, '0')}.log`

export class EpochMismatchError extends Error {}

export const encodeFrame = obj => {
  const payload = Buffer.from(JSON.stringify(obj))
  const head = Buffer.alloc(HDR)
  MAGIC.copy(head, 0)
  head.writeUInt32LE(payload.length, 4)
  head.writeUInt32LE(crc32(payload), 8)
  return Buffer.concat([head, payload])
}

// Returns { obj, end } for a valid frame at `off`, null otherwise (short, bad magic, bad CRC, bad JSON).
const tryFrame = (buf, off) => {
  if (buf.length - off < HDR || buf.compare(MAGIC, 0, 4, off, off + 4) !== 0) return null
  const len = buf.readUInt32LE(off + 4)
  if (len > MAX_RECORD || off + HDR + len > buf.length) return null
  const payload = buf.subarray(off + HDR, off + HDR + len)
  if (crc32(payload) !== buf.readUInt32LE(off + 8)) return null
  try { return { obj: JSON.parse(payload), end: off + HDR + len } } catch { return null }
}

/**
 * Scans a whole segment buffer. An invalid frame followed later by a valid one is mid-file
 * corruption (`bad` range); an invalid frame with nothing valid after it is a torn tail.
 */
export const scanBuffer = buf => {
  const frames = []
  const bad = []
  let off = 0
  while (off < buf.length) {
    const f = tryFrame(buf, off)
    if (f) { frames.push({ ...f, start: off }); off = f.end; continue }
    let next = buf.indexOf(MAGIC, off + 1)
    while (next !== -1 && !tryFrame(buf, next)) next = buf.indexOf(MAGIC, next + 1)
    if (next === -1) return { frames, bad, tornAt: off }
    bad.push({ start: off, end: next })
    off = next
  }
  return { frames, bad, tornAt: null }
}

export class Journal {
  constructor ({ dir, epoch, maxSegmentBytes = 64 * 1024 * 1024, rotateMs = 3600_000, reserveBytes = 0, log, hooks = {} }) {
    Object.assign(this, { dir, epoch, maxSegmentBytes, rotateMs, reserveBytes, log, hooks })
    this.quarantineDir = join(dir, 'quarantine')
    this.segments = [] // { n, file, size, firstJseq, lastJseq, created }
    this.fd = null
    this.nextJseq = 1
    this.durableJseq = 0
    this.maxAuthMark = 0
    this.stats = { tornTailBytes: 0, quarantinedRanges: 0, quarantinedBytes: 0 }
    this.cursor = null
  }

  /** Validate every segment, repair torn tail / quarantine corruption, then open the active segment. */
  open () {
    mkdirSync(this.quarantineDir, { recursive: true })
    const names = readdirSync(this.dir).filter(f => /^\d{8}\.log$/.test(f)).sort()
    names.forEach((f, i) => this.#validate(Number(f.slice(0, 8)), join(this.dir, f), i === names.length - 1))
    this.durableJseq = this.nextJseq - 1
    this.#newSegment()
    this.ensureReserve()
    return this.stats
  }

  #validate (n, file, isLast) {
    const buf = readFileSync(file)
    const { frames, bad, tornAt } = scanBuffer(buf)
    const quarantine = (start, end, why) => {
      writeFileSync(join(this.quarantineDir, `${segName(n)}-${start}-${why}.bin`), buf.subarray(start, end))
      this.stats.quarantinedRanges++
      this.stats.quarantinedBytes += end - start
      this.log?.error({ segment: n, start, end, why }, 'journal: quarantined bytes')
    }
    bad.forEach(r => quarantine(r.start, r.end, 'corrupt'))
    if (tornAt !== null) {
      // On the last segment this is the expected crash signature (an append whose fsync never
      // completed, so it was never acknowledged). Bytes are still kept in quarantine for forensics.
      quarantine(tornAt, buf.length, isLast ? 'torn-tail' : 'corrupt-tail')
      if (isLast) this.stats.tornTailBytes += buf.length - tornAt
    }
    if (bad.length || tornAt !== null) {
      // rewrite the segment with only valid frames, atomically
      const tmp = file + '.tmp'
      writeFileSync(tmp, Buffer.concat(frames.map(f => buf.subarray(f.start, f.end))))
      const fd = openSync(tmp, 'r+'); fsyncSync(fd); closeSync(fd)
      renameSync(tmp, file)
    }
    const seg = { n, file, size: frames.reduce((s, f) => s + f.end - f.start, 0), firstJseq: null, lastJseq: null, created: statSync(file).mtimeMs }
    for (const { obj } of frames) {
      if (obj.k === 'h' && obj.epoch !== this.epoch) {
        throw new EpochMismatchError(`journal segment ${n} belongs to install ${obj.epoch}, expected ${this.epoch}`)
      }
      if (obj.k === 'r') {
        seg.firstJseq ??= obj.j
        seg.lastJseq = obj.j
        if (obj.j >= this.nextJseq) this.nextJseq = obj.j + 1
      }
      if (obj.k === 'm' && obj.auth > this.maxAuthMark) this.maxAuthMark = obj.auth
    }
    this.segments.push(seg)
  }

  #newSegment () {
    if (this.fd !== null) { fsyncSync(this.fd); closeSync(this.fd) }
    const n = (this.segments.at(-1)?.n ?? 0) + 1
    const file = join(this.dir, segName(n))
    const header = encodeFrame({ k: 'h', v: 1, epoch: this.epoch, seg: n, created: Date.now() })
    writeFileSync(file, header)
    this.fd = openSync(file, 'r+')
    fsyncSync(this.fd)
    try { const d = openSync(this.dir, 'r'); fsyncSync(d); closeSync(d) } catch { /* directory fsync unsupported on Windows */ }
    this.segments.push({ n, file, size: header.length, firstJseq: null, lastJseq: null, created: Date.now() })
  }

  get active () { return this.segments.at(-1) }

  #write (buf) {
    this.hooks.beforeWrite?.(buf)
    const seg = this.active
    const before = seg.size
    try {
      let done = 0
      while (done < buf.length) done += writeSync(this.fd, buf, done, buf.length - done, before + done)
      fsyncSync(this.fd)
    } catch (err) {
      try { ftruncateSync(this.fd, before); fsyncSync(this.fd) } catch { /* best effort; open() repairs torn tails */ }
      throw err
    }
    seg.size += buf.length
  }

  #rotateIfNeeded () {
    const a = this.active
    if (a.size >= this.maxSegmentBytes || (a.lastJseq !== null && Date.now() - a.created >= this.rotateMs)) this.#newSegment()
  }

  /** Durably append records. Assigns `j` (jseq) to each. Throws (nothing acknowledged) on failure. */
  append (records) {
    if (!records.length) return
    this.#rotateIfNeeded()
    let j = this.nextJseq
    const buf = Buffer.concat(records.map(r => encodeFrame({ k: 'r', j: j++, ...r })))
    this.#write(buf)
    records.forEach((r, i) => { r.j = this.nextJseq + i })
    const seg = this.active
    seg.firstJseq ??= this.nextJseq
    seg.lastJseq = j - 1
    this.nextJseq = j
    this.durableJseq = j - 1
  }

  /** Records the current auth write counter so a later rollback of auth.db is detectable (plan §6). */
  mark (authCounter) {
    this.#write(encodeFrame({ k: 'm', auth: authCounter, ts: Date.now() }))
    if (authCounter > this.maxAuthMark) this.maxAuthMark = authCounter
  }

  /** Up to `limit` durable records with jseq > afterJseq, in order. */
  readAfter (afterJseq, limit) {
    const out = []
    let c = this.cursor
    if (!c || c.afterJseq !== afterJseq) {
      const i = this.segments.findIndex(s => s.lastJseq !== null && s.lastJseq > afterJseq)
      if (i === -1) return out
      c = { segIdx: i, offset: 0, afterJseq }
    }
    let want = 4 * 1024 * 1024
    while (out.length < limit && c.segIdx < this.segments.length) {
      const seg = this.segments[c.segIdx]
      const end = seg.size
      if (c.offset >= end) {
        if (c.segIdx === this.segments.length - 1) break
        c.segIdx++; c.offset = 0; continue
      }
      const len = Math.min(end - c.offset, want)
      const buf = Buffer.alloc(len)
      const fd = seg === this.active ? this.fd : openSync(seg.file, 'r')
      try { readSync(fd, buf, 0, len, c.offset) } finally { if (seg !== this.active) closeSync(fd) }
      let off = 0
      while (off < len && out.length < limit) {
        const f = tryFrame(buf, off)
        if (!f) {
          const need = len - off < HDR ? HDR : HDR + buf.readUInt32LE(off + 4)
          if (off + need > len && c.offset + off + need <= end) { if (off === 0) want = need; break } // spans chunk end
          throw new Error(`journal: invalid frame in segment ${seg.n} at ${c.offset + off}`)
        }
        if (f.obj.k === 'r' && f.obj.j > afterJseq) { out.push(f.obj); afterJseq = f.obj.j }
        off = f.end
      }
      c.offset += off
      if (off === 0 && want <= len) break
    }
    c.afterJseq = afterJseq
    this.cursor = c
    return out
  }

  /** Delete closed segments that are fully applied and older than the retention window. */
  prune (appliedThrough, retainMs) {
    const cutoff = Date.now() - retainMs
    const keep = []
    for (const s of this.segments) {
      const closed = s !== this.active
      const applied = s.lastJseq === null || s.lastJseq <= appliedThrough
      if (closed && applied && s.created < cutoff) { unlinkSync(s.file); this.log?.info({ segment: s.n }, 'journal: pruned segment') } else keep.push(s)
    }
    if (keep.length !== this.segments.length) { this.segments = keep; this.cursor = null }
  }

  firstRetainedJseq () { return this.segments.find(s => s.firstJseq !== null)?.firstJseq ?? this.nextJseq }

  get reservePath () { return join(this.dir, 'reserve.bin') }
  ensureReserve () {
    if (!this.reserveBytes || existsSync(this.reservePath)) return
    try {
      const fd = openSync(this.reservePath, 'w')
      const chunk = Buffer.alloc(1024 * 1024)
      for (let w = 0; w < this.reserveBytes; w += chunk.length) writeSync(fd, chunk)
      fsyncSync(fd); closeSync(fd)
    } catch (err) { this.log?.warn({ err: err.message }, 'journal: could not create reserve file') }
  }
  /** Frees the reserve so the pause/alert path can still write after ENOSPC. */
  releaseReserve () { try { unlinkSync(this.reservePath); return true } catch { return false } }

  close () { if (this.fd !== null) { fsyncSync(this.fd); closeSync(this.fd); this.fd = null } }

  sizeBytes () { return this.segments.reduce((s, x) => s + x.size, 0) }
  activeFileSize () { return fstatSync(this.fd).size }
}
