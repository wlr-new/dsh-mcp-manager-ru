/**
 * dsh-mcp-manager — the operation facade shared by the agent tools and the panel.
 *
 * Both surfaces must do exactly the same thing and report exactly the same
 * words, so every mutation lives here once: read the persisted state, change
 * it, write it atomically, then reconcile the live bridge instances. The tools
 * and the routes are thin adapters over this class.
 *
 * Two invariants the facade enforces on every path:
 *   - **A write is followed by a reconcile.** A definition that persists but
 *     never connects is the failure mode that makes a manager feel broken.
 *   - **Nothing throws past the facade.** A bad request becomes an `ok: false`
 *     result with a human message; an exception here would reach the web boot
 *     (for the routes) or the model (for the tools).
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ServerRuntimeView } from './runtime.ts';
import { emptyServer, type ServerEntry } from './servers.ts';
import { type ManagerConfig } from './store.ts';
/** The complete observable state of the manager. */
export interface ManagerSnapshot {
    /** Plugin switches. */
    config: ManagerConfig;
    /** Persisted definitions, in list order. */
    servers: ServerEntry[];
    /** Runtime state, one per definition. */
    runtime: ServerRuntimeView[];
    /** Where the state file lives. */
    file: string;
    /** Whether the state file existed on disk. */
    exists: boolean;
    /** Entries the normalizer discarded on load. */
    dropped: number;
    /** The harness MCP bridge this plugin drives. */
    bridge: {
        source: string;
        via: string;
    } | null;
    /** Why the bridge could not be resolved, when that is the case. */
    bridgeError: string | null;
    /** Names that are configured but currently contribute no tools. */
    idle: string[];
}
/** Result of one mutating operation. */
export interface OpResult {
    ok: boolean;
    message: string;
    /** The refreshed snapshot, when the operation changed something. */
    snapshot?: ManagerSnapshot;
}
/** Everything the facade needs from the plugin instance. */
export interface ManagerDeps {
    /** Plugin context (bridge loading + the tool registry read). */
    ctx: Context;
    /** Whether the plugin master switch is on. */
    enabled: () => boolean;
    /** Harness home override (tests). */
    home?: string;
}
/**
 * The state + runtime pair behind every surface.
 */
export declare class McpManager {
    private readonly deps;
    private readonly runtime;
    private state;
    private meta;
    constructor(deps: ManagerDeps);
    /** The harness home this instance reads and writes. */
    private get home();
    /**
     * Whether the servers are allowed to be connected right now.
     *
     * Two independent switches, both of which must be on:
     *
     *   - the composition row's `enabled` — the installation switch. Off means the
     *     plugin mounts no tools and no routes at all, and only a profile edit
     *     brings it back.
     *   - the settings file's `enabled` — the runtime master switch, flipped from
     *     the panel or by `mcp_manager_update`. Off disconnects every server and
     *     unregisters every `mcp__*` tool, while leaving the management surface
     *     (panel + `mcp_manager_*`) alive so the state can still be inspected and
     *     switched back on.
     *
     * @returns true when servers may connect.
     */
    active(): boolean;
    /** The persisted runtime master switch, for status surfaces. */
    masterSwitch(): boolean;
    /** Load the state from disk and connect every enabled server. */
    initialize(): Promise<void>;
    /** Reload from disk and reconnect (used after an external edit). */
    refresh(): Promise<ManagerSnapshot>;
    /** Rebuild the live set from the current state. */
    reconcile(): Promise<void>;
    /** Stop every server (unload / disable). */
    shutdown(): Promise<void>;
    /**
     * The current snapshot: persisted state plus one runtime observation.
     *
     * Always derived live. An earlier version gated this on "has the state file
     * been read yet" and fell back to reporting every server as `stopped`, which
     * made a healthy manager look dead to any caller that had not run
     * `initialize()` — including the panel, briefly, on a slow boot.
     *
     * @returns everything a panel or a status tool renders.
     */
    snapshot(): ManagerSnapshot;
    /** One definition by name. */
    server(name: string): ServerEntry | undefined;
    /**
     * This plugin's own agent tools, as the tool registry currently sees them.
     * @returns the registered `mcp_manager_*` names, sorted.
     */
    ownToolNames(): string[];
    /** Persist the given state, then reconcile. */
    private commit;
    /** Patch the plugin-level switches. */
    patchConfig(patch: Record<string, unknown>): Promise<OpResult>;
    /**
     * Add one server.
     * @param raw - an untrusted definition.
     * @returns the operation result.
     */
    addServer(raw: unknown): Promise<OpResult>;
    /**
     * Update one server, optionally renaming it.
     * @param name - the current name.
     * @param patch - the fields to change.
     * @returns the operation result.
     */
    updateServer(name: string, patch: Record<string, unknown>): Promise<OpResult>;
    /**
     * Remove one server and disconnect it.
     * @param name - the definition name.
     * @returns the operation result.
     */
    removeServer(name: string): Promise<OpResult>;
    /**
     * Turn one server on or off.
     * @param name - the definition name.
     * @param enabled - the desired state.
     * @returns the operation result.
     */
    setEnabled(name: string, enabled: boolean): Promise<OpResult>;
    /**
     * Connect a definition and report what it offers.
     *
     * With `draft` the definition is tried without being persisted (the panel's
     * "test before save"); with `name` the *persisted* definition is reconnected
     * from scratch, which is the honest check that the saved config works.
     *
     * @param name - a persisted server to reconnect.
     * @param draft - an unsaved definition to try.
     * @returns a human summary plus the tool list.
     */
    test(name?: string, draft?: unknown): Promise<{
        ok: boolean;
        message: string;
        tools: string[];
        snapshot: ManagerSnapshot;
    }>;
    /**
     * Import definitions from another manager's file.
     *
     * Existing names are never overwritten: an import must not silently replace a
     * working definition. Imported entries keep their own `enabled` flag, so a
     * file that says a server is on will connect right after the import.
     *
     * @param path - an explicit file to read, or empty to try the conventional locations.
     * @returns the operation result.
     */
    importFrom(path?: string): Promise<OpResult>;
    /** Whether the harness bridge is resolvable (used by status surfaces). */
    bridgeStatus(): Promise<{
        ok: boolean;
        source?: string;
        via?: string;
        error?: string;
    }>;
}
/** A fresh, empty definition (re-exported for the panel's "new server" form). */
export { emptyServer };
