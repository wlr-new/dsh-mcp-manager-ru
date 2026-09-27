/**
 * Real end-to-end verification for dsh-mcp-manager.
 *
 * The unit tests prove the model, the store, the guards and the bridge
 * resolution; the portability gate proves a clean machine can install and boot
 * the plugin. Neither proves the thing this plugin actually claims: that a
 * definition in the config file becomes live `mcp__<name>__*` tools inside a
 * running harness, and that enabling, disabling and removing disconnect it —
 * all without a restart.
 *
 * This script closes that gap against a REAL `dsh` instance:
 *
 *   1. builds a throwaway DSH_HOME and seeds it with one MCP server definition
 *      pointing at `tests/fixtures/echo-mcp-server.mjs` — a dependency-free MCP
 *      server written for this check, so a shared broken dependency cannot make
 *      both sides agree on a wrong wire format;
 *   2. boots an isolated instance (its own home, so no second writer ever
 *      contends for the live home's credential lock) and installs the plugin
 *      from this working tree;
 *   3. asserts the seeded server really connected: it must appear `active` with
 *      its two tools named `mcp__echo__*` in the plugin's own state route;
 *   4. drives the runtime lifecycle over HTTP — add a second server, see its
 *      tools appear, disable it, see them disappear, remove it — which is the
 *      "no restart" claim measured rather than asserted;
 *   5. runs a draft probe, which must report tools WITHOUT being persisted.
 *
 * Usage:
 *   node scripts/live-verify.mjs [--keep] [--port N]
 */

import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'

const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const DSH = process.env.DSH_BIN ?? 'dsh'
const FIXTURE = resolve(process.cwd(), 'tests/fixtures/echo-mcp-server.mjs')

let failures = 0
const pass = (title, detail = '') => console.log(`  ✔ ${title}${detail === '' ? '' : ` — ${detail}`}`)
const fail = (title, detail = '') => { failures += 1; console.log(`  ✘ ${title}${detail === '' ? '' : ` — ${detail}`}`) }
const info = (text) => console.log(`  · ${text}`)
const section = (title) => console.log(`\n${title}`)
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** A free TCP port. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

/** Whether something is listening on a port. */
function probePort(port, timeoutMs = 800) {
  return new Promise((resolveProbe) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveProbe(value)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => finish(true))
    socket.on('timeout', () => finish(false))
    socket.on('error', () => finish(false))
  })
}

const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-live-'))
const profile = `mcp-manager-live-${process.pid}`
const bootLogPath = join(tmpdir(), `dsh-mcp-manager-live-${process.pid}.log`)
let bootFd
let child
let port = 0

/** The seeded definition, written before boot so the connection is proven. */
const seeded = {
  version: 1,
  config: { enabled: true, announceToAgent: true },
  servers: [
    {
      name: 'echo',
      transport: 'stdio',
      enabled: true,
      description: 'dependency-free MCP fixture used by the live check',
      command: process.execPath,
      args: [FIXTURE, 'fixture-echo'],
    },
  ],
}

/** Stop the instance and remove everything this script created. */
function cleanup() {
  try {
    if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
  } catch { /* already gone */ }
  try { if (bootFd !== undefined) closeSync(bootFd) } catch { /* already closed */ }
  if (port !== 0) {
    // `dsh web` forks the real server, so the listener is not our child.
    try {
      const found = execFileSync('/usr/sbin/lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      for (const pid of found.split('\n').map((line) => line.trim()).filter(Boolean)) {
        try { process.kill(Number(pid), 'SIGKILL') } catch { /* already gone */ }
      }
    } catch { /* nothing listening */ }
  }
  if (KEEP) {
    console.log(`\n  （--keep：保留 ${home} 与 profile ${profile}）`)
    return
  }
  try { rmSync(join(home, 'profiles', profile), { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }) } catch { /* leave to the OS */ }
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }) } catch { /* leave to the OS */ }
  try { rmSync(bootLogPath, { force: true }) } catch { /* leave to the OS */ }
}

console.log('dsh-mcp-manager 真实实例端到端验证')
console.log(`  隔离 home：${home}`)
console.log(`  fixture：${FIXTURE}`)

let base = ''

/** GET one route as JSON. */
async function getJson(path) {
  const response = await fetch(`${base}${path}`)
  return await response.json()
}

/** POST one route as JSON. */
async function postJson(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

/** Poll until `check` is satisfied or the deadline passes. */
async function until(what, check, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await check()
      if (last !== undefined && last !== false) return last
    } catch { /* keep polling */ }
    await sleep(500)
  }
  fail(`等待超时：${what}`)
  return undefined
}

/** The runtime row for one server. */
function rowOf(state, name) {
  return (state?.runtime ?? []).find((view) => view.name === name)
}

