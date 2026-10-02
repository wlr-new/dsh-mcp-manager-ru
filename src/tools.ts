/**
 * dsh-mcp-manager — model-facing tools.
 *
 *   mcp_manager_status   read-only: plugin state, the bridge it drives, counts.
 *   mcp_manager_list     read-only: every server with its live tools and error.
 *   mcp_manager_add      add a stdio / Streamable HTTP server and connect it.
 *   mcp_manager_update   edit a server (including rename and enable/disable).
 *   mcp_manager_remove   delete a server. Without `confirm` it only previews.
 *   mcp_manager_test     connect a saved server — or an unsaved draft — and list
 *                        the tools it offers.
 *   mcp_manager_import   pull definitions out of another manager's file.
 *   mcp_manager_reload   re-read the state file and reconcile.
 *
 * The removal tool is deliberately two-step, matching the rest of the suite:
 * called without `confirm` it returns exactly what would be removed, so the
 * model can show the user before anything is written.
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { McpManager, ManagerSnapshot, OpResult } from './manager.ts'
import { validateServer, type ServerEntry } from './servers.ts'
import { describe } from './runtime.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** A JSON data-model value, the shape the tool-output schema enforces. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/**
 * Project a value onto the JSON data model the output schema validates.
 * Tool outputs are re-validated and replayed, so a rich object must be provably
 * JSON-safe before it is returned.
 * @param value - any JSON-serializable value.
 * @returns the JSON projection.
 */
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json
}

/** Render the tool's `message` field. */
function renderMessage(_args: unknown, value: Record<string, unknown>): ContentBlock[] {
  return text(String(value.message ?? ''))
}

/** The output schema shared by every mutating tool. */
const OP_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
    servers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          transport: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
          phase: { type: 'string', required: true },
          toolCount: { type: 'number', required: true },
          error: { type: 'string' },
        },
      },
    },
  },
} as const

/** One row of the server table, as a JSON-safe record. */
function serverRows(snapshot: ManagerSnapshot): Json[] {
  const runtime = new Map(snapshot.runtime.map((view) => [view.name, view]))
  return snapshot.servers.map((server) => {
    const view = runtime.get(server.name)
    return {
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
      phase: view?.phase ?? 'stopped',
      toolCount: view?.toolCount ?? 0,
      ...(view?.error != null ? { error: view.error } : {}),
    } as Json
  })
}

