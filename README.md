# dsh-mcp-manager

[English](README.md) · [中文](README.zh.md)

> **MCP server manager for DeepSeek Harness.** Add, edit, enable and test Model Context Protocol
> servers from the Web settings page or from agent tools — connected and disconnected **at runtime,
> with no DSH restart**.

`@zhengjunyao/dsh-mcp-manager` · MIT · requires DSH `>= 0.1.5-rc.1` · Node `^22.19.0 || >=24.0.0`

---

## What it is for

An MCP server normally has to be wired into the harness composition to be loaded, so changing one
means restarting the host. This plugin turns "which MCP servers exist" into an ordinary JSON file and
makes it live:

- a settings card to **add / edit / enable / test / remove** a server;
- `mcp_manager_*` agent tools that do the same thing;
- the server's tools appear in the session as `mcp__<serverName>__<toolName>`;
- disabling or removing a server **unregisters its tools immediately**.

Two transports: **stdio** (a local child process: `command` / `args` / `env` / `cwd`) and
**Streamable HTTP** (a remote URL: `url` / `headers`).

## Install

```bash
dsh plugin --profile web add @zhengjunyao/dsh-mcp-manager
# or from a checkout
dsh plugin --profile web add link:/path/to/dsh-mcp-manager
```

Restart DSH **once** after installing (the host half has to be loaded); after that, nothing here
needs a restart.

## Usage

Web GUI → Settings → **MCP 管理** (MCP manager). The card shows each server's live phase
(`● connected` / `◌ no tools` / `✖ failed` / `○ not loaded`), its tool count and its tool names,
and offers a **test** button that really connects — a draft is tried and thrown away, so a typo is
caught before it is saved.

Agent tools: `mcp_manager_status`, `mcp_manager_list`, `mcp_manager_add`, `mcp_manager_update`,
`mcp_manager_remove` (previews unless `confirm: true`), `mcp_manager_test`, `mcp_manager_import`,
`mcp_manager_reload`.

### Configuration

`$DSH_HOME/dsh-mcp-manager.json` (default `~/.dsh/dsh-mcp-manager.json`, mode 0600).
It honours `DSH_HOME`, so a relocated home reads the relocated file. Hand edits are fine —
press "reload config" afterwards.

```json
{
  "version": 1,
  "config": { "enabled": true, "announceToAgent": true },
  "servers": [
    {
      "name": "garmin",
      "transport": "stdio",
      "enabled": true,
      "command": "/opt/homebrew/bin/uvx",
      "args": ["garmin-mcp"],
      "env": {}, "cwd": "",
      "url": "", "headers": {},
      "toolCallTimeoutMs": 60000,
      "reconnect": {}
    }
  ]
}
```

`name` becomes the tool namespace: the example above publishes `mcp__garmin__<tool>`. It must match
`[A-Za-z0-9_-]{1,32}`, the same constraint the harness bridge enforces.

## Two switches

| Switch | Where | When off |
| --- | --- | --- |
| installation | the profile bundle row (`cordis.patch.yml`) | nothing mounts: no tools, no panel |
| runtime | the config file / the panel's "disable" button | every MCP server disconnects and every `mcp__*` tool unregisters; the panel and `mcp_manager_*` stay, so it can be switched back on |

## Design: why it does not implement MCP itself

The plugin **does not reimplement the protocol**. It drives the harness's own bridge,
`@deepseek-ai/dsh-mcp-client`: one instance per enabled server, disposed to disconnect. That bridge
owns the stdio / Streamable HTTP transports, credential scrubbing, reconnect backoff, resource
publishing and the `mcp__<serverName>__<toolName>` naming contract. This plugin only decides which
instance should exist.

Resolution is a **ladder** (`src/core-mcp.ts`) that prefers the running harness's own copy of the
bridge and only falls back to the plugin's dependency tree — version skew is the classic failure of a
plugin that bundles its own client.

### Why it never calls `tools.restrict()`

The npm package this replaces (`@wingsky-1/dsh-mcp-manager`) reconciled tool visibility by calling the
core `tools.restrict()` **once per tool name**. Every such call rebuilds the entire registry view with
fresh Maps and Sets, so the loop cost O(tools × names²) on the host's event loop — measured at 94.7%
CPU, an 8-second unresponsive port and a 1080 MB heap.

This plugin **calls `restrict()` nowhere**: connecting registers tools, disconnecting unregisters
them, which is the bridge's own contract. Its single registry read is one `ctx.tools.schemas()` per
observation, grouped in memory by prefix — linear, and paid only when a panel or a status tool
actually looks.

## Verification

```bash
npm run typecheck
npm test                 # 54 unit tests
npm run verify:live      # real instance, end to end
npm run verify:full      # portability gate (isolated DSH_HOME, tarball install)
```

`verify:live` boots an **isolated** DSH instance (its own `DSH_HOME`; your install is untouched) and
runs `tests/fixtures/echo-mcp-server.mjs` — a dependency-free MCP server written for the check, so a
shared broken dependency cannot make both sides agree on a wrong wire format. It then asserts that the
seeded server becomes `active` with tools named `mcp__echo__*`, that adding a second server over HTTP
publishes its tools, that disabling it unregisters them, that removing it drops the definition, that a
draft probe reports tools without being persisted, and that the master switch drains and restores.

## Compatibility

- DSH `>= 0.1.5-rc.1` (verified on `0.1.7-rc.2`).
- Requires the harness-provided `@deepseek-ai/dsh-mcp-client`. If it is missing the plugin still
  boots; the panel and `/probe` report `bridgeError` instead of taking the host down.
- macOS / Linux / Windows (stdio uses an absolute `command`; on Windows remember the `.cmd` suffix).

## License

MIT
