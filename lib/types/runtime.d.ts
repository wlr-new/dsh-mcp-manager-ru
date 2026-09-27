/**
 * dsh-mcp-manager — the runtime that connects and disconnects MCP servers.
 *
 * Responsibilities, and deliberately nothing else:
 *
 *   1. **Reconcile** — make the set of live bridge instances equal to the set of
 *      enabled definitions, without disturbing connections whose wire config did
 *      not change (editing a description must not drop a live session).
 *   2. **Report** — a per-server view built from one single enumeration of the
 *      tool registry, plus the last load error.
 *   3. **Probe** — load a definition without persisting it, so the panel can
 *      answer "does this work?" before the user commits an edit.
 *
 * Protocol work lives in `@deepseek-ai/dsh-mcp-client` (see core-mcp.ts).
 * Tool visibility is never touched: connecting registers tools, disconnecting
 * disposes them, and `tools.restrict()` is not used anywhere in this plugin.
 *
 * The one registry read this plugin performs is a single `ctx.tools.schemas()`
 * per observation, grouped in memory by the `mcp__<name>__` prefix. Asking the
 * registry once per server would recompute the whole view per server, which is
 * the quadratic shape that made the plugin this one replaces hang the host.
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ServerEntry } from './servers.ts';
/** Where a server stands right now. */
export type ServerPhase = 
/** Not loaded (disabled, removed, or never started). */
'stopped'
/** A bridge instance is loading; the connection attempt is still in flight. */
 | 'starting'
/** Loaded and contributing at least one tool. */
 | 'active'
/** Loaded, contributing no tools — connecting, retrying, or genuinely empty. */
 | 'waiting'
/** Could not be loaded (bad config, name conflict, or the bridge is missing). */
 | 'error';
/** The observable state of one server. */
export interface ServerRuntimeView {
    /** The `serverName` namespace. */
    name: string;
    /** Current phase. */
    phase: ServerPhase;
    /** Whether a bridge instance is currently loaded for it. */
    loaded: boolean;
    /** The last load error, or null. */
    error: string | null;
    /** Public tool names currently registered by this server, sorted. */
    tools: string[];
    /** `tools.length`, for panels that only show a count. */
    toolCount: number;
    /** When the current phase began (epoch ms), or null before first start. */
    since: number | null;
}
/** Outcome of connecting one definition. */
export interface StartOutcome {
    ok: boolean;
    error?: string;
    tools: string[];
    durationMs: number;
}
/** Outcome of probing a definition that is not (yet) persisted. */
export interface ProbeOutcome extends StartOutcome {
    /** Validation problems found before any connection was attempted. */
    problems: string[];
}
/**
 * How long to wait for a bridge instance's first connection attempt before
 * reporting it as still-connecting.
 *
 * `apply` awaits `connection.ready`, which settles after the *first* attempt,
 * so this is a safety net for a server that never answers, not the normal path.
 * The fiber keeps retrying in the background either way.
 */
export declare const STARTUP_WAIT_MS = 25000;
/** The harness tool-name prefix owned by one server namespace. */
export declare function toolPrefix(serverName: string): string;
/**
 * Group one tool-registry enumeration by server namespace.
 *
 * @param names - every currently registered public tool name.
 * @param ours - the server names this plugin manages.
 * @returns server name → its sorted public tool names.
 */
export declare function groupByServer(names: readonly string[], ours: readonly string[]): Map<string, string[]>;
/**
 * Supervises one bridge instance per enabled server.
 *
 * All mutating operations are serialized through an internal promise chain:
 * the panel, the agent tools and the startup path can each ask for a change at
 * any moment, and interleaving a dispose with a load would trip the bridge's
 * own "serverName already in use" guard.
 */
export declare class ManagerRuntime {
    private readonly entries;
    private readonly ctx;
    private bridge;
    private bridgeFailure;
    private chain;
    /**
     * @param ctx - the plugin context; `ctx.plugin` loads a bridge instance and
     *   `ctx.tools` is the registry this plugin reads (never writes).
     */
    constructor(ctx: Context);
    /** Serialize one operation after every operation already queued. */
    private run;
    /** Load (once) the harness MCP bridge, remembering a failure. */
    private ensureBridge;
    /** The resolved bridge location, for the status surfaces. */
    bridgeInfo(): {
        source: string;
        via: string;
    } | undefined;
    /** The bridge-load failure, when it could not be resolved at all. */
    bridgeError(): string | undefined;
    /** Every public tool name currently registered, in one registry read. */
    private toolNames;
    /**
     * One registry enumeration, filtered to a name prefix.
     *
     * Exposed so a health surface can report that this plugin's own agent tools
     * really mounted — a fact nothing else observes, since the manager's tools are
     * registered on the tool registry rather than exposed over HTTP.
     *
     * @param prefix - the name prefix to keep.
     * @returns the matching tool names, sorted.
     */
    namesWithPrefix(prefix: string): string[];
    /** Tool names grouped by managed server, from one registry read. */
    private toolsByServer;
    /**
     * Bring the live set in line with the given definitions.
     *
     * Servers that are gone, disabled, or whose wire config changed are stopped;
     * the rest are left alone; everything enabled and not yet loaded is started.
     *
     * @param servers - the complete persisted definition list.
     */
    reconcile(servers: readonly ServerEntry[]): Promise<void>;
    /**
     * Stop one server (disposing its bridge instance and unregistering its tools).
     * @param name - the server namespace.
     */
    stop(name: string): Promise<void>;
    /**
     * Start (or restart) one server from a definition, without persisting it.
     * @param server - the definition to connect.
     * @returns what happened, including the tools it contributed.
     */
    start(server: ServerEntry): Promise<StartOutcome>;
    /**
     * Restart one server only if it is currently live.
     * @param server - the definition to reconnect.
     */
    restart(server: ServerEntry): Promise<StartOutcome>;
    /**
     * Connect a definition that is not persisted, report what it offers, then
     * disconnect it and bring the persisted set back.
     *
     * This is the "test before you save" path. It briefly takes over the server's
     * namespace, so a live server of the same name is stopped first and restored
     * afterwards from `saved`.
     *
     * @param server - the draft definition.
     * @param saved - the persisted list, used to restore the live set.
     * @returns the probe result (with validation problems, if any).
     */
    probe(server: ServerEntry, saved: readonly ServerEntry[]): Promise<ProbeOutcome>;
    /** Stop every server (plugin unload / HMR). */
    disposeAll(): Promise<void>;
    /**
     * Build the per-server view for the given persisted list.
     *
     * Definitions that are not live (disabled, or not yet started) still appear,
     * so a panel always shows what the user configured.
     *
     * @param servers - the persisted definitions.
     * @returns one view per definition, in list order.
     */
    view(servers: readonly ServerEntry[]): ServerRuntimeView[];
    /** Whether any server is currently live. */
    liveCount(): number;
    /** Stop one server. Caller must already hold the serialization slot. */
    private stopLocked;
    /** Start one server. Caller must already hold the serialization slot. */
    private startLocked;
}
/** A short, safe message for an unknown thrown value. */
export declare function describe(error: unknown): string;
/** Whether a definition is currently live, for callers holding no runtime. */
export declare function isEnabled(server: ServerEntry): boolean;
