/**
 * dsh-mcp-manager — persistence for the manager settings and the server list.
 *
 * One file under the harness home (`$DSH_HOME/dsh-mcp-manager.json`, mode 0600)
 * holds both the plugin switches and every server definition, so the whole
 * state is discoverable, diffable and editable outside the GUI while the
 * profile bundle row only seeds it on first run.
 *
 * Every read tolerates a missing or malformed file by falling back to the
 * defaults: a broken config must not take the settings panel — or the web boot —
 * down with it. Every write is atomic (temp file + rename) with 0600 applied
 * before the rename, so a crash can never leave a truncated list behind and the
 * file is never briefly world-readable.
 */
import { type ServerEntry } from './servers.ts';
/** Plugin-level settings (the peer of the server list in the same file). */
export interface ManagerConfig {
    /** Master switch for routes, tools and the prompt section. */
    enabled: boolean;
    /** Whether a system-prompt section announces the plugin. */
    announceToAgent: boolean;
}
/** Defaults, applied to every missing or invalid field. */
export declare const DEFAULT_CONFIG: ManagerConfig;
/** The complete persisted state. */
export interface ManagerState {
    config: ManagerConfig;
    servers: ServerEntry[];
}
/** A loaded state plus where it came from and whether anything was dropped. */
export interface StateView extends ManagerState {
    /** Whether the file existed. */
    exists: boolean;
    /** The resolved path. */
    file: string;
    /** Entries the normalizer discarded (unusable or duplicate names). */
    dropped: number;
}
/**
 * Normalize a raw config object over the defaults.
 * @param raw - the parsed file contents (any shape).
 * @returns a complete configuration.
 */
export declare function normalizeConfig(raw: unknown): ManagerConfig;
/**
 * Load the manager state, falling back to the defaults.
 * @param home - the harness home.
 * @returns the state, whether the file existed, and its path.
 */
export declare function loadState(home?: string): Promise<StateView>;
/**
 * Serialize the state exactly as it is written to disk.
 * @param state - the state to serialize.
 * @returns pretty-printed JSON with a trailing newline.
 */
export declare function serializeState(state: ManagerState): string;
/**
 * Write the state atomically with 0600 permissions.
 * @param state - the complete state to persist.
 * @param home - the harness home.
 * @returns the resolved path that was written.
 */
export declare function saveState(state: ManagerState, home?: string): Promise<string>;
/**
 * Find one server definition by name.
 * @param servers - the list to search.
 * @param name - the definition name.
 * @returns the entry, or undefined.
 */
export declare function findServer(servers: readonly ServerEntry[], name: string): ServerEntry | undefined;
/**
 * Insert or replace one definition, preserving list order.
 * @param servers - the current list.
 * @param server - the definition to write.
 * @returns a new list with the definition in place.
 */
export declare function upsertServer(servers: readonly ServerEntry[], server: ServerEntry): ServerEntry[];
/**
 * Remove one definition.
 * @param servers - the current list.
 * @param name - the definition name to drop.
 * @returns a new list without it.
 */
export declare function removeServer(servers: readonly ServerEntry[], name: string): ServerEntry[];
/**
 * Import definitions from another manager's file, without overwriting anything.
 *
 * Accepts both this plugin's own file shape and the `{ version, servers }` shape
 * written by the pre-existing npm package of the same purpose; unknown keys are
 * ignored and every entry arrives disabled unless it was explicitly enabled, so
 * a bulk import can never silently connect a pile of servers on first launch.
 *
 * @param raw - the parsed contents of the foreign file (any shape).
 * @returns the accepted entries and the names that were rejected or already present.
 */
export declare function importServers(raw: unknown): {
    accepted: ServerEntry[];
    skipped: string[];
};
