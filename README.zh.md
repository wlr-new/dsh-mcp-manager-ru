# dsh-mcp-manager

> DeepSeek Harness 的 **MCP 服务器管理器**：在 Web 设置页或直接让 agent 增删改查 MCP 服务器，
> **连接与断开都在运行时完成，不需要重启 DSH**。

`@zhengjunyao/dsh-mcp-manager` · MIT · 需要 DSH `>= 0.1.5-rc.1` · Node `^22.19.0 || >=24.0.0`

---

## 它解决什么

MCP 服务器通常要写进 harness 的组装配置（`cordis.yml` 那一层）才能加载，改一个就得重启宿主。
这个插件把「有哪些 MCP 服务器」变成一份普通的 JSON 配置，并且能在运行时启停：

- 设置页里点一下就能**新增 / 编辑 / 启停 / 测试 / 删除**一个 MCP 服务器；
- `mcp_manager_*` 工具让 agent 也能做同样的事；
- 服务器提供的工具照常以 `mcp__<服务器名>__<工具名>` 出现在会话里；
- 停用或删除会**立刻注销**那个服务器的工具，不需要重启。

支持两种传输：**stdio**（本地子进程，`command` / `args` / `env` / `cwd`）与
**Streamable HTTP**（远程 URL，`url` / `headers`）。

## 安装

```bash
dsh plugin --profile web add @zhengjunyao/dsh-mcp-manager
# 或从源码
dsh plugin --profile web add link:/path/to/dsh-mcp-manager
```

装完**重启一次 DSH**（宿主半要重新加载插件树），之后所有增删启停都不再需要重启。

## 用法

### 设置页

Web GUI → 设置 → **MCP 管理**。卡片里能：

- 看到每个服务器的实时状态：`● 已连接` / `◌ 未产出工具` / `✖ 失败` / `○ 未加载`，以及它贡献的工具数；
- 展开看它注册了哪些工具名；
- 「测试连接（不保存）」会**真的连一次**并把草稿丢掉，所以填错了在这里就发现；
- 一键「从旧管理插件导入」旧配置。

### Agent 工具

| 工具 | 做什么 |
| --- | --- |
| `mcp_manager_status` | 总览：几个服务器、几个已连、共多少工具、桥从哪加载、配置文件在哪 |
| `mcp_manager_list` | 每个服务器的阶段、工具名、最近错误 |
| `mcp_manager_add` | 新增并立即连接 |
| `mcp_manager_update` | 改任意字段、启停、改名 |
| `mcp_manager_remove` | 删除。**不传 `confirm` 只预检**，确认后才真删 |
| `mcp_manager_test` | 测试已保存的服务器，或传草稿试连（不落盘） |
| `mcp_manager_import` | 从别的 MCP 管理插件的配置文件导入（同名不覆盖） |
| `mcp_manager_reload` | 重读配置文件并重连 |

### 配置文件

`$DSH_HOME/dsh-mcp-manager.json`（默认 `~/.dsh/dsh-mcp-manager.json`，权限 0600）。
**认 `DSH_HOME`**，搬迁过 home 的机器读的是新 home。也可以直接手改，改完点「重新读取配置」。

```json
{
  "version": 1,
  "config": { "enabled": true, "announceToAgent": true },
  "servers": [
    {
      "name": "garmin",
      "transport": "stdio",
      "enabled": true,
      "description": "Garmin Connect 健康数据（只读）",
      "command": "/opt/homebrew/bin/uvx",
      "args": ["garmin-mcp"],
      "env": {},
      "cwd": "",
      "url": "",
      "headers": {},
      "toolCallTimeoutMs": 60000,
      "reconnect": {}
    }
  ]
}
```

`name` 会成为工具命名空间：上例的工具叫 `mcp__garmin__<工具名>`。
只允许字母 / 数字 / 下划线 / 连字符，长度 1–32——与 harness 的命名空间约束一致。

## 两个开关

| 开关 | 位置 | 关闭后 |
| --- | --- | --- |
| 安装开关 | profile 的组装行（`cordis.patch.yml`） | 插件什么都不挂：没有工具、没有面板 |
| 运行开关 | 配置文件 / 面板上的「停用插件」 | 所有 MCP 服务器断开、`mcp__*` 工具全部注销；**管理面板与 `mcp_manager_*` 保留**，方便随时打开 |

## 设计：为什么它不自己实现 MCP

插件**不重新实现 MCP 协议**，而是驱动 harness 自带的桥
`@deepseek-ai/dsh-mcp-client`：一个启用的服务器对应它的一个实例，断开就是销毁那个实例。

那个桥负责 stdio / Streamable HTTP 传输、凭据清洗、断线重连退避、资源发布，以及
`mcp__<serverName>__<toolName>` 命名契约。插件只负责「配置 → 起哪个实例」这件事。

解析顺序是**阶梯式**的（`src/core-mcp.ts`）：优先用**运行中 harness 自己那份**桥，
找不到才退回插件自己依赖树里的副本——版本漂移正是这类插件最容易踩的坑。

### 为什么不碰 `tools.restrict()`

被本插件取代的那个 npm 包（`@wingsky-1/dsh-mcp-manager`）用核心的 `tools.restrict()`
**逐个工具名**去调和工具可见性。而核心每调用一次 `restrict()` 都会重算整个 registry view
（每次新建 Map / Set），于是开销是 O(工具数 × 名单数²)，全部压宿主事件循环上
——实测 CPU 94.7%、端口 8 秒无响应、JS 堆 1080 MB。

本插件**完全不调用 `restrict()`**：连接就是注册工具，断开就是注销工具，这本就是桥的契约。
唯一的注册表读操作是「一次观测读一次 `ctx.tools.schemas()`，然后在内存里按前缀分组」，
所以代价是线性的，而且只在面板或状态工具真的要看的时候才付。

## 验证

```bash
npm run typecheck
npm test                # 54 项单元测试
npm run verify:live      # 真实实例端到端（真 stdio MCP 服务器 → mcp__* 工具）
npm run verify:full      # 可移植性门禁（隔离 DSH_HOME + tarball 安装）
```

`npm run verify:live` 会起一个**隔离的** DSH 实例（自己的 `DSH_HOME`，不碰你的），
在里面真的拉起 `tests/fixtures/echo-mcp-server.mjs`（一个零依赖的手写 MCP 服务器，
所以「两边用同一个坏依赖互相印证」不可能发生），然后断言：

1. 种子配置里的服务器变成 `active`，工具名是 `mcp__echo__echo` / `mcp__echo__add`；
2. 走 HTTP 新增第二个服务器 → 它的工具出现；
3. 停用 → 它的工具**立刻消失**（这就是「不需要重启」的度量）；
4. 删除 → 定义消失；
5. 草稿试连报告工具但**不落盘**，且原服务器恢复连接；
6. 关掉总开关 → `mcp__*` 全注销而管理工具仍在；再打开 → 全部恢复。

## 兼容性

- DSH `>= 0.1.5-rc.1`（在 `0.1.7-rc.2` 上验证通过）。
- 依赖 harness 内置的 `@deepseek-ai/dsh-mcp-client`；缺失时插件**照常启动**，
  面板与 `/probe` 会如实报告 `bridgeError`，不会把宿主拖下水。
- Mac / Linux / Windows 均可（stdio 子进程用绝对路径；Windows 下注意给 `command` 加 `.cmd`）。

## 许可

MIT
