#!/usr/bin/env node
/**
 * dsh-release-kit / portability.mjs — превращает вопрос «а перенесётся ли это на чужой компьютер» в скриптовый гейт.
 *
 * При локальной разработке `link:`-подключение + ваш собственный профиль + ваш собственный `~/.dsh` маскируют кучу проблем:
 * абсолютные пути, захардкоженный `~/.dsh`, допущения, работающие только на macOS, файлы, которые не попали в пакет, клиентская
 * половина, которую shell вообще не собрал в boot payload… Всё это взрывается только на чужой машине, и чаще всего «установилось, но ничего не произошло».
 *
 * Этот скрипт прогоняет проверку в режиме «чужая машина»:
 *
 *   1. Статическая проверка —— абсолютные пути этой машины в исходниках / платформенные команды без защитника / home без DSH_HOME
 *   2. Упаковка       —— npm pack + сверка, что объявленные точки входа реально попали в пакет
 *   3. Чистая установка —— новый пустой профиль, установка из tarball (не link:)
 *   4. Запуск         —— старт на свободном порту
 *   5. Хостовая половина —— запрос к маршруту здоровья, что плагин реально смонтирован
 *   6. Клиентская половина —— bundle есть в __DSH_BOOT__.entries и его можно скачать
 *   7. Реальное действие —— опционально: POST настоящего перезапуска, сервис возвращается с новым pid
 *   8. Очистка        —— остановить экземпляр, удалить профиль, удалить tarball (--keep сохраняет)
 *
 * Без зависимостей, Node ≥ 20 (встроенные fetch / getSetCookie).
 *
 *   node scripts/portability.mjs
 *   node scripts/portability.mjs --health /api/foo/probe --restart-route /api/foo/restart
 *   node scripts/portability.mjs --no-isolate   # делить ~/.dsh этой машины (по умолчанию — изолированный временный home)
 *   node scripts/portability.mjs --json         # машинно-читаемый отчёт
 *   node scripts/portability.mjs --stability 30 # подольше понаблюдать после готовности (по умолчанию 15 с)
 *   node scripts/portability.mjs --cwd <каталог плагина>
 *
 * Коды выхода: 0 = пройдено (можно публиковать), 1 = не пройдено, 2 = ошибка использования/окружения.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

/* ------------------------------------------------------------------ Параметры */

const argv = process.argv.slice(2)
const flag = (name, fallback = undefined) => {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value !== undefined && !value.startsWith('--') ? value : fallback
}
const has = (name) => argv.includes(name)

const options = {
  cwd: path.resolve(flag('--cwd', process.cwd())),
  dsh: flag('--dsh', 'dsh'),
  health: flag('--health', ''),
  restartRoute: flag('--restart-route', ''),
  pluginId: flag('--plugin-id', ''),
  port: Number(flag('--port', '0')) || 0,
  bootTimeoutSec: Number(flag('--timeout', '90')) || 90,
  keep: has('--keep'),
  // По умолчанию изоляция: второй экземпляр на той же машине станет в очередь за блокировкой записи `~/.dsh/.credentials.yaml`
  // и не запустится; кроме того, home разработчика маскирует проблемы «чистой машины». Домашний каталог делится только с --no-isolate.
  isolate: !has('--no-isolate'),
  json: has('--json'),
  skipAudit: has('--skip-audit'),
  /** Не делать наблюдение за стабильностью после готовности (по умолчанию — делаем). */
  skipStability: has('--skip-stability'),
}

/* ------------------------------------------------------------------ Вывод */

const results = []
let failed = 0

function record(level, title, detail = '') {
  results.push({ level, title, detail })
  if (options.json) return
  const mark = level === 'pass' ? '✔' : level === 'fail' ? '✘' : level === 'warn' ? '!' : '·'
  const line = `  ${mark} ${title}${detail === '' ? '' : ' — ' + detail}`
  if (level === 'fail') console.error(line)
  else console.log(line)
}
const pass = (title, detail) => record('pass', title, detail)
const fail = (title, detail) => {
  failed++
  record('fail', title, detail)
}
const warn = (title, detail) => record('warn', title, detail)
const info = (title, detail) => record('info', title, detail)
const section = (title) => {
  if (!options.json) console.log(`\n${title}`)
}

