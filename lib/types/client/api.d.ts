/**
 * Browser-side API client for the /api/dsh-mcp-manager route family.
 *
 * The only data access path the settings panel uses — plain fetch, same origin,
 * so no credentials or CORS handling are involved.
 */
/** A server definition as the host reports and accepts it. */
export interface ServerView {
    name: string;
    transport: 'stdio' | 'streamable-http';
    enabled: boolean;
    description: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    url: string;
    headers: Record<string, string>;
    toolCallTimeoutMs: number;
    reconnect: Record<string, unknown>;
}
/** Where one server stands right now. */
export interface ServerRuntimeView {
    name: string;
    phase: 'stopped' | 'starting' | 'active' | 'waiting' | 'error';
    loaded: boolean;
    error: string | null;
    tools: string[];
    toolCount: number;
    since: number | null;
}
/** The plugin-level switches. */
export interface ManagerConfigView {
    enabled: boolean;
    announceToAgent: boolean;
}
/** The panel's state payload. */
export interface ManagerStateView {
    ok: boolean;
    config: ManagerConfigView;
    servers: ServerView[];
    runtime: ServerRuntimeView[];
    file: string;
    exists: boolean;
    dropped: number;
    bridge: {
        source: string;
        via: string;
    } | null;
    bridgeError: string | null;
    idle: string[];
    home: string;
    legacyCandidates: string[];
}
/** A mutation response. */
export interface OpResponse {
    ok: boolean;
    message: string;
    snapshot: Omit<ManagerStateView, 'ok' | 'home' | 'legacyCandidates'> | null;
}
/** A test response. */
export interface TestResponse {
    ok: boolean;
    message: string;
    tools: string[];
    snapshot: Omit<ManagerStateView, 'ok' | 'home' | 'legacyCandidates'> | null;
}
/** An API failure carrying the host's message. */
export declare class ManagerApiError extends Error {
    constructor(message: string);
}
/** The MCP manager panel API. */
export declare class ManagerApi {
    /** The full state (settings + servers + live runtime). */
    state(): Promise<ManagerStateView>;
    /** Patch the plugin switches. */
    setConfig(patch: Record<string, unknown>): Promise<OpResponse>;
    /** Add a server, or update `originalName` with `server`. */
    saveServer(server: Record<string, unknown>, originalName?: string): Promise<OpResponse>;
    /** Delete one server. */
    removeServer(name: string): Promise<OpResponse>;
    /** Enable or disable one server. */
    toggleServer(name: string, enabled: boolean): Promise<OpResponse>;
    /** Reconnect one saved server, or try an unsaved draft. */
    test(name: string, server?: Record<string, unknown>): Promise<TestResponse>;
    /** Import definitions from another manager's file. */
    importServers(path?: string): Promise<OpResponse>;
    /** Re-read the state file and reconcile. */
    reload(): Promise<OpResponse>;
}
