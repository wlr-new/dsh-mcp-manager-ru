/**
 * dsh-mcp-manager — locating the harness MCP bridge.
 *
 * The manager does not reimplement the Model Context Protocol. The harness
 * already ships a tested bridge, `@deepseek-ai/dsh-mcp-client`, which owns the
 * stdio / Streamable HTTP transports, credential scrubbing, reconnect backoff,
 * resource publishing and the `mcp__<serverName>__<toolName>` naming contract.
 * The manager's job is to *drive* that bridge: load one instance per configured
 * server, and dispose the instance to disconnect.
 *
 * That indirection is why this plugin cannot inherit the failure mode of the
 * manager it replaces. That one maintained its own client and then reconciled
 * tool visibility by calling the core `tools.restrict()` **once per tool**, and
 * every one of those calls rebuilds the entire registry view — O(tools × names)
 * with fresh Maps and Sets each time. The cost landed on the host's event loop
 * (94.7% CPU, unresponsive port, 1 GB JS heap). Here, connecting registers tools
 * through the bridge and disconnecting disposes them; `restrict()` is never
 * called at all, so there is no per-tool work to get wrong.
 *
 * Resolution is a ladder because a plugin may live in three different layouts:
 *   - installed into a profile (the profile's `node_modules` farm already links
 *     the whole core tree, so a bare specifier resolves);
 *   - installed from a tarball into an isolated throwaway home (the farm exists
 *     there too, but only once the CLI has built it);
 *   - loaded straight from a `link:` development checkout, whose `node_modules`
 *     knows nothing about the core.
 *
 * The running harness's own copy is preferred over anything the plugin might
 * have installed locally: a second, older bridge would diverge from the host's
 * tool registry, and version skew is exactly the class of bug this plugin
 * exists to avoid.
 */
/** The package that provides the bridge. */
export declare const BRIDGE_PACKAGE = "@deepseek-ai/dsh-mcp-client";
/** The subset of the bridge's surface this plugin relies on. */
export interface BridgeModule {
    /** Cordis plugin name, for diagnostics. */
    name: string;
    /** Services the bridge requires (must include `tools`). */
    inject: string[];
    /** Cordis plugin entry: connects one server and registers its tools. */
    apply(ctx: unknown, config: unknown): Promise<void> | void;
}
/** A successful resolution. */
export interface BridgeLocation {
    /** The loaded ESM namespace. */
    module: BridgeModule;
    /** Where it came from — the specifier or absolute path that resolved. */
    source: string;
    /** Which rung of the ladder matched, for diagnostics. */
    via: 'profile' | 'harness' | 'bare';
}
/**
 * Load the harness MCP bridge module.
 *
 * @returns the loaded module and where it came from.
 * @throws when no rung of the ladder resolves — the caller decides whether that
 *   is fatal (it never should be: the settings panel stays up and reports it).
 */
export declare function loadBridge(): Promise<BridgeLocation>;
/**
 * Drop the cached resolution. Used by tests that need to observe the ladder.
 */
export declare function resetBridgeCache(): void;
/** The specifiers/anchors the ladder consults, for a diagnostics panel. */
export declare function bridgeSearchDescription(): string;