/* ------------------------------------------------------------------ Утилиты */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Свободный порт. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

/** Кто-нибудь отвечает на этом порту? */
function probePort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** Выполнить команду синхронно; сбой не бросает исключение. */
function run(file, args, runOptions = {}) {
  try {
    const stdout = execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...runOptions })
    return { ok: true, stdout, stderr: '' }
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message ?? error) }
  }
}

/** Рекурсивный список исходников (пропуск node_modules / .git / артефактов lib). */
function listSources(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listSources(full, out)
    else if (/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/* ---------------------------------------------------------- 1. Статическая проверка */

const USER_PATH = /(\/(?:Users|home)\/[A-Za-z0-9._-]+|C:\\Users\\[A-Za-z0-9._-]+)/
const PLATFORM_ONLY = /\b(launchctl|plutil|launchd)\b/
const PLATFORM_GUARD = /darwin|process\.platform/
const DSH_HOME_USE = /DSH_HOME/
const DOT_DSH = /\.dsh(?![\w-])/

function auditSources(cwd) {
  const files = ['src', 'helper', 'bin', 'scripts']
    .flatMap((dir) => listSources(path.join(cwd, dir)))
    // Браузерная половина не ходит в shell и не резолвит home: сканировать её — только ложные срабатывания.
    .filter((file) => !file.endsWith('.min.js') && !file.includes(`${path.sep}client${path.sep}`))
  const hits = { absolute: [], platform: [], home: [] }
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const relative = path.relative(cwd, file)
    text.split('\n').forEach((line, index) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return // комментарии не считаются
      const absolute = USER_PATH.exec(line)
      if (absolute !== null) hits.absolute.push(`${relative}:${index + 1} → ${absolute[1]}`)
      if (PLATFORM_ONLY.test(line) && !PLATFORM_GUARD.test(text)) {
        hits.platform.push(`${relative}:${index + 1}`)
      }
    })
    // Пишет в ~/.dsh, но не учитывает DSH_HOME: машина с перенесённым home запишет не туда.
    // Смотрим только не-комментарные строки, и за `.dsh` не должно сразу следовать слово (иначе .dshwx-ball и подобные дадут ложное срабатывание).
    const homeHit = text
      .split('\n')
      .some((line) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return false
        return DOT_DSH.test(line)
      })
    if (homeHit && !DSH_HOME_USE.test(text)) hits.home.push(relative)
  }
  return { count: files.length, hits }
}

/* ------------------------------------------------------------------ Точка входа */

const pkgPath = path.join(options.cwd, 'package.json')
if (!existsSync(pkgPath)) {
  console.error(`package.json не найден: ${pkgPath} (укажите каталог плагина через --cwd <каталог>)`)
  process.exit(2)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const id = options.pluginId !== '' ? options.pluginId : pkg.name
const hasClient = pkg.dsh?.client !== undefined
const bundlePatch = pkg.dsh?.bundle?.patch

if (!options.json) {
  console.log(`\nПроверка переносимости: ${id}@${pkg.version ?? '?'}`)
  console.log(`  Каталог: ${options.cwd}`)
  console.log(`  Клиентская половина: ${hasClient ? 'есть' : 'нет'}  bundle patch: ${bundlePatch ?? 'не задан'}`)
}

let tarball
let isolatedHome = ''
let child
let port = 0
/** Имя profile для проверки (объявлено заранее: cleanup/finish могут позвать его до присвоения). */
let profile = ''
const dshEnv = { ...process.env }

/** Финальные действия: остановить экземпляр, удалить профиль и tarball. */
function cleanup() {
  try {
    if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
    try {
      closeSync(bootLogFd)
    } catch {
      /* уже закрыто */
    }
  } catch {
    /* уже завершился */
  }
  // После реального действия (перезапуска) порт слушает новый процесс, поднятый помощником, — не наш child.
  if (port !== 0) {
    const found = run('/usr/sbin/lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    for (const pid of found.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        /* уже завершился */
      }
    }
  }
  if (options.keep) return
  const rm = (target) => {
    if (target === '') return
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
    } catch {
      /* файловая система ещё освобождает место — временный каталог оставим системе */
    }
  }
  rm(path.join(dshHome(), 'profiles', profile))
  if (tarball !== undefined) rm(tarball)
  rm(isolatedHome)
}

