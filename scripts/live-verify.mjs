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
    console.log(`\n  (--keep: сохраняем ${home} и профиль ${profile})`)
    return
  }
  try { rmSync(join(home, 'profiles', profile), { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }) } catch { /* leave to the OS */ }
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }) } catch { /* leave to the OS */ }
  try { rmSync(bootLogPath, { force: true }) } catch { /* leave to the OS */ }
}

console.log('dsh-mcp-manager: проверка на реальном экземпляре (end-to-end)')
console.log(`  Изолированный home: ${home}`)
console.log(`  Фикстура: ${FIXTURE}`)

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
  fail(`Тайм-аут ожидания: ${what}`)
  return undefined
}

/** The runtime row for one server. */
function rowOf(state, name) {
  return (state?.runtime ?? []).find((view) => view.name === name)
}

try {
  /* ---------------------------------------------------- 1. Изолированный home */
  section('1. Изолированный home и стартовая конфигурация')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'dsh-mcp-manager.json'), `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 })
  pass('Стартовая конфигурация записана', '1 stdio-сервер (echo)')

  const dshEnv = { ...process.env, DSH_HOME: home }
  // The `web` template is the only one that carries the web app, and it is the
  // same install shape the portability gate uses — so a pass here and a pass
  // there describe the same layout.
  execFileSync(DSH, ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { env: dshEnv, stdio: 'ignore' })
  execFileSync(DSH, ['plugin', '--profile', profile, 'add', `link:${process.cwd()}`], { env: dshEnv, stdio: 'ignore' })
  const composed = JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
  if ((composed.dsh?.profile?.bundles ?? []).includes('@zhengjunyao/dsh-mcp-manager')) {
    pass('Плагин добавлен в bundles изолированного профиля')
  } else {
    fail('Плагина нет в bundles изолированного профиля')
  }

  /* ------------------------------------------------- 2. Запуск изолированного экземпляра */
  section('2. Запуск изолированного экземпляра')
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
    fail('Изолированный экземпляр не слушает порт', readBoot().split('\n').slice(-8).join(' | ').slice(0, 400))
    throw new Error('boot failed')
  }
  base = `http://127.0.0.1:${port}`
  pass('Изолированный экземпляр слушает порт', base)

  const probe = await until('маршрут здоровья готов', async () => {
    const response = await fetch(`${base}/api/dsh-mcp-manager/probe`).catch(() => null)
    if (response === null || !response.ok) return undefined
    const body = await response.json()
    return body.ok === true ? body : undefined
  }, 60_000)
  if (probe !== undefined) pass('Маршрут здоровья плагина отвечает', `${base}/api/dsh-mcp-manager/probe`)
  else throw new Error('probe failed')

  if (probe.bridge === 'harness' || probe.bridge === 'profile') {
    pass('MCP-мост разрешён из самого harness', probe.bridge)
  } else if (probe.bridge === 'bare') {
    fail('MCP-мост взят из локальных зависимостей, а не из поставки harness', String(probe.bridge))
  } else {
    fail('MCP-мост не загружен', String(probe.bridgeError))
  }

  /* --------------------------------------- 3. Инструменты agent действительно зарегистрированы */
  section('3. Проверка регистрации инструментов mcp_manager_*')
  const managerTools = await until('появление инструментов agent', async () => {
    const body = await getJson('/api/dsh-mcp-manager/probe')
    return body.managerToolCount >= 8 ? body.managerTools : undefined
  }, 30_000)
  if (managerTools !== undefined) {
    pass(`Зарегистрировано инструментов agent: ${managerTools.length}`, managerTools.join(', '))
    for (const expected of ['mcp_manager_status', 'mcp_manager_add', 'mcp_manager_remove', 'mcp_manager_test']) {
      if (managerTools.includes(expected)) pass(`  ${expected} на месте`)
      else fail(`  ${expected} не найден`)
    }
  }

  /* ------------------------------- 4. Стартовый сервер подключён и выдал инструменты */
  section('4. Проверка подключения стартового сервера и регистрации инструментов')
  const live = await until('echo переходит в active', async () => {
    const body = await getJson('/api/dsh-mcp-manager/state')
    const row = rowOf(body, 'echo')
    return row?.phase === 'active' ? row : undefined
  }, 45_000)
  if (live !== undefined) {
    pass('Стартовый сервер подключён', `phase=${live.phase}`)
    const names = live.tools ?? []
    if (names.includes('mcp__echo__echo') && names.includes('mcp__echo__add')) {
      pass('Инструменты зарегистрированы как mcp__echo__*', names.join(', '))
    } else {
      fail('Имена инструментов не совпадают', JSON.stringify(names))
    }
  } else {
    const body = await getJson('/api/dsh-mcp-manager/state').catch(() => null)
    fail('Стартовый сервер не подключился', JSON.stringify(rowOf(body, 'echo') ?? body).slice(0, 300))
  }

  /* ----------------------------- 5. Добавление / отключение / удаление в рантайме (без перезапуска) */
  section('5. Добавление / отключение / удаление в рантайме (проверка "без перезапуска")')
  const added = await postJson('/api/dsh-mcp-manager/server', {
    server: {
      name: 'echo2',
      transport: 'stdio',
      enabled: true,
      command: process.execPath,
      args: [FIXTURE, 'fixture-echo-2'],
    },
  })
  if (added.body.ok === true) pass('Второй сервер добавлен через HTTP')
  else fail('Ошибка добавления', JSON.stringify(added.body).slice(0, 300))

  const live2 = await until('echo2 переходит в active', async () => {
    const body = await getJson('/api/dsh-mcp-manager/state')
    const row = rowOf(body, 'echo2')
    return row?.phase === 'active' ? row : undefined
  }, 45_000)
  if (live2 !== undefined) {
    const names = live2.tools ?? []
    if (names.includes('mcp__echo2__echo')) pass('Инструменты нового сервера зарегистрированы', names.join(', '))
    else fail('Имена инструментов нового сервера не совпадают', JSON.stringify(names))
  }

  const off = await postJson('/api/dsh-mcp-manager/server/toggle', { name: 'echo2', enabled: false })
  if (off.body.ok === true) pass('Запрос отключения выполнен')
  else fail('Ошибка отключения', JSON.stringify(off.body).slice(0, 200))
  const gone = await until('исчезновение инструментов echo2', async () => {
    const body = await getJson('/api/dsh-mcp-manager/state')
    const row = rowOf(body, 'echo2')
    return row !== undefined && (row.tools ?? []).length === 0 ? row : undefined
  }, 20_000)
  if (gone !== undefined) pass('После отключения его MCP-инструменты сняты с регистрации', `phase=${gone.phase}`)

  const removed = await postJson('/api/dsh-mcp-manager/server/remove', { name: 'echo2' })
  if (removed.body.ok === true) pass('Запрос удаления выполнен')
  else fail('Ошибка удаления', JSON.stringify(removed.body).slice(0, 200))
  const absent = await until('исчезновение echo2 из списка', async () => {
    const body = await getJson('/api/dsh-mcp-manager/state')
    return (body.servers ?? []).some((server) => server.name === 'echo2') ? undefined : body
  }, 20_000)
  if (absent !== undefined) pass('После удаления echo2 нет в конфигурации')

  /* --------------------------------------------- 6. Пробное подключение черновика не записывается на диск */
  section('6. Проверка пробного подключения черновика (тест не сохраняет)')
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
  if (draft.body.ok === true) pass('Пробное подключение черновика удалось', String(draft.body.message).slice(0, 120))
  else fail('Пробное подключение черновика не удалось', JSON.stringify(draft.body).slice(0, 300))
  const afterDraft = await getJson('/api/dsh-mcp-manager/state')
  if ((afterDraft.servers ?? []).some((server) => server.name === 'draftprobe')) {
    fail('Черновик записан в конфигурацию (не должно быть)')
  } else {
    pass('Черновик на диск не записан')
  }
  if ((afterDraft.runtime ?? []).some((view) => (view.tools ?? []).some((name) => name.startsWith('mcp__draftprobe__')))) {
    fail('Инструменты черновика не отозваны')
  } else {
    pass('Инструменты черновика отозваны')
  }
  if (rowOf(afterDraft, 'echo')?.phase === 'active') pass('После пробного подключения исходный сервер снова подключён')
  else fail('Пробное подключение нарушило исходный сервер', JSON.stringify(rowOf(afterDraft, 'echo')))

  /* ------------------------------------ 7. Главный переключатель MCP-серверов (отключение со страницы настроек) */
  section('7. Проверка главного переключателя MCP-серверов (отключение со страницы настроек)')
  const disabled = await postJson('/api/dsh-mcp-manager/config', { enabled: false })
  if (disabled.body.ok === true) pass('Главный переключатель выключен')
  else fail('Не удалось выключить главный переключатель', JSON.stringify(disabled.body).slice(0, 200))
  const drained = await until('после выключения все инструменты mcp__* сняты с регистрации', async () => {
    const body = await getJson('/api/dsh-mcp-manager/probe')
    // The server tools must go; the management surface stays so the state can
    // still be inspected and switched back on.
    return body.toolCount === 0 && body.serving === false && body.managerToolCount >= 8 ? body : undefined
  }, 20_000)
  if (drained !== undefined) {
    pass('mcp__* сняты с регистрации, управляющие инструменты на месте', `toolCount=${drained.toolCount} managerTools=${drained.managerToolCount}`)
  }

  const reenabled = await postJson('/api/dsh-mcp-manager/config', { enabled: true })
  if (reenabled.body.ok === true) pass('Главный переключатель снова включён')
  const restored = await until('возврат инструментов после включения', async () => {
    const body = await getJson('/api/dsh-mcp-manager/probe')
    return body.toolCount >= 2 && body.serving === true ? body : undefined
  }, 30_000)
  if (restored !== undefined) pass('После включения серверы и MCP-инструменты восстановлены', `toolCount=${restored.toolCount}`)
  const restoredState = await getJson('/api/dsh-mcp-manager/state')
  if (rowOf(restoredState, 'echo')?.phase === 'active') pass('После восстановления echo снова подключён', 'phase=active')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (!['boot failed', 'probe failed'].includes(message)) fail('Сбой скрипта', message)
} finally {
  cleanup()
}

console.log('\nИтог\n')
if (failures === 0) {
  console.log('  ✅ Проверка на реальном экземпляре пройдена: конфигурация → MCP-мост → реальный stdio-сервер → инструменты mcp__*, при этом добавление/отключение/удаление работали без перезапуска')
} else {
  console.log(`  ❌ Провалено проверок: ${failures}`)
}
process.exit(failures === 0 ? 0 : 1)
