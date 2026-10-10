import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runKillTest } from '../tools/killtest.js'

test('kill -9 at random points: every durably acknowledged record survives; loss window is measured', { timeout: 180_000 }, async () => {
  const r = await runKillTest({ rounds: 15 })
  console.log('killtest:', JSON.stringify(r))
  assert.ok(r.acked > 0, 'harness produced durable records')
  assert.equal(r.lostAcked, 0)
})
