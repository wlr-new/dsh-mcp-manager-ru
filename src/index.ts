/**
 * dsh-mcp-manager — DeepSeek Harness MCP server manager. Host half.
 *
 * Adds, edits, enables, tests and removes Model Context Protocol servers from
 * the Web settings page and from agent tools, connecting and disconnecting them
 * at runtime — no DSH restart, no hand-edited cordis composition.
 *
 * ## Why this is not a reimplementation
 *
 * The harness already ships a tested MCP bridge, `@deepseek-ai/dsh-mcp-client`:
 * it owns the stdio and Streamable HTTP transports, credential scrubbing,
 * reconnect backoff, resource publishing and the `mcp__<serverName>__<tool>`
 * naming contract. This plugin *drives* that bridge — one instance per enabled
 * server, disposed to disconnect — instead of writing a second client.
 *
 * ## Why it cannot hang the host the way its predecessor did
 *
 * The npm package this replaces reconciled tool visibility by calling the core
 * `tools.restrict()` once per tool name. Every one of those calls rebuilds the
 * entire registry view with fresh Maps and Sets, so the loop cost
 * O(tools × names) on the host's event loop and took the web server down
 * (measured: 94.7% CPU, an 8-second unresponsive port, a 1080 MB heap).
 *
 * Here, connecting registers tools and disconnecting disposes them — that is
 * the bridge's own contract. `tools.restrict()` is **never called**. The single
 * registry read this plugin performs is one `ctx.tools.schemas()` per
 * observation, grouped in memory (`runtime.ts`), so the cost is linear and paid
 * only when a panel or a status tool actually asks.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

import { McpManager } from './manager.ts'
import { makeRoutes, MANAGER_API } from './routes.ts'
import { dshHome } from './home.ts'
import { describe } from './runtime.ts'
import { buildTools } from './tools.ts'

/** Stable cordis plugin name. */
export const name = 'mcp-manager'

/** Services required before the surfaces can mount. */
export const inject = ['tools', 'systemPrompt', 'webServer']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 164

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const MCP_MANAGER_GUIDANCE =
  '本机已安装 dsh-mcp-manager 插件（MCP 服务器管理）：可在 Web 设置页「MCP 管理」面板或直接用工具增删改查 MCP 服务器，' +
  '支持 stdio（command/args/env/cwd）与 streamable-http（url/headers）两种传输，连接与断开都在运行时完成、不需要重启 DSH。' +
  '服务器提供的工具以 mcp__<服务器名>__<工具名> 形式出现。' +
  '工具：mcp_manager_status（状态）、mcp_manager_list（列表）、mcp_manager_add（新增并连接）、mcp_manager_update（修改/启停/改名）、' +
  'mcp_manager_remove（删除，必须先预检并经用户同意）、mcp_manager_test（测试已保存的或草稿定义）、mcp_manager_import（从旧管理插件导入）、' +
  'mcp_manager_reload（重读配置并重连）。服务器定义存 $DSH_HOME/dsh-mcp-manager.json（0600）。' +
  '用户提到「MCP / MCP 服务器 / 管理 MCP / 装个 MCP / mcp 工具 / garmin」时即指本插件，请据此协作。'

/** Plugin config, read from the composition row. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /** Master switch for the plugin (routes, tools, prompt section). */
  enabled?: boolean
}

/**
 * Mount the MCP manager tools, routes, panel and announcement.
 * @param ctx - host plugin context carrying tools/systemPrompt/webServer.
 * @param config - plugin config from the composition row.
 */
export function apply(ctx: Context, config?: Config): void {
  const announceToAgent = config?.announceToAgent !== false
  const enabled = config?.enabled !== false
  const home = dshHome()

  const manager = new McpManager({ ctx, enabled: () => enabled, home })

  let disposeTools: (() => void) | undefined
  let disposeRoutes: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (!enabled) return
    try {
      disposeTools = ctx.effect(
        () => {
          const disposers = buildTools({
            manager,
            // The tools gate on the EFFECTIVE state (both switches). The routes
            // gate on the installation switch only, so the panel can always
            // switch the servers back on.
            enabled: () => manager.active(),
            masterSwitch: () => manager.masterSwitch(),
            file: () => manager.snapshot().file,
          }).map((tool) => ctx.tools.register(tool))
          return () => { for (const dispose of disposers) dispose() }
        },
        'dsh-mcp-manager: tools',
      )
    } catch (error) {
      ctx.logger.warn(`dsh-mcp-manager: tool registration failed: ${describe(error)}`)
    }
    try {
      disposeRoutes = ctx.effect(
        () => {
          const disposers = makeRoutes({ manager, home, enabled: () => enabled })
            .map((route) => ctx.webServer.register(route))
          return () => { for (const dispose of disposers) dispose() }
        },
        'dsh-mcp-manager: routes',
      )
    } catch (error) {
      ctx.logger.warn(`dsh-mcp-manager: route registration failed: ${describe(error)}`)
    }
    if (announceToAgent) {
      try {
        disposeSection = ctx.systemPrompt.section({
          name: 'plugin:dsh-mcp-manager',
          order: SECTION_ORDER,
          text: MCP_MANAGER_GUIDANCE,
        })
      } catch (error) {
        ctx.logger.warn(`dsh-mcp-manager: prompt section failed: ${describe(error)}`)
      }
    }
  }

  sync()

  // Connect the configured servers. This must never reject: an external plugin
  // whose apply throws fails the whole web boot, and a dead MCP server is not a
  // reason to take the GUI down.
  void (async () => {
    if (!enabled) return
    try {
      await manager.initialize()
    } catch (error) {
      ctx.logger.warn(`dsh-mcp-manager: initial connection failed: ${describe(error)}`)
    }
  })()

  ctx.effect(() => {
    return () => { void manager.shutdown() }
  }, 'dsh-mcp-manager: connections')
}

/** Re-export for the settings panel's route table and the smoke tests. */
export { MANAGER_API, McpManager, dshHome }

/** Re-exports for host consumers and the unit tests. */
export { loadBridge, BRIDGE_PACKAGE } from './core-mcp.ts'
export { ManagerRuntime, groupByServer, toolPrefix } from './runtime.ts'
export {
  normalizeServer,
  normalizeServerList,
  validateServer,
  serverSignature,
  toBridgeConfig,
  emptyServer,
  SERVER_NAME_PATTERN,
} from './servers.ts'
export { loadState, saveState, normalizeConfig } from './store.ts'
export { buildTools } from './tools.ts'
export { makeRoutes } from './routes.ts'
