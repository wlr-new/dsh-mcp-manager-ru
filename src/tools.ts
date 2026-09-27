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
    return '（还没有配置任何 MCP 服务器）'
  }
  const runtime = new Map(snapshot.runtime.map((view) => [view.name, view]))
  const lines = snapshot.servers.map((server) => {
    const view = runtime.get(server.name)
    const phase = view?.phase ?? 'stopped'
    const mark = phase === 'active' ? '●' : phase === 'error' ? '✖' : phase === 'starting' || phase === 'waiting' ? '◌' : '○'
    const short = server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}`.trim() : server.url
    const detail = view?.error != null ? `  ⚠️ ${view.error}` : ''
    return `${mark} ${server.name}  [${server.transport}]  ${phase}  工具 ${view?.toolCount ?? 0} 个${detail}\n    ${short}`
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
    message: 'dsh-mcp-manager 已停用（MCP 服务器总开关关闭，或插件在 profile 里被停用）；'
      + '请在设置页「MCP 管理」重新启用，或把配置文件里的 enabled 改回 true。',
  }
}

/** Tool: plugin and connection status. */
export function statusTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_status',
    description:
      '查看 dsh-mcp-manager 插件状态：共配置了几个 MCP 服务器、几个已连接、各自贡献多少工具、插件是否启用、' +
      '驱动的 harness MCP 桥从哪里加载、状态文件路径。只读，不连接也不修改任何东西。',
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
      const bridge = snapshot.bridge !== null ? `${snapshot.bridge.source}（${snapshot.bridge.via}）` : ''
      const lines = [
        ctx.enabled() ? 'MCP 服务器总开关：开' : 'MCP 服务器总开关：关（服务器已全部断开）',
        ctx.masterSwitch() ? '' : '（配置文件里的 enabled=false）',
        `共 ${snapshot.servers.length} 个服务器：已连接 ${active}、未产出工具 ${idle}`,
        `MCP 工具合计 ${toolCount} 个`,
        snapshot.bridge !== null ? `MCP 桥 ${bridge}` : 'MCP 桥未加载',
        snapshot.bridgeError !== null ? `桥加载失败：${snapshot.bridgeError}` : '',
        `状态文件 ${snapshot.file}`,
      ].filter((line) => line !== '')
      return {
        ok: snapshot.bridgeError === null,
        message: `dsh-mcp-manager：${lines.join('；')}。\n${renderServerTable(snapshot)}`,
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
      '列出 dsh-mcp-manager 里配置的全部 MCP 服务器：名称、传输方式、是否启用、当前阶段（active 已连上 / ' +
      'waiting 未产出工具 / error 失败 / stopped 未加载）、贡献的工具数与完整工具名、以及最近的错误。只读。',
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
        .map((view) => `${view.name}：${view.tools.join('、')}`)
        .join('\n')
      return {
        ok: true,
        message: `${renderServerTable(snapshot)}\n\n${detail === '' ? '（当前没有任何 MCP 工具注册）' : detail}`,
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
      '在 dsh-mcp-manager 里新增一个 MCP 服务器并立即连接（无需重启 DSH）。stdio 服务器填 command/args/env/cwd；' +
      '远程服务器填 transport=streamable-http 与 url/headers。name 会成为工具命名空间：服务器提供的工具将显示为 ' +
      'mcp__<name>__<工具名>。添加前建议先用 mcp_manager_test 传草稿试连。',
    parameters: {
      name: { type: 'string', description: '服务器命名空间，只能字母/数字/下划线/连字符，1–32 字符', required: true },
      transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: '传输方式（默认 stdio）' },
      command: { type: 'string', description: 'stdio：启动命令（如 /opt/homebrew/bin/uvx）' },
      args: { type: 'array', items: { type: 'string' }, description: 'stdio：命令参数，逐项传递，不经 shell' },
      env: { type: 'object', additionalProperties: true, description: 'stdio：额外环境变量（键值均为字符串）' },
      cwd: { type: 'string', description: 'stdio：工作目录（可空）' },
      url: { type: 'string', description: 'streamable-http：MCP 端点 URL' },
      headers: { type: 'object', additionalProperties: true, description: 'streamable-http：额外请求头' },
      description: { type: 'string', description: '备注（仅显示，不进连接配置）' },
      toolCallTimeoutMs: { type: 'number', description: '单次工具调用超时毫秒数（默认 60000）' },
      enabled: { type: 'boolean', description: '是否立即启用（默认 true）' },
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
      '修改 dsh-mcp-manager 里已有的 MCP 服务器：可改 transport/command/args/env/cwd/url/headers/description/' +
      'toolCallTimeoutMs，也可用 enabled 开关它。改 name 等于改名（会断开旧命名空间再以新名字连上）。只传要改的字段。',
    parameters: {
      name: { type: 'string', description: '要修改的服务器当前名称', required: true },
      newName: { type: 'string', description: '改成新名称（不填=不改名）' },
      transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: '传输方式' },
      command: { type: 'string', description: 'stdio：启动命令' },
      args: { type: 'array', items: { type: 'string' }, description: 'stdio：命令参数' },
      env: { type: 'object', additionalProperties: true, description: 'stdio：额外环境变量' },
      cwd: { type: 'string', description: 'stdio：工作目录' },
      url: { type: 'string', description: 'streamable-http：端点 URL' },
      headers: { type: 'object', additionalProperties: true, description: 'streamable-http：额外请求头' },
      description: { type: 'string', description: '备注' },
      toolCallTimeoutMs: { type: 'number', description: '单次工具调用超时毫秒数' },
      enabled: { type: 'boolean', description: '启用 / 停用' },
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
      '从 dsh-mcp-manager 删除一个 MCP 服务器并注销它的全部工具。**不传 confirm 时只做预检并返回将被删除的内容，不写任何东西**——' +
      '请先把预检结果给用户看，得到同意后再传 confirm: true 真正删除。',
    parameters: {
      name: { type: 'string', description: '要删除的服务器名称', required: true },
      confirm: { type: 'boolean', description: '真正执行必须传 true（表示已获得用户同意）' },
    },
    output: { schema: OP_OUTPUT, render: renderMessage },
    async execute(args) {
      const name = String((args as Record<string, unknown>).name)
      const confirm = (args as Record<string, unknown>).confirm === true
      const target = ctx.manager.server(name)
      if (target === undefined) {
        return { ok: false, message: `没有名为「${name}」的服务器。`, servers: serverRows(ctx.manager.snapshot()) as never }
      }
      const view = ctx.manager.snapshot().runtime.find((item) => item.name === name)
      if (!confirm) {
        const detail = target.transport === 'stdio'
          ? `${target.command} ${target.args.join(' ')}`
          : target.url
        return {
          ok: true,
          message: [
            `预检：将删除服务器「${name}」，并注销它当前的 ${view?.toolCount ?? 0} 个工具：`,
            `  传输：${target.transport}`,
            `  定义：${detail}`,
            view !== undefined && view.tools.length > 0 ? `  工具：${view.tools.join('、')}` : '  工具：（无）',
            '未写任何东西。确认要删就再调用一次并传 confirm: true。',
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
      '测试一个 MCP 服务器能否连上，并列出它提供的工具名。两种用法：传 name 重新连接已保存的那个服务器（会先断开再重连）；' +
      '或传 name + command/args（或 url）作为**草稿**试连——草稿不会被保存，测完自动断开并恢复原状。加服务器前用它验证最稳。',
    parameters: {
      name: { type: 'string', description: '服务器名称（草稿模式下即要用作命名空间的名字）', required: true },
      draft: { type: 'boolean', description: 'true 时把本次传的字段当作草稿试连，不保存' },
      transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: '草稿：传输方式' },
      command: { type: 'string', description: '草稿：stdio 启动命令' },
      args: { type: 'array', items: { type: 'string' }, description: '草稿：stdio 命令参数' },
      env: { type: 'object', additionalProperties: true, description: '草稿：stdio 额外环境变量' },
      url: { type: 'string', description: '草稿：streamable-http 端点 URL' },
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
          return { ok: false, message: 'dsh-mcp-manager 已被停用，无法连接。', tools: [] as never }
        }
        const result = await ctx.manager.test(name, undefined)
        return { ok: result.ok, message: result.message, tools: result.tools as never }
      } catch (error) {
        return { ok: false, message: `测试失败：${describe(error)}`, tools: [] as never }
      }
    },
  })
}

/** Tool: import definitions from another manager's file. */
export function importTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_import',
    description:
      '从另一个 MCP 管理插件的配置文件里导入服务器定义（同名不覆盖，导入后按文件里的 enabled 状态连接）。' +
      '不传 path 时依次尝试 $DSH_HOME/mcp-servers.json、$DSH_HOME/mcp-manager-mcp.json、$DSH_HOME/dsh-mcp-manager/servers.json。',
    parameters: {
      path: { type: 'string', description: '要导入的文件路径（不传=尝试默认位置）' },
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
      '重新读取 $DSH_HOME/dsh-mcp-manager.json 并按其中的定义重连（外部手改了配置文件、或想让某个没连上的服务器重试一次时用）。' +
      '只影响连接，不改配置内容。',
    parameters: {},
    output: { schema: OP_OUTPUT, render: renderMessage },
    async execute() {
      if (!ctx.enabled()) {
        await ctx.manager.shutdown()
        return { ok: true, message: 'dsh-mcp-manager 已停用，已断开全部 MCP 服务器。', servers: [] as never }
      }
      const snapshot = await ctx.manager.refresh()
      return {
        ok: true,
        message: `已重新读取 ${snapshot.file} 并重连。\n${renderServerTable(snapshot)}`,
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
