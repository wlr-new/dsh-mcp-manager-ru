/**
 * dsh-mcp-manager — the server registry model.
 *
 * One MCP server definition, its normalization from untrusted JSON, and the
 * validation that decides whether it may be handed to the harness MCP bridge.
 * This module is deliberately free of cordis and of the filesystem so it can be
 * unit-tested directly (see tests/servers.mjs).
 *
 * The on-disk shape is intentionally compatible with the `mcp-manager-mcp.json`
 * file written by the pre-existing npm package of the same purpose
 * (`{ version: 1, servers: [{ name, transport, enabled, command, args, … }] }`),
 * so an existing definition can be imported verbatim instead of retyped.
 */
/** Valid `serverName` — the harness bridge reserves the same namespace shape. */
export declare const SERVER_NAME_PATTERN: RegExp;
/** Reserved because it would collide with the manager's own `mcp_manager_*` tools. */
export declare const RESERVED_NAMES: readonly string[];
/** Supported transports. */
export type Transport = 'stdio' | 'streamable-http';
/** Every transport, in the order the settings panel offers them. */
export declare const TRANSPORTS: readonly Transport[];
/** Automatic reconnect policy, mirrored from the harness MCP client. */
export interface ReconnectSettings {
    /** Reconnect after a lost connection (harness default true). */
    enabled?: boolean;
    /** First retry delay in ms, doubling per consecutive failure (default 500). */
    initialDelayMs?: number;
    /** Backoff ceiling, also the uptime that resets the attempt budget (default 30000). */
    maxDelayMs?: number;
    /** Consecutive failed attempts before giving up (default 10). */
    maxAttempts?: number;
}
/** One MCP server definition. */
export interface ServerEntry {
    /**
     * Stable local namespace for this server's tools: everything it exposes is
     * published to the model as `mcp__<name>__<toolName>`.
     */
    name: string;
    /** Which transport reaches the server. */
    transport: Transport;
    /** Whether the manager should keep this server connected. */
    enabled: boolean;
    /** Free-form note shown in the panel (kept out of the wire config). */
    description: string;
    /** stdio: executable used to start the server. Empty for streamable-http. */
    command: string;
    /** stdio: arguments passed directly, without shell interpolation. */
    args: string[];
    /** stdio: extra environment variables merged on top of the scrubbed ambient env. */
    env: Record<string, string>;
    /** stdio: working directory (empty = the harness's own cwd). */
    cwd: string;
    /** streamable-http: MCP endpoint URL. Empty for stdio. */
    url: string;
    /** streamable-http: extra request headers (e.g. an Authorization bearer). */
    headers: Record<string, string>;
    /** Per-call timeout for this server's tools, in milliseconds. */
    toolCallTimeoutMs: number;
    /** Reconnect policy forwarded to the harness bridge. */
    reconnect: ReconnectSettings;
}
/** Bounds the panel and the tools enforce on the per-call timeout. */
export declare const TIMEOUT_MIN_MS = 1000;
export declare const TIMEOUT_MAX_MS: number;
/** Default per-call timeout, matching the harness bridge default. */
export declare const TIMEOUT_DEFAULT_MS = 60000;
/** A complete definition with every field resolved. */
export declare function emptyServer(name?: string): ServerEntry;
/**
 * Normalize an untrusted reconnect block.
 * @param raw - the raw value from the config file or a panel request.
 * @returns only the fields that were present and well-formed.
 */
export declare function normalizeReconnect(raw: unknown): ReconnectSettings;
/**
 * Normalize one untrusted server definition.
 *
 * Tolerant by design: a malformed field falls back to its default instead of
 * discarding the whole server, because losing a hand-written definition to one
 * bad key is worse than showing it with a corrected value.
 *
 * @param raw - the raw value from the config file or a panel request.
 * @returns a complete definition, or `undefined` when the value is not an object.
 */
export declare function normalizeServer(raw: unknown): ServerEntry | undefined;
/**
 * Normalize a whole untrusted server list, dropping unusable and duplicate entries.
 * @param raw - the raw `servers` array.
 * @returns definitions in file order, deduplicated by name (first wins).
 */
export declare function normalizeServerList(raw: unknown): ServerEntry[];
/**
 * Report every reason a definition may not be connected.
 * @param server - the definition to check.
 * @returns human-readable problems; empty means the definition is connectable.
 */
export declare function validateServer(server: ServerEntry): string[];
/**
 * The part of a definition the harness bridge actually consumes.
 *
 * Used for change detection: editing a description or the enabled flag must not
 * tear down and rebuild a live connection, while editing the command must.
 *
 * @param server - the definition.
 * @returns a stable string that changes exactly when the wire config changes.
 */
export declare function serverSignature(server: ServerEntry): string;
/**
 * Project one definition onto the harness MCP bridge config.
 *
 * The bridge is a core plugin (`@deepseek-ai/dsh-mcp-client`); this is the only
 * place its config contract is written down on our side, so a harness change is
 * a one-line fix here rather than a hunt through the manager.
 *
 * `failOnStartupError` is deliberately false: an unreachable server must not
 * fail this plugin's activation (which would take the whole web boot down), and
 * must not stop the bridge from retrying in the background.
 *
 * @param server - a validated definition.
 * @returns the config object passed to the core bridge plugin.
 */
export declare function toBridgeConfig(server: ServerEntry): Record<string, unknown>;
/**
 * Merge a partial edit onto an existing definition.
 * @param current - the definition being edited.
 * @param patch - the fields to change (absent fields are kept).
 * @returns a complete, normalized definition.
 */
export declare function applyPatch(current: ServerEntry, patch: Record<string, unknown>): ServerEntry;