try {
  /* ------------------------------------------------------- 1. 搭建隔离 home */
  section('1. 搭建隔离 home 与种子配置')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'dsh-mcp-manager.json'), `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 })
  pass('已写入种子配置', '1 个 stdio 服务器（echo）')

  const dshEnv = { ...process.env, DSH_HOME: home }
  // The `web` template is the only one that carries the web app, and it is the
  // same install shape the portability gate uses — so a pass here and a pass
  // there describe the same layout.
  execFileSync(DSH, ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { env: dshEnv, stdio: 'ignore' })
  execFileSync(DSH, ['plugin', '--profile', profile, 'add', `link:${process.cwd()}`], { env: dshEnv, stdio: 'ignore' })
  const composed = JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
  if ((composed.dsh?.profile?.bundles ?? []).includes('@zhengjunyao/dsh-mcp-manager')) {
    pass('插件已进入隔离 profile 的 bundles')
  } else {
    fail('插件没进隔离 profile 的 bundles')
  }

  /* --------------------------------------------------- 2. 启动隔离实例 */
  section('2. 启动隔离实例')
  port = await freePort()
  bootFd = openSync(bootLogPath, 'w')
  child = spawn(DSH, ['--profile', profile, '--port', String(port), '--no-open'], {
    env: dshEnv, stdio: ['ignore', bootFd, bootFd],
  })
  const readBoot = () => { try { return readFileSync(bootLogPath, 'utf8') } catch { return '' } }
  const bootDeadline = Date.now() + 120_000
  let listening = false
  while (Date.now() < bootDeadline) {
    if (await probePort(port)) { listening = true; break }
    if (child.exitCode !== null) break
    await sleep(300)
  }
  if (!listening) {
    fail('隔离实例没有监听端口', readBoot().split('\n').slice(-8).join(' | ').slice(0, 400))
    throw new Error('boot failed')
  }
  base = `http://127.0.0.1:${port}`
  pass('隔离实例已监听', base)

  const probe = await until('健康路由就绪', async () => {
    const response = await fetch(`${base}/api/dsh-mcp-manager/probe`).catch(() => null)
    if (response === null || !response.ok) return undefined
    const body = await response.json()
    return body.ok === true ? body : undefined
  }, 60_000)
  if (probe !== undefined) pass('插件健康路由可用', `${base}/api/dsh-mcp-manager/probe`)
  else throw new Error('probe failed')

  if (probe.bridge === 'harness' || probe.bridge === 'profile') {
    pass('MCP 桥从 harness 自身解析', probe.bridge)
  } else if (probe.bridge === 'bare') {
    fail('MCP 桥走了本地依赖而不是 harness 自带的那份', String(probe.bridge))
  } else {
    fail('MCP 桥没有加载', String(probe.bridgeError))
  }

  /* -------------------------------------------- 3. agent 工具真的挂上了 */
  section('3. 验证 mcp_manager_* 工具已注册')
  const managerTools = await until('agent 工具出现', async () => {
    const body = await getJson('/api/dsh-mcp-manager/probe')
    return body.managerToolCount >= 8 ? body.managerTools : undefined
  }, 30_000)
  if (managerTools !== undefined) {
    pass(`已注册 ${managerTools.length} 个 agent 工具`, managerTools.join('、'))
    for (const expected of ['mcp_manager_status', 'mcp_manager_add', 'mcp_manager_remove', 'mcp_manager_test']) {
      if (managerTools.includes(expected)) pass(`  ${expected} 在册`)
      else fail(`  ${expected} 缺失`)
    }
  }

  /* ------------------------------------- 4. 种子服务器真的连上并给出工具 */
  section('4. 验证种子服务器已连接并注册工具')
  const live = await until('echo 变为 active', async () => {
    const body = await getJson('/api/dsh-mcp-manager/state')
    const row = rowOf(body, 'echo')
    return row?.phase === 'active' ? row : undefined
  }, 45_000)
  if (live !== undefined) {
    pass('种子服务器已连接', `phase=${live.phase}`)
    const names = live.tools ?? []
    if (names.includes('mcp__echo__echo') && names.includes('mcp__echo__add')) {
      pass('工具以 mcp__echo__* 注册', names.join('、'))
    } else {
      fail('工具名不符', JSON.stringify(names))
    }
  } else {
    const body = await getJson('/api/dsh-mcp-manager/state').catch(() => null)
    fail('种子服务器没有连上', JSON.stringify(rowOf(body, 'echo') ?? body).slice(0, 300))
  }

  /* -------------------------------- 5. 运行时增删启停（不需要重启） */
  section('5. 运行时新增 / 停用 / 删除（验证无需重启）')
  const added = await postJson('/api/dsh-mcp-manager/server', {
    server: {
      name: 'echo2',
      transport: 'stdio',
      enabled: true,
      command: process.execPath,
      args: [FIXTURE, 'fixture-echo-2'],
    },
  })
  if (added.body.ok === true) pass('HTTP 新增第二个服务器成功')
  else fail('新增失败', JSON.stringify(added.body).slice(0, 300))

  const live2 = await until('echo2 变为 active', async () => {
    const body = await getJson('/api/dsh-mcp-manager/state')
    const row = rowOf(body, 'echo2')
    return row?.phase === 'active' ? row : undefined
  }, 45_000)
  if (live2 !== undefined) {
    const names = live2.tools ?? []
    if (names.includes('mcp__echo2__echo')) pass('新服务器的工具已注册', names.join('、'))
    else fail('新服务器的工具名不符', JSON.stringify(names))
  }

  const off = await postJson('/api/dsh-mcp-manager/server/toggle', { name: 'echo2', enabled: false })
  if (off.body.ok === true) pass('停用请求成功')
  else fail('停用失败', JSON.stringify(off.body).slice(0, 200))
  const gone = await until('echo2 的工具消失', async () => {
    const body = await getJson('/api/dsh-mcp-manager/state')
    const row = rowOf(body, 'echo2')
    return row !== undefined && (row.tools ?? []).length === 0 ? row : undefined
  }, 20_000)
  if (gone !== undefined) pass('停用后其 MCP 工具已注销', `phase=${gone.phase}`)

  const removed = await postJson('/api/dsh-mcp-manager/server/remove', { name: 'echo2' })
  if (removed.body.ok === true) pass('删除请求成功')
  else fail('删除失败', JSON.stringify(removed.body).slice(0, 200))
  const absent = await until('echo2 从列表消失', async () => {
    const body = await getJson('/api/dsh-mcp-manager/state')
    return (body.servers ?? []).some((server) => server.name === 'echo2') ? undefined : body
  }, 20_000)
  if (absent !== undefined) pass('删除后配置里已无 echo2')

  /* ------------------------------------------------- 6. 草稿试连不落盘 */
  section('6. 验证草稿试连（测试不保存）')
  const draft = await postJson('/api/dsh-mcp-manager/test', {
    name: 'draftprobe',
    server: {
      name: 'draftprobe',
      transport: 'stdio',
      enabled: true,
      command: process.execPath,
      args: [FIXTURE, 'fixture-draft'],
    },
  })
  if (draft.body.ok === true) pass('草稿试连成功', String(draft.body.message).slice(0, 120))
  else fail('草稿试连失败', JSON.stringify(draft.body).slice(0, 300))
  const afterDraft = await getJson('/api/dsh-mcp-manager/state')
  if ((afterDraft.servers ?? []).some((server) => server.name === 'draftprobe')) {
    fail('草稿被写进了配置（不应该）')
  } else {
    pass('草稿没有落盘')
  }
  if ((afterDraft.runtime ?? []).some((view) => (view.tools ?? []).some((name) => name.startsWith('mcp__draftprobe__')))) {
    fail('草稿的工具没有被收回')
  } else {
    pass('草稿的工具已被收回')
  }
  if (rowOf(afterDraft, 'echo')?.phase === 'active') pass('草稿试连后原服务器已恢复连接')
  else fail('草稿试连破坏了原服务器', JSON.stringify(rowOf(afterDraft, 'echo')))

  /* ------------------------------------------- 7. MCP 服务器总开关 */
  section('7. 验证 MCP 服务器总开关（设置页的停用）')
  const disabled = await postJson('/api/dsh-mcp-manager/config', { enabled: false })
  if (disabled.body.ok === true) pass('已关闭总开关')
  else fail('关闭总开关失败', JSON.stringify(disabled.body).slice(0, 200))
  const drained = await until('关闭后 mcp__* 工具全部注销', async () => {
    const body = await getJson('/api/dsh-mcp-manager/probe')
    // The server tools must go; the management surface stays so the state can
    // still be inspected and switched back on.
    return body.toolCount === 0 && body.serving === false && body.managerToolCount >= 8 ? body : undefined
  }, 20_000)
  if (drained !== undefined) {
    pass('关闭后 mcp__* 已注销，管理工具仍在', `toolCount=${drained.toolCount} managerTools=${drained.managerToolCount}`)
  }

  const reenabled = await postJson('/api/dsh-mcp-manager/config', { enabled: true })
  if (reenabled.body.ok === true) pass('已重新打开总开关')
  const restored = await until('重新打开后工具回来', async () => {
    const body = await getJson('/api/dsh-mcp-manager/probe')
    return body.toolCount >= 2 && body.serving === true ? body : undefined
  }, 30_000)
  if (restored !== undefined) pass('重新打开后服务器与 MCP 工具均已恢复', `toolCount=${restored.toolCount}`)
  const restoredState = await getJson('/api/dsh-mcp-manager/state')
  if (rowOf(restoredState, 'echo')?.phase === 'active') pass('恢复后 echo 重新连上', 'phase=active')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (!['boot failed', 'probe failed'].includes(message)) fail('脚本异常', message)
} finally {
  cleanup()
}

console.log('\n结论\n')
if (failures === 0) {
  console.log('  ✅ 真实实例端到端验证通过：配置 → MCP 桥 → 真实 stdio 服务器 → mcp__* 工具，且增删启停全程无需重启')
} else {
  console.log(`  ❌ 未通过：${failures} 项失败`)
}
process.exit(failures === 0 ? 0 : 1)
