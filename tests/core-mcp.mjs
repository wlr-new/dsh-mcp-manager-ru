/**
 * dsh-mcp-manager — the bridge resolution ladder.
 *
 * This is the one place the plugin reaches outside its own package, so it is
 * also the one place a layout change can silently break every install. The
 * assertions below pin the contract the manager relies on (the bridge really
 * exports `apply`, really injects `tools`, really calls itself `mcp-client`)
 * and exercise both rungs of the ladder without hardcoding a machine path.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { BRIDGE_PACKAGE, bridgeSearchDescription, loadBridge, resetBridgeCache } from '../src/core-mcp.ts'

test('the bridge resolves and exposes the contract the manager drives', async () => {
  resetBridgeCache()
  const bridge = await loadBridge()
  assert.equal(typeof bridge.module.apply, 'function', 'apply() is the plugin entry')
  assert.equal(bridge.module.name, 'mcp-client')
  assert.ok(Array.isArray(bridge.module.inject))
  assert.ok(bridge.module.inject.includes('tools'), 'the bridge must register into the tool registry')
  assert.equal(typeof bridge.source, 'string')
  assert.ok(bridge.source.length > 0)
})

test('a second call is served from cache', async () => {
  resetBridgeCache()
  const first = await loadBridge()
  const second = await loadBridge()
  assert.equal(first, second)
})

test('the harness rung wins when the running CLI is visible', async () => {
  // Point argv[1] at the bridge's own entry. Requiring from inside the package
  // walks up to whichever node_modules holds it, which is exactly the shape of
  // "the running harness's copy" — without naming a machine-specific path.
  const require = createRequire(import.meta.url)
  const entry = require.resolve(BRIDGE_PACKAGE)
  const previous = process.argv[1]
  process.argv[1] = entry
  resetBridgeCache()
  try {
    const bridge = await loadBridge()
    assert.equal(typeof bridge.module.apply, 'function')
    // Realpath of the entry is inside the resolved package, so the ladder must
    // not have needed the bare-specifier rung.
    assert.notEqual(bridge.via, 'bare')
  } finally {
    if (previous === undefined) delete process.argv[1]
    else process.argv[1] = previous
    resetBridgeCache()
  }
})

test('the search description names the package and the anchors it consults', () => {
  const text = bridgeSearchDescription()
  assert.ok(text.includes(BRIDGE_PACKAGE))
  assert.ok(text.includes('→'))
})
