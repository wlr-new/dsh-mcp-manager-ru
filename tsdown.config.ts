/**
 * dsh-mcp-manager build config: node-half lib bundle plus the browser client
 * bundle (lib/client.js — the closure-factory artifact for the GUI's
 * __ModuleLoader__, served at /plugins/@zhengjunyao/dsh-mcp-manager/client.js).
 *
 * The host half talks to the harness tool registry, the web server and the
 * MCP bridge, all of which exist only inside a running harness and must stay
 * external. The bridge in particular is resolved at runtime by a ladder
 * (src/core-mcp.ts) so the running harness's own copy always wins over any
 * second copy a dependency tree might install.
 */
import { clientBundle } from './shared/tsdown.client.ts'

export default clientBundle('@zhengjunyao/dsh-mcp-manager', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
  ],
})
