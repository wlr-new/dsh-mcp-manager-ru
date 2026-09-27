/**
 * dsh-mcp-manager — runtime helpers.
 *
 * The grouping function is the single place tool visibility is read, and the
 * reason this plugin cannot repeat its predecessor's quadratic reconcile: one
 * registry enumeration is grouped in memory, never re-queried per server.
 * Getting the prefix match wrong would either hide a server's tools or credit
 * them to a longer-named neighbour, so the neighbouring case is asserted.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { groupByServer, toolPrefix, describe as describeError } from '../src/runtime.ts'

test('toolPrefix is the harness bridge namespace shape', () => {
  assert.equal(toolPrefix('garmin'), 'mcp__garmin__')
})

test('groupByServer credits each tool to exactly one server', () => {
  const names = [
    'mcp__garmin__get_activities',
    'mcp__garmin__get_sleep',
    'mcp__echo__echo',
    'read',
    'bash',
    'mcp__other__thing',
  ]
  const grouped = groupByServer(names, ['garmin', 'echo'])
  assert.deepEqual(grouped.get('garmin'), ['mcp__garmin__get_activities', 'mcp__garmin__get_sleep'])
  assert.deepEqual(grouped.get('echo'), ['mcp__echo__echo'])
})

test('a server name that prefixes another does not steal its tools', () => {
  // `gc` is a prefix of `gcal`; the tool belongs to the longer, exact namespace.
  const names = ['mcp__gc__a', 'mcp__gcal__b']
  const grouped = groupByServer(names, ['gc', 'gcal'])
  assert.deepEqual(grouped.get('gc'), ['mcp__gc__a'])
  assert.deepEqual(grouped.get('gcal'), ['mcp__gcal__b'])
})

test('servers with no tools are present with an empty list', () => {
  const grouped = groupByServer(['mcp__a__x'], ['a', 'silent'])
  assert.deepEqual(grouped.get('silent'), [])
  assert.deepEqual(grouped.get('a'), ['mcp__a__x'])
})

test('non-mcp tools and unknown namespaces are ignored', () => {
  const grouped = groupByServer(['read', 'mcp__stranger__x', 'mcp__a__y'], ['a'])
  assert.deepEqual(grouped.get('a'), ['mcp__a__y'])
  assert.equal(grouped.size, 1)
})

test('the grouped lists are sorted, so a panel cannot flicker on order', () => {
  const grouped = groupByServer(['mcp__a__z', 'mcp__a__a', 'mcp__a__m'], ['a'])
  assert.deepEqual(grouped.get('a'), ['mcp__a__a', 'mcp__a__m', 'mcp__a__z'])
})

test('an empty registry yields no tools for any server', () => {
  const grouped = groupByServer([], ['a', 'b'])
  assert.deepEqual([...grouped.entries()], [['a', []], ['b', []]])
})

test('error descriptions survive non-Error throws', () => {
  assert.equal(describeError(new Error('boom')), 'boom')
  assert.equal(describeError('plain'), 'plain')
  assert.equal(describeError({ code: 7 }), '{"code":7}')
})
