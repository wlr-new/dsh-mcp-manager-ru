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
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { McpManager, OpResult } from './manager.ts';
import { type ServerEntry } from './servers.ts';
/** A JSON data-model value, the shape the tool-output schema enforces. */
type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
/** Everything the tools need from the mounted plugin. */
export interface ToolContext {
    /** The operation facade. */
    manager: McpManager;
    /** Whether servers may currently connect (both switches on). */
    enabled: () => boolean;
    /** The persisted runtime master switch alone, for an honest status line. */
    masterSwitch: () => boolean;
    /** The state-file path, for error messages. */
    file: () => string;
}
/** Tool: plugin and connection status. */
export declare function statusTool(ctx: ToolContext): ToolDefinition;
/** Tool: list servers with their live state. */
export declare function listTool(ctx: ToolContext): ToolDefinition;
/** Tool: add a server. */
export declare function addTool(ctx: ToolContext): ToolDefinition;
/** Tool: update a server. */
export declare function updateTool(ctx: ToolContext): ToolDefinition;
/** Tool: remove a server (two-step). */
export declare function removeTool(ctx: ToolContext): ToolDefinition;
/** Tool: test a saved server or an unsaved draft. */
export declare function testTool(ctx: ToolContext): ToolDefinition;
/** Tool: import definitions from another manager's file. */
export declare function importTool(ctx: ToolContext): ToolDefinition;
/** Tool: re-read the state file and reconcile. */
export declare function reloadTool(ctx: ToolContext): ToolDefinition;
/**
 * Build every agent-facing `mcp_manager_*` tool.
 * @param ctx - the tool context.
 * @returns registry-ready definitions.
 */
export declare function buildTools(ctx: ToolContext): ToolDefinition[];
/** Validate a definition on behalf of a surface (shared by tools and routes). */
export declare function checkServer(server: ServerEntry): string[];
/** Serialize an operation result for transport over HTTP. */
export declare function opToJson(result: OpResult): Json;
export {};