/** Render a compact, human-readable server table. */
function renderServerTable(snapshot: ManagerSnapshot): string {
  if (snapshot.servers.length === 0) {
    return '(MCP-серверы ещё не настроены)'
  }
  const runtime = new Map(snapshot.runtime.map((view) => [view.name, view]))
  const lines = snapshot.servers.map((server) => {
    const view = runtime.get(server.name)
    const phase = view?.phase ?? 'stopped'
    const mark = phase === 'active' ? '●' : phase === 'error' ? '✖' : phase === 'starting' || phase === 'waiting' ? '◌' : '○'
    const short = server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}`.trim() : server.url
    const detail = view?.error != null ? `  ⚠️ ${view.error}` : ''
    return `${mark} ${server.name}  [${server.transport}]  ${phase}  Инструменты: ${view?.toolCount ?? 0}${detail}\n    ${short}`
  })
  return lines.join('\n')
}

/** Everything the tools need from the mounted plugin. */
export interface ToolContext {
  /** The operation facade. */
  manager: McpManager
  /** Whether servers may currently connect (both switches on). */
  enabled: () => boolean
  /** The persisted runtime master switch alone, for an honest status line. */
  masterSwitch: () => boolean
  /** The state-file path, for error messages. */
  file: () => string
}

/** Guard every mutating tool behind the effective enablement. */
function disabled(enabled: () => boolean): OpResult | undefined {
  if (enabled()) return undefined
  return {
    ok: false,
    message: 'dsh-mcp-manager отключён (главный переключатель MCP-серверов выключен или плагин отключён в профиле); '
      + 'включите его снова на панели «Управление MCP» в настройках либо верните enabled: true в файле конфигурации.',
  }
}

/** Tool: plugin and connection status. */
export function statusTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_status',
    description:
      'Состояние плагина dsh-mcp-manager: сколько MCP-серверов настроено, сколько подключено, сколько инструментов даёт каждый, ' +
      'включён ли плагин, откуда загружен harness-MCP-мост, путь к файлу состояния. Только чтение — ничего не подключает и не меняет.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          enabled: { type: 'boolean' },
          total: { type: 'number' },
          active: { type: 'number' },
          idle: { type: 'number' },
          toolCount: { type: 'number' },
          bridge: { type: 'string' },
          bridgeError: { type: 'string' },
          file: { type: 'string' },
          servers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                transport: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                phase: { type: 'string', required: true },
                toolCount: { type: 'number', required: true },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: renderMessage,
    },
    async execute() {
      const snapshot = ctx.manager.snapshot()
      const active = snapshot.runtime.filter((view) => view.phase === 'active').length
      const idle = snapshot.runtime.filter((view) => view.phase === 'waiting' || view.phase === 'starting').length
      const toolCount = snapshot.runtime.reduce((sum, view) => sum + view.toolCount, 0)
      const bridge = snapshot.bridge !== null ? `${snapshot.bridge.source} (${snapshot.bridge.via})` : ''
      const lines = [
        ctx.enabled() ? 'Главный переключатель MCP-серверов: включён' : 'Главный переключатель MCP-серверов: выключен (все серверы отключены)',
        ctx.masterSwitch() ? '' : '(в файле конфигурации enabled=false)',
        `Серверов: ${snapshot.servers.length} — подключено ${active}, без инструментов: ${idle}`,
        `Инструменты MCP: ${toolCount}`,
        snapshot.bridge !== null ? `MCP-мост: ${bridge}` : 'MCP-мост не загружен',
        snapshot.bridgeError !== null ? `Ошибка загрузки моста: ${snapshot.bridgeError}` : '',
        `Файл состояния: ${snapshot.file}`,
      ].filter((line) => line !== '')
      return {
        ok: snapshot.bridgeError === null,
        message: `dsh-mcp-manager: ${lines.join('; ')}.\n${renderServerTable(snapshot)}`,
        enabled: ctx.enabled(),
        total: snapshot.servers.length,
        active,
        idle,
        toolCount,
        bridge,
        ...(snapshot.bridgeError !== null ? { bridgeError: snapshot.bridgeError } : {}),
        file: snapshot.file,
        servers: serverRows(snapshot) as never,
      }
    },
  })
}

/** Tool: list servers with their live state. */
export function listTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_list',
    description:
      'Список всех настроенных в dsh-mcp-manager MCP-серверов: имя, транспорт, включён ли сервер, текущий этап ' +
      '(active — подключено / waiting — инструменты ещё не получены / error — ошибка / stopped — не загружено), ' +
      'число инструментов и их полные имена, а также последние ошибки. Только чтение.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          servers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                transport: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                phase: { type: 'string', required: true },
                toolCount: { type: 'number', required: true },
                error: { type: 'string' },
                tools: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: renderMessage,
    },
    async execute() {
      const snapshot = ctx.manager.snapshot()
      const detail = snapshot.runtime
        .filter((view) => view.tools.length > 0)
        .map((view) => `${view.name}: ${view.tools.join(', ')}`)
        .join('\n')
      return {
        ok: true,
        message: `${renderServerTable(snapshot)}\n\n${detail === '' ? '(сейчас не зарегистрировано ни одного инструмента MCP)' : detail}`,
        servers: snapshot.servers.map((server) => {
          const view = snapshot.runtime.find((item) => item.name === server.name)
          return {
            name: server.name,
            transport: server.transport,
            enabled: server.enabled,
            phase: view?.phase ?? 'stopped',
            toolCount: view?.toolCount ?? 0,
            ...(view?.error != null ? { error: view.error } : {}),
            tools: (view?.tools ?? []) as never,
          }
        }) as never,
      }
    },
  })
}

/** Tool: add a server. */
export function addTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_add',
    description:
      'Добавляет новый MCP-сервер в dsh-mcp-manager и сразу подключает его (без перезапуска DSH). Для stdio-сервера укажите ' +
      'command/args/env/cwd; для удалённого — transport=streamable-http, url/headers. name станет пространством имён инструментов: ' +
      'инструменты сервера появятся как mcp__<name>__<имя_инструмента>. Перед добавлением рекомендуется проверить соединение черновиком через mcp_manager_test.',
    parameters: {
      name: { type: 'string', description: 'Пространство имён сервера: только буквы/цифры/подчёркивание/дефис, 1–32 символа', required: true },
      transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'Транспорт (по умолчанию stdio)' },
      command: { type: 'string', description: 'stdio: команда запуска (например, /opt/homebrew/bin/uvx)' },
      args: { type: 'array', items: { type: 'string' }, description: 'stdio: аргументы команды; передаются по одному, без shell' },
      env: { type: 'object', additionalProperties: true, description: 'stdio: дополнительные переменные окружения (ключи и значения — строки)' },
      cwd: { type: 'string', description: 'stdio: рабочая директория (необязательно)' },
      url: { type: 'string', description: 'streamable-http: URL эндпоинта MCP' },
      headers: { type: 'object', additionalProperties: true, description: 'streamable-http: дополнительные заголовки запроса' },
      description: { type: 'string', description: 'Заметка (только для отображения; в настройки подключения не входит)' },
      toolCallTimeoutMs: { type: 'number', description: 'Таймаут одного вызова инструмента в миллисекундах (по умолчанию 60000)' },
      enabled: { type: 'boolean', description: 'Включить сразу (по умолчанию true)' },
    },
    output: { schema: OP_OUTPUT, render: renderMessage },
    async execute(args) {
      const blocked = disabled(ctx.enabled)
      if (blocked !== undefined) return { ok: blocked.ok, message: blocked.message }
      const result = await ctx.manager.addServer(args as Record<string, unknown>)
      return {
        ok: result.ok,
        message: `${result.message}\n${renderServerTable(result.snapshot ?? ctx.manager.snapshot())}`,
        servers: serverRows(result.snapshot ?? ctx.manager.snapshot()) as never,
      }
    },
  })
}

/** Tool: update a server. */
export function updateTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_update',
    description:
      'Изменяет существующий MCP-сервер в dsh-mcp-manager: можно поменять transport/command/args/env/cwd/url/headers/description/' +
      'toolCallTimeoutMs, а также включить или отключить его флагом enabled. Смена name — это переименование (старое пространство имён отключается и сервер подключается под новым именем). Передавайте только те поля, которые нужно изменить.',
    parameters: {
      name: { type: 'string', description: 'Текущее имя изменяемого сервера', required: true },
      newName: { type: 'string', description: 'Новое имя (не задавать — без переименования)' },
      transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'Транспорт' },
      command: { type: 'string', description: 'stdio: команда запуска' },
      args: { type: 'array', items: { type: 'string' }, description: 'stdio: аргументы команды' },
      env: { type: 'object', additionalProperties: true, description: 'stdio: дополнительные переменные окружения' },
      cwd: { type: 'string', description: 'stdio: рабочая директория' },
      url: { type: 'string', description: 'streamable-http: URL эндпоинта' },
      headers: { type: 'object', additionalProperties: true, description: 'streamable-http: дополнительные заголовки запроса' },
      description: { type: 'string', description: 'Заметка' },
      toolCallTimeoutMs: { type: 'number', description: 'Таймаут одного вызова инструмента в миллисекундах' },
      enabled: { type: 'boolean', description: 'Включить / отключить' },
    },
    output: { schema: OP_OUTPUT, render: renderMessage },
    async execute(args) {
      const blocked = disabled(ctx.enabled)
      if (blocked !== undefined) return { ok: blocked.ok, message: blocked.message }
      const patch: Record<string, unknown> = { ...(args as Record<string, unknown>) }
      delete patch.name
      const newName = patch.newName
      delete patch.newName
      if (typeof newName === 'string' && newName.trim() !== '') patch.name = newName
      const result = await ctx.manager.updateServer(String((args as Record<string, unknown>).name), patch)
      return {
        ok: result.ok,
        message: `${result.message}\n${renderServerTable(result.snapshot ?? ctx.manager.snapshot())}`,
        servers: serverRows(result.snapshot ?? ctx.manager.snapshot()) as never,
      }
    },
  })
}

/** Tool: remove a server (two-step). */
export function removeTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_remove',
    description:
      'Удаляет MCP-сервер из dsh-mcp-manager и снимает с регистрации все его инструменты. **Без параметра confirm выполняется только предпроверка: возвращается то, что будет удалено, — ничего не записывается** — ' +
      'сначала покажите результат пользователю, а после согласия передайте confirm: true для фактического удаления.',
    parameters: {
      name: { type: 'string', description: 'Имя удаляемого сервера', required: true },
      confirm: { type: 'boolean', description: 'Для фактического удаления передать true (означает, что пользователь согласен)' },
    },
    output: { schema: OP_OUTPUT, render: renderMessage },
    async execute(args) {
      const name = String((args as Record<string, unknown>).name)
      const confirm = (args as Record<string, unknown>).confirm === true
      const target = ctx.manager.server(name)
      if (target === undefined) {
        return { ok: false, message: `Сервер с именем «${name}» не найден.`, servers: serverRows(ctx.manager.snapshot()) as never }
      }
      const view = ctx.manager.snapshot().runtime.find((item) => item.name === name)
      if (!confirm) {
        const detail = target.transport === 'stdio'
          ? `${target.command} ${target.args.join(' ')}`
          : target.url
        return {
          ok: true,
          message: [
            `Предпроверка: будет удалён сервер «${name}», вместе с ним его текущие инструменты (${view?.toolCount ?? 0}):`,
            `  Транспорт: ${target.transport}`,
            `  Определение: ${detail}`,
            view !== undefined && view.tools.length > 0 ? `  Инструменты: ${view.tools.join(', ')}` : '  Инструменты: (нет)',
            'Ничего не записано. Чтобы удалить — вызовите ещё раз с confirm: true.',
          ].join('\n'),
          servers: serverRows(ctx.manager.snapshot()) as never,
        }
      }
      const blocked = disabled(ctx.enabled)
      if (blocked !== undefined) return { ok: blocked.ok, message: blocked.message }
      const result = await ctx.manager.removeServer(name)
      return {
        ok: result.ok,
        message: `${result.message}\n${renderServerTable(result.snapshot ?? ctx.manager.snapshot())}`,
        servers: serverRows(result.snapshot ?? ctx.manager.snapshot()) as never,
      }
    },
  })
}

/** Tool: test a saved server or an unsaved draft. */
export function testTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_test',
    description:
      'Проверяет, можно ли подключиться к MCP-серверу, и перечисляет имена его инструментов. Два варианта: передать name — переподключить сохранённый сервер (сначала отключение, затем повторное подключение); ' +
      'или передать name + command/args (или url) как **черновик** для пробного подключения — черновик не сохраняется, после теста соединение закрывается и всё возвращается в исходное состояние. Перед добавлением сервера надёжнее проверить его именно так.',
    parameters: {
      name: { type: 'string', description: 'Имя сервера (в режиме черновика — имя будущего пространства имён)', required: true },
      draft: { type: 'boolean', description: 'true — пробное подключение переданных полей как черновика, без сохранения' },
      transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'Черновик: транспорт' },
      command: { type: 'string', description: 'Черновик: команда запуска stdio' },
      args: { type: 'array', items: { type: 'string' }, description: 'Черновик: аргументы команды stdio' },
      env: { type: 'object', additionalProperties: true, description: 'Черновик: дополнительные переменные окружения stdio' },
      url: { type: 'string', description: 'Черновик: URL эндпоинта streamable-http' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          tools: { type: 'array', items: { type: 'string' } },
        },
      },
      render: renderMessage,
    },
    async execute(args) {
      const raw = args as Record<string, unknown>
      const name = String(raw.name)
      const useDraft = raw.draft === true || raw.command !== undefined || raw.url !== undefined
      try {
        if (useDraft) {
          const result = await ctx.manager.test(undefined, {
            name,
            transport: raw.transport,
            command: raw.command,
            args: raw.args,
            env: raw.env,
            url: raw.url,
            enabled: true,
          })
          return { ok: result.ok, message: result.message, tools: result.tools as never }
        }
        if (!ctx.enabled()) {
          return { ok: false, message: 'dsh-mcp-manager выключен — подключение невозможно.', tools: [] as never }
        }
        const result = await ctx.manager.test(name, undefined)
        return { ok: result.ok, message: result.message, tools: result.tools as never }
      } catch (error) {
        return { ok: false, message: `Ошибка при тестировании: ${describe(error)}`, tools: [] as never }
      }
    },
  })
}

/** Tool: import definitions from another manager's file. */
export function importTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_import',
    description:
      'Импортирует определения серверов из файла конфигурации другого плагина-менеджера MCP (серверы с теми же именами не перезаписываются; после импорта подключение происходит согласно флагу enabled в файле). ' +
      'Если path не передан, последовательно пробуются $DSH_HOME/@wingsky-1/dsh-mcp-manager/mcp.json (фактическое расположение пакета, который заменяет этот плагин), ' +
      '$DSH_HOME/mcp-servers.json, $DSH_HOME/mcp-manager-mcp.json, $DSH_HOME/dsh-mcp-manager/servers.json.',
    parameters: {
      path: { type: 'string', description: 'Путь к файлу для импорта (не передавать — пробовать стандартные расположения)' },
    },
    output: { schema: OP_OUTPUT, render: renderMessage },
    async execute(args) {
      const blocked = disabled(ctx.enabled)
      if (blocked !== undefined) return { ok: blocked.ok, message: blocked.message }
      const path = (args as Record<string, unknown>).path
      const result = await ctx.manager.importFrom(typeof path === 'string' ? path : undefined)
      return {
        ok: result.ok,
        message: `${result.message}\n${renderServerTable(result.snapshot ?? ctx.manager.snapshot())}`,
        servers: serverRows(result.snapshot ?? ctx.manager.snapshot()) as never,
      }
    },
  })
}

/** Tool: re-read the state file and reconcile. */
export function reloadTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_reload',
    description:
      'Снова читает $DSH_HOME/dsh-mcp-manager.json и переподключается согласно его определениям (когда файл конфигурации вручную изменён снаружи или нужно повторно попытаться подключиться к не запустившемуся серверу). ' +
      'Влияет только на подключения; содержимое конфигурации не меняется.',
    parameters: {},
    output: { schema: OP_OUTPUT, render: renderMessage },
    async execute() {
      if (!ctx.enabled()) {
        await ctx.manager.shutdown()
        return { ok: true, message: 'dsh-mcp-manager выключен: все MCP-серверы отключены.', servers: [] as never }
      }
      const snapshot = await ctx.manager.refresh()
      return {
        ok: true,
        message: `Перечитан файл ${snapshot.file}, серверы переподключены.\n${renderServerTable(snapshot)}`,
        servers: serverRows(snapshot) as never,
      }
    },
  })
}

/**
 * Build every agent-facing `mcp_manager_*` tool.
 * @param ctx - the tool context.
 * @returns registry-ready definitions.
 */
export function buildTools(ctx: ToolContext): ToolDefinition[] {
  return [
    statusTool(ctx),
    listTool(ctx),
    addTool(ctx),
    updateTool(ctx),
    removeTool(ctx),
    testTool(ctx),
    importTool(ctx),
    reloadTool(ctx),
  ]
}

/** Validate a definition on behalf of a surface (shared by tools and routes). */
export function checkServer(server: ServerEntry): string[] {
  return validateServer(server)
}

/** Serialize an operation result for transport over HTTP. */
export function opToJson(result: OpResult): Json {
  return toJson({ ok: result.ok, message: result.message, snapshot: result.snapshot ?? null })
}
