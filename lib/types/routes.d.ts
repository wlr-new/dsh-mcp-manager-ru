/**
 * dsh-mcp-manager — loopback HTTP routes for the web panel.
 *
 * Route family: `/api/dsh-mcp-manager/*`. Every route is loopback-only
 * (127.0.0.1 / ::1, same-origin), matching the other dsh-* panels.
 *
 *   GET  /probe            tiny liveness probe (also the portability health route)
 *   GET  /state            settings + servers + live runtime, one snapshot
 *   POST /config           patch the plugin switches
 *   POST /server           add one server, or update one by originalName
 *   POST /server/remove    delete one server (disconnects it first)
 *   POST /server/toggle    enable / disable one server
 *   POST /test             connect a saved server, or try an unsaved draft
 *   POST /import           pull definitions from another manager's file
 *   POST /reload           re-read the state file and reconcile
 *
 * The probe deliberately answers even while the plugin is disabled: it is the
 * portability harness's health check, and a disabled plugin that reports 503
 * would read as "the install is broken" when it is in fact switched off.
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { McpManager } from './manager.ts';
/** Route paths. */
export declare const MANAGER_API: {
    readonly probe: "/api/dsh-mcp-manager/probe";
    readonly state: "/api/dsh-mcp-manager/state";
    readonly config: "/api/dsh-mcp-manager/config";
    readonly server: "/api/dsh-mcp-manager/server";
    readonly serverRemove: "/api/dsh-mcp-manager/server/remove";
    readonly serverToggle: "/api/dsh-mcp-manager/server/toggle";
    readonly test: "/api/dsh-mcp-manager/test";
    readonly import: "/api/dsh-mcp-manager/import";
    readonly reload: "/api/dsh-mcp-manager/reload";
};
/** What the routes need from the mounted plugin. */
export interface RouteDeps {
    /** The operation facade. */
    manager: McpManager;
    /** The harness home. */
    home: string;
    /** Whether the plugin is currently enabled. */
    enabled: () => boolean;
}
/**
 * Build the route list.
 * @param deps - the mounted plugin's services.
 * @returns the routes to register on the host web server.
 */
export declare function makeRoutes(deps: RouteDeps): WebRoute[];
