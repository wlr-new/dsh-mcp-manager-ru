/**
 * dsh-mcp-manager — DeepSeek Harness home resolution.
 *
 * Every path this plugin owns is derived from the harness home, never from a
 * hardcoded `~/.dsh`. A relocated home (DSH_HOME, a rescue capsule, the
 * isolated throwaway home the portability harness spins up) would otherwise
 * make the plugin read and write a second, wrong home — and the user would see
 * an empty server list while their real definitions sat untouched elsewhere.
 *
 * Resolution order (per the DSH plugin portability checklist):
 *   1. an explicit override (tests / per-plugin relocation);
 *   2. `DSH_HOME` — set by the host before plugins load;
 *   3. `~/.dsh` — the conventional machine-wide location.
 */
/** The harness home directory: `DSH_HOME` when set (non-empty), else ~/.dsh. */
export declare function dshHome(): string;
/**
 * Resolve one owned path under the harness home.
 * @param override - plugin-specific override (empty = not set).
 * @param segments - path segments below the home.
 * @returns the override when set, else `<home>/<segments…>`.
 */
export declare function pluginPath(override: string | undefined, ...segments: string[]): string;
/** The plugin's own settings file: server definitions plus plugin switches. */
export declare function configPath(home?: string): string;
/**
 * Locations a previous MCP manager may have left behind, best first.
 *
 * The first entry is the real one: `@wingsky-1/dsh-mcp-manager` (the package
 * this plugin replaces) keeps its servers in
 * `$DSH_HOME/@wingsky-1/dsh-mcp-manager/mcp.json`, which is one click away from
 * being re-imported instead of retyped. The bare `mcp-servers.json` name is the
 * layout the unrelated npm package `dsh-mcp-manager` uses; the rest cover
 * plausible hand-written placements.
 *
 * Nothing is written here — these are read-only import sources, and an import
 * never overwrites a definition that already exists.
 *
 * @param home - the harness home.
 * @returns absolute candidate paths (existence is checked by the caller).
 */
export declare function legacyImportCandidates(home?: string): string[];
