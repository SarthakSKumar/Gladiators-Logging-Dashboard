import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeFrame, EpochMismatchError, Journal, scanBuffer } from '../src/ingest/journal.js'
import { silent, tmpDir } from './helpers.js'

const open = (dir, extra = {}) => { const j = new Journal({ dir, epoch: 'E1', log: silent, ...extra }); j.open(); return j }
const recs = n => Array.from({ length: n }, (_, i) => ({ t: 'msg', i }))
const segFiles = dir => readdirSync(dir).filter(f => f.endsWith('.log')).sort()

test('append assigns contiguous jseq and survives reopen', () => {
  const dir = tmpDir()
  const j = open(dir)
  const a = recs(3); j.append(a)
  const b = recs(2); j.append(b)
  assert.deepEqual([...a, ...b].map(r => r.j), [1, 2, 3, 4, 5])
  j.close()
  const j2 = open(dir)
  assert.equal(j2.nextJseq, 6)
  assert.deepEqual(j2.readAfter(0, 100).map(r => r.j), [1, 2, 3, 4, 5])
  assert.deepEqual(j2.readAfter(3, 100).map(r => r.j), [4, 5])
  j2.close()
})

test('readAfter respects limit and continues with the cursor across segments', () => {
  const dir = tmpDir()
  const j = open(dir, { maxSegmentBytes: 300 }) // force many segments
  for (let i = 0; i < 20; i++) j.append(recs(1))
  assert.ok(j.segments.length > 3)
  const seen = []
  let after = 0
  for (let page; (page = j.readAfter(after, 3)).length;) { seen.push(...page.map(r => r.j)); after = page.at(-1).j }
  assert.deepEqual(seen, Array.from({ length: 20 }, (_, i) => i + 1))
  j.close()
})

test('torn tail (crash mid-append) is truncated and quarantined; earlier records intact', () => {
  const dir = tmpDir()
  const j = open(dir)
  j.append(recs(5))
  j.close()
  const last = join(dir, segFiles(dir).at(-1))
  const frame = encodeFrame({ k: 'r', j: 6, t: 'msg' })
  appendFileSync(last, frame.subarray(0, frame.length - 7)) // partial write, never fsync-acknowledged
  const j2 = open(dir)
  assert.equal(j2.stats.tornTailBytes, frame.length - 7)
  assert.equal(j2.nextJseq, 6)
  assert.deepEqual(j2.readAfter(0, 100).map(r => r.j), [1, 2, 3, 4, 5])
  assert.ok(readdirSync(join(dir, 'quarantine')).some(f => f.includes('torn-tail')))
  j2.append(recs(1))
  assert.equal(j2.readAfter(5, 10)[0].j, 6)
  j2.close()
})

test('mid-segment corruption is quarantined and the segment rewritten with valid frames only', () => {
  const dir = tmpDir()
  const j = open(dir)
  j.append(recs(3))
  j.close()
  const file = join(dir, segFiles(dir).at(-1))
  const buf = readFileSync(file)
  const frames = scanBuffer(buf).frames
  const second = frames.find(f => f.obj.j === 2)
  buf[second.start + 14] ^= 0xff // flip a payload byte → CRC mismatch
  writeFileSync(file, buf)
  const j2 = open(dir)
  assert.equal(j2.stats.quarantinedRanges, 1)
  assert.deepEqual(j2.readAfter(0, 10).map(r => r.j), [1, 3])
  j2.close()
})

test('segment from another install is refused', () => {
  const dir = tmpDir()
  open(dir).close()
  assert.throws(() => new Journal({ dir, epoch: 'OTHER', log: silent }).open(), EpochMismatchError)
})

test('failed write is rolled back (nothing acknowledged) and the journal stays consistent', () => {
  const dir = tmpDir()
  let fail = false
  const j = open(dir, { hooks: { beforeWrite: () => { if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } } })
  j.append(recs(2))
  fail = true
  const batch = recs(3)
  assert.throws(() => j.append(batch), /disk full/)
  assert.equal(batch[0].j, undefined)
  fail = false
  j.append(recs(1))
  assert.deepEqual(j.readAfter(0, 10).map(r => r.j), [1, 2, 3])
  j.close()
})

test('auth marks are tracked across reopen; prune removes only applied, old, closed segments', () => {
  const dir = tmpDir()
  const j = open(dir, { maxSegmentBytes: 200 })
  j.mark(7)
  for (let i = 0; i < 10; i++) j.append(recs(1))
  j.mark(9)
  j.close()
  const j2 = open(dir)
  assert.equal(j2.maxAuthMark, 9)
  const before = j2.segments.length
  j2.prune(5, -1) // retention 0: everything old enough
  assert.ok(j2.segments.length < before)
  assert.ok(j2.firstRetainedJseq() <= 6) // nothing unapplied was removed
  assert.deepEqual(j2.readAfter(5, 100).map(r => r.j), [6, 7, 8, 9, 10])
  j2.close()
})