const dshHome = () => dshEnv.DSH_HOME ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')

let finished = false
function finish() {
  if (finished) return
  finished = true
  cleanup()
  if (options.json) {
    console.log(JSON.stringify({ id, version: pkg.version ?? null, port, failed, tarball: tarball ?? null, results }, null, 2))
  } else {
    section('Итог')
    if (failed === 0) {
      console.log(`\n  ✅ Пройдено: ${id}@${pkg.version ?? '?'} проверен в режиме «чужая машина» — можно публиковать\n`)
    } else {
      console.error(`\n  ❌ Не пройдено: провалено проверок: ${failed} — исправьте и публикуйте снова\n`)
    }
    if (options.keep) console.log('  (--keep: профиль проверки и tarball сохранены для разбора)\n')
    if (isolatedHome !== '' && !options.keep) console.log('  (проверка шла в временном DSH_HOME — он удалён; сохранить можно через --keep)\n')
  }
  process.exit(failed === 0 ? 0 : 1)
}

/* ----------------------------------------------------------- 1. Статическая проверка */

if (!options.skipAudit) {
  section('1. Статическая проверка')
  const audit = auditSources(options.cwd)
  info(`Просканировано исходников: ${audit.count}`)
  if (audit.hits.absolute.length === 0) pass('Абсолютных путей этой машины нет')
  else fail('В исходниках есть абсолютные пути этой машины (у другого точно сломается)', audit.hits.absolute.slice(0, 5).join('; '))
  if (audit.hits.platform.length === 0) pass('Платформенных команд без проверки платформы нет')
  else warn('Платформенные команды, похоже, без проверки платформы', audit.hits.platform.slice(0, 4).join(', '))
  if (audit.hits.home.length === 0) pass('Каталог конфигурации резолвится по договору (учитывает DSH_HOME)')
  else warn('Пишет в .dsh, но не учитывает DSH_HOME (машина с перенесённым home запишет не туда)', audit.hits.home.slice(0, 4).join(', '))
}

/* --------------------------------------------------------------- 2. Упаковка */

section('2. Упаковка')
// --ignore-scripts: `prepack` льёт логи сборки в stdout и портит вывод --json (собирать — дело вызывающей стороны)
const pack = run('npm', ['pack', '--json', '--ignore-scripts'], { cwd: options.cwd })
if (!pack.ok) {
  fail('Ошибка npm pack', pack.stderr.trim().slice(0, 300))
  finish()
}
let packed = null
try {
  packed = JSON.parse(pack.stdout)[0]
} catch {
  // Запасной вариант: взять последний JSON-массив в stdout (скрипт сборки мог вставить свой вывод)
  const start = pack.stdout.lastIndexOf('[')
  const end = pack.stdout.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      packed = JSON.parse(pack.stdout.slice(start, end + 1))[0]
    } catch {
      packed = null
    }
  }
}
if (packed === null) {
  fail('Не удалось разобрать вывод npm pack')
  finish()
}

tarball = path.join(options.cwd, packed.filename)
const inside = new Set((packed.files ?? []).map((entry) => entry.path))
pass('Упаковка прошла', `${packed.filename} (${(packed.size / 1024).toFixed(0)} кБ, файлов: ${inside.size})`)

