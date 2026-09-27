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
import type { Context } from '@deepseek-ai/cordis';
import { McpManager } from './manager.ts';
import { MANAGER_API } from './routes.ts';
import { dshHome } from './home.ts';
/** Stable cordis plugin name. */
export declare const name = "mcp-manager";
/** Services required before the surfaces can mount. */
export declare const inject: string[];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
export declare const MCP_MANAGER_GUIDANCE: string;
/** Plugin config, read from the composition row. */
export interface Config {
    /** When true (default), a system-prompt section announces the plugin. */
    announceToAgent?: boolean;
    /** Master switch for the plugin (routes, tools, prompt section). */
    enabled?: boolean;
}
/**
 * Mount the MCP manager tools, routes, panel and announcement.
 * @param ctx - host plugin context carrying tools/systemPrompt/webServer.
 * @param config - plugin config from the composition row.
 */
export declare function apply(ctx: Context, config?: Config): void;
/** Re-export for the settings panel's route table and the smoke tests. */
export { MANAGER_API, McpManager, dshHome };
/** Re-exports for host consumers and the unit tests. */
export { loadBridge, BRIDGE_PACKAGE } from './core-mcp.ts';
export { ManagerRuntime, groupByServer, toolPrefix } from './runtime.ts';
export { normalizeServer, normalizeServerList, validateServer, serverSignature, toBridgeConfig, emptyServer, SERVER_NAME_PATTERN, } from './servers.ts';
export { loadState, saveState, normalizeConfig } from './store.ts';
export { buildTools } from './tools.ts';
export { makeRoutes } from './routes.ts';