const declared = [
  ...(typeof pkg.main === 'string' ? [pkg.main] : []),
  ...Object.values(pkg.exports ?? {}).filter((value) => typeof value === 'string'),
  ...(typeof bundlePatch === 'string' ? [bundlePatch] : []),
  ...(pkg.files ?? []).filter((value) => value.includes('.')),
]
const missing = [...new Set(declared.map((entry) => entry.replace(/^\.\//, '')))].filter((entry) => !inside.has(entry))
if (missing.length === 0) pass('Все объявленные точки входа в пакете', declared.slice(0, 4).join(', '))
else fail('Объявленная точка входа не попала в пакет (у другого будет сломано)', missing.join(', '))
if (inside.has('package.json')) pass('package.json в пакете')
else fail('package.json не попал в пакет')

/* --------------------------------------------------------- 3. Чистая установка */

profile = `verify-${String(id).replace(/[^a-zA-Z0-9._-]/g, '-')}`
if (options.isolate) {
  isolatedHome = mkdtempSync(path.join(tmpdir(), 'dsh-verify-home-'))
  dshEnv.DSH_HOME = isolatedHome
}
section('3. Чистая установка (новый профиль + tarball, без link:)')
info(`Профиль: ${profile}${options.isolate ? ` DSH_HOME: ${isolatedHome}` : ''}`)

const dump = run(options.dsh, ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { env: dshEnv })
if (dump.ok) pass('Профиль проверки готов')
else fail('Не удалось создать профиль проверки', dump.stderr.trim().slice(0, 300))

const add = run(options.dsh, ['plugin', '--profile', profile, 'add', `file:${tarball}`], { env: dshEnv })
if (!add.ok) {
  fail('Ошибка установки из tarball', (add.stderr || add.stdout).trim().slice(0, 400))
} else {
  pass('Установка из tarball прошла')
  try {
    const composed = JSON.parse(readFileSync(path.join(dshHome(), 'profiles', profile, 'package.json'), 'utf8'))
    const bundles = composed.dsh?.profile?.bundles ?? []
    if (bundles.includes(id)) pass('Попал в bundles профиля (хост его загрузит)', id)
    else fail('Установлен, но не попал в bundles (не будет загружен)', bundles.slice(-3).join(', '))
  } catch (error) {
    warn('Не удалось прочитать package.json профиля', String(error.message ?? error))
  }
}

/* ------------------------------------------------------------- 4. Запуск */

section('4. Запуск экземпляра проверки')
port = options.port !== 0 ? options.port : await freePort()
info(`Порт: ${port}`)

// stdout/stderr — в файл, а не в pipe: `dsh web` форкает настоящий сервисный процесс;
// как только wrapper завершится, pipe закроется, и токен, который напишет форкнувшаяся половина, будет утерян.
const bootLogPath = path.join(tmpdir(), `dsh-verify-${String(id).replace(/[^a-zA-Z0-9._-]/g, '-')}-boot.log`)
const bootLogFd = openSync(bootLogPath, 'w')
const readBootLog = () => {
  try {
    return readFileSync(bootLogPath, 'utf8')
  } catch {
    return ''
  }
}
child = spawn(options.dsh, ['--profile', profile, '--port', String(port), '--no-open'], {
  env: dshEnv,
  stdio: ['ignore', bootLogFd, bootLogFd],
})

const deadline = Date.now() + options.bootTimeoutSec * 1000
let listening = false
while (Date.now() < deadline) {
  if (await probePort(port)) {
    listening = true
    break
  }
  if (child.exitCode !== null) break
  await sleep(300)
}
/** Отобрать строки с ошибками из вывода запуска (первоисточник для диагноза «у другого не ставится»). */
function bootErrors(text) {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => /Error|error:|EADDRINUSE|MODULE_NOT_FOUND|Cannot find|failed to load|timeout|lock/i.test(line))
    .slice(0, 6)
}

if (options.keep) {
  const dump = path.join(tmpdir(), `dsh-verify-${String(id).replace(/[^a-zA-Z0-9._-]/g, '-')}-boot.log`)
  try {
    writeFileSync(dump, readBootLog())
    info(`Вывод запуска сохранён: ${dump}`)
  } catch {
    /* по возможности */
  }
}
if (listening) pass('Экземпляр проверки слушает порт', `http://127.0.0.1:${port}`)
else fail('Экземпляр проверки не поднялся', readBootLog().split('\n').filter(Boolean).slice(-5).join(' | ').slice(0, 400))

// Живой порт — ещё не успешный запуск: дерево плагинов может упасть уже после привязки порта.
{
  const errors = bootErrors(readBootLog())
  if (errors.length > 0) fail('В выводе запуска есть ошибки', errors.join(' | ').slice(0, 500))
  else if (listening) pass('Ошибок в выводе запуска нет')
}

// Статическая проверка клиентской половины (не зависит от того, поднялся ли экземпляр)
let clientEntry = ''
if (typeof pkg.exports?.['./client'] === 'string') clientEntry = pkg.exports['./client']
else if (typeof pkg.exports?.['./client'] === 'object') clientEntry = pkg.exports['./client'].default ?? ''
if (hasClient) {
  if (clientEntry === '') fail('Объявлен dsh.client, но exports["./client"] отсутствует')
  else {
    const clientFile = path.join(options.cwd, clientEntry)
    if (!existsSync(clientFile)) fail('Файл по ссылке exports["./client"] не существует', clientEntry)
    else {
      const source = readFileSync(clientFile, 'utf8')
      const declaredId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(source)?.[1] ?? ''
      if (declaredId === '') fail('В клиентском bundle нет __ModuleLoader__.load({ id }) — shell его не зарегистрирует')
      else if (declaredId !== id) fail('ID регистрации bundle не совпадает с именем пакета (упадёт загрузка всей пачки плагинов)', `bundle=${declaredId}, пакет=${id}`)
      else pass('ID регистрации bundle совпадает с именем пакета', declaredId)
      if (typeof pkg.dsh.client.platform === 'string') pass('Платформа клиента объявлена', pkg.dsh.client.platform)
      else warn('У dsh.client не объявлен platform (для web-панели должно быть "web")')
      if (Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0) pass('Клиентский inject объявлен', `элементов: ${pkg.dsh.client.inject.length}`)
      else warn('dsh.client.inject пуст (разрешение зависимостей может упасть)')
      if (inside.size > 0 && ![...inside].some((entry) => entry === clientEntry.replace(/^\.\//, ''))) {
        fail('Клиентский bundle не попал в npm-пакет', clientEntry)
      }
    }
  }
}

const base = `http://127.0.0.1:${port}`

/**
 * Достать токен из строки с URL — это единственные ключи к веб-интерфейсу (DSH при старте
 * печатает в stdout `dsh web: http://…/?token=…`).
 *
 * Обратите внимание на тайминг: порт переходит в LISTEN рано, ещё во время загрузки плагинов,
 * а строка с URL печатается только когда приложение полностью готово — между ними может пройти
 * десяток секунд. Значит, нужно именно «ждать эту строку», а не брать токен сразу после открытия порта.
 */
async function waitForToken(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = /token=([A-Za-z0-9_-]+)/.exec(readBootLog())
    if (found !== null) return found[1]
    if (child.exitCode !== null) return ''
    await sleep(300)
  }
  return ''
}

let token = await waitForToken(30_000)
if (token !== '') pass('Токен интерфейса получен (вывод запуска в порядке)')
else warn('За 30 с строка URL с токеном не появилась (проверка интерфейса пропущена; можно передать --token вручную)')
const healthPath = options.health !== '' ? options.health : `/api/${id}/probe`

/** Запрос с cookie; для index сначала меняют токен на cookie (303 → повторный запрос). */
const jar = new Map()
async function browse(url, depth = 0) {
  const response = await fetch(url, {
    redirect: 'manual',
    headers: jar.size === 0 ? {} : { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
  })
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const [pair] = entry.split(';')
    const index = pair.indexOf('=')
    jar.set(pair.slice(0, index), pair.slice(index + 1))
  }
  if (response.status >= 300 && response.status < 400 && depth < 3) {
    const location = response.headers.get('location')
    if (location !== null) return browse(new URL(location, url).toString(), depth + 1)
  }
  return response
}

// Порт ≠ интерфейс: webServer привязывает порт первым, а запасная обработка index/dist регистрируется позже.
if (listening && token !== '') {
  const readyBy = Date.now() + 30_000
  let ready = false
  while (Date.now() < readyBy) {
    try {
      const response = await browse(`${base}/?token=${token}`)
      if (response.status === 200) {
        ready = true
        break
      }
      if (response.status !== 404 && response.status !== 502 && response.status !== 503) break
    } catch {
      /* ещё поднимается */
    }
    await sleep(500)
  }
  if (ready) pass('Веб-интерфейс готов (index 200)')
  else warn('Веб-интерфейс не стал готов (index не 200)')
}

/* --------------------------------------------------------- 5. Хостовая половина */

section('5. Хостовая половина')
if (!listening) {
  warn('Экземпляр не поднялся — пропускаем проверку хостовой половины')
} else {
  try {
    const response = await fetch(`${base}${healthPath}`)
    const text = await response.text()
    if (response.ok) pass('Маршрут здоровья доступен', `${healthPath} → ${response.status} ${text.slice(0, 70)}`)
    else fail('Маршрут здоровья вернул не 2xx', `${healthPath} → ${response.status} ${text.slice(0, 120)}`)
  } catch (error) {
    fail('До маршрута здоровья нет доступа', `${healthPath}: ${String(error.message ?? error)}`)
    warn('Если путь неверен — укажите собственный маршрут здоровья плагина через --health <путь>')
  }
}

/* ------------------------------------------------------- 6. Клиентская половина */

section('6. Клиентская половина')
if (!hasClient) {
  info('У плагина нет клиентской половины (dsh.client не объявлен) — пропускаем')
} else if (!listening) {
  warn('Экземпляр не поднялся — пропускаем')
} else {
  try {
    const index = await browse(token === '' ? `${base}/` : `${base}/?token=${token}`)
    const html = await index.text()
    // Форма адреса доставки менялась в разных версиях DSH; распознавать нужно обе:
    //   - старые версии: абсолютный путь `/plugins/??<id>/client.js,…&rev=…`
    //   - с 0.1.7: **относительно документа** (comboReference из ядра dsh-client-modules =
    //     comboUrl.slice(1), см. заметку web-document-relative-app-routes),
    //     то есть `plugins/??<id>/client.js,…&rev=…` — в index **нет** ведущего слеша.
    // Ослабляем только префикс; семантические утверждения не меняются (в манифесте должен найтись этот плагин).
    const urls = [...html.matchAll(/\/?plugins\/\?\?[^"\\\s]+/g)].map((match) => match[0].replaceAll('&amp;', '&'))
    // Загрузочный манифест разбит на части по фазам (несколько combo); самый длинный адрес необязательно содержит наш плагин — ищем в **всех** combo.
    const bundleUrl = urls.find((url) => url.includes(`${id}/client.js`)) ?? ''
    const toAbsolute = (path) => (path.startsWith('/') ? `${base}${path}` : `${base}/${path}`)
    if (index.status === 401) {
      warn('Index не отдаётся (нет токена) — пропускаем проверку интерфейса в рантайме (статические проверки прошли)')
    } else if (urls.length === 0) fail('В index нет адреса доставки клиентского bundle (клиентская половина не зарегистрирована)', `HTTP ${index.status}${bootErrors(readBootLog()).length > 0 ? '|' + bootErrors(readBootLog())[0] : ''}`)
    else if (bundleUrl === '') fail('Bundle не попал в загрузочный манифест (панель/вход не появится)', urls.join(' | ').slice(0, 150))
    else pass('Shell взял bundle в загрузочный манифест', `${id}/client.js`)
    if (bundleUrl !== '') {
      const bundle = await (await fetch(toAbsolute(bundleUrl))).text()
      if (bundle.includes(id)) pass('Bundle скачивается и содержит маркер плагина', `${(bundle.length / 1024).toFixed(0)} кБ`)
      else fail('В содержимом bundle нет id плагина')
    }
  } catch (error) {
    fail('Ошибка проверки клиентской половины', String(error.message ?? error))
  }
}

/* --------------------------------------------------- 7. Реальное действие (опционально) */

if (options.restartRoute !== '') {
  section('7. Реальное действие (перезапуск)')
  if (!listening) {
    warn('Экземпляр не поднялся — пропускаем')
  } else {
    try {
      const before = await (await fetch(`${base}${healthPath}`)).json().catch(() => null)
      const response = await fetch(`${base}${options.restartRoute}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'portability check', source: 'portability' }),
      })
      if (response.status !== 202 && !response.ok) {
        fail('Запрос перезапуска отклонён', `${options.restartRoute} → ${response.status}`)
      } else {
        pass('Запрос перезапуска принят', `HTTP ${response.status}`)
        const limit = Date.now() + 120_000
        let newPid = null
        while (Date.now() < limit) {
          try {
            const live = await (await fetch(`${base}${healthPath}`)).json()
            if (before === null || live.pid !== before.pid) {
              newPid = live.pid
              break
            }
          } catch {
            /* идёт перезапуск, порт временно недоступен */
          }
          await sleep(1000)
        }
        if (newPid === null) fail('После перезапуска сервис не вернулся (именно так выглядит установка у другого)', 'За 120 с новый процесс не появился')
        else pass('Сервис вернулся после перезапуска', `новый pid ${newPid} (старый ${before?.pid ?? '?'})`)
      }
    } catch (error) {
      fail('Ошибка реального действия', String(error.message ?? error))
    }
  }
}

/* ------------------------------------------------- 8. Наблюдение за стабильностью (поздний срыв) */

// В этот раз мы реально падали: `dsh web` привязывает порт первым, а дерево плагинов грузит позже —
// «порт отвечает / интерфейс 200» может быть лишь **временным** состоянием: новый хост через несколько секунд
// умирал от `plugin tree failed to load … writer lock`, а гейт успевал объявить прохождение. Поэтому после
// готовности нужно ещё понаблюдать, чтобы убедиться, что он не умер за спиной.
if (listening && !options.skipStability) {
  section('8. Наблюдение за стабильностью (жив ли после готовности)')
  const watchSec = Number(flag('--stability', '15')) || 15
  const deadline2 = Date.now() + watchSec * 1000
  let alive = true
  let lastPid = null
  let checks = 0
  let firstError = ''
  while (Date.now() < deadline2) {
    try {
      const response = await fetch(`${base}${healthPath}`)
      if (!response.ok) {
        alive = false
        firstError = `Маршрут здоровья вернул ${response.status}`
        break
      }
      const body = await response.json().catch(() => null)
      const pid = body?.pid ?? null
      if (lastPid !== null && pid !== null && pid !== lastPid) {
        alive = false
        firstError = `Процесс заменили (${lastPid} → ${pid})`
        break
      }
      lastPid = pid
      checks += 1
    } catch (error) {
      alive = false
      firstError = String(error.message ?? error)
      break
    }
    await sleep(2_000)
  }
  // Заодно посмотрим, нет ли в выводе запуска новых фатальных строк
  const fatal = bootErrors(readBootLog())
  if (alive && fatal.length === 0) {
    pass(`После готовности удержал стабильность ${watchSec} с`, `проверок: ${checks}, pid ${lastPid ?? '?'}`)
  } else {
    fail('Не продержался после готовности (поздний срыв = ложное прохождение)', firstError !== '' ? firstError : fatal.join(' | ').slice(0, 300))
  }
}

finish()

finish()
