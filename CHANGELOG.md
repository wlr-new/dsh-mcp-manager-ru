# Changelog

本文件记录 `@zhengjunyao/dsh-mcp-manager` 的每个发布版本。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.1] - 2026-09-27

### 其它 (Changed)

- docs(readme): correct the restart claim and add guided setup steps

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`
- DSH peer：^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1 || ^0.1.5-rc.2 || ^0.1.5-rc.3 || ^0.1.7-rc.1 || ^0.1.7-rc.2

## [0.1.0] - 2026-09-27

首个版本。自建于 `@wingsky-1/dsh-mcp-manager` 被卸载之后（它用核心 `tools.restrict()` 逐个工具名调和
可见性，每次调用都重算整个 registry view，把 web 宿主压到 CPU 94.7% / 端口 8 秒无响应 / JS 堆 1080 MB）。

### 能力

- **运行时增删启停 MCP 服务器**，不需要重启 DSH。stdio（`command`/`args`/`env`/`cwd`）与
  Streamable HTTP（`url`/`headers`）两种传输。
- **Web 设置页「MCP 管理」面板**：实时阶段、工具数与工具名、测试连接（草稿不落盘）、
  启停、编辑、删除、从旧管理插件导入、重新读取配置。
- **8 个 agent 工具**：`mcp_manager_status` / `list` / `add` / `update` / `remove` / `test` / `import` / `reload`。
  删除是两步的：不传 `confirm` 只预检。
- **配置在 `$DSH_HOME/dsh-mcp-manager.json`**（0600，认 `DSH_HOME`，原子写入）。
  磁盘形态与旧管理插件的 `mcp-manager-mcp.json` 兼容，可直接导入。
- **两个独立开关**：安装开关（profile 组装行）与运行开关（配置文件 / 面板），语义在 README 里写明。

### 架构

- **不自己实现 MCP**，而是用 `ctx.plugin()` 动态挂载 harness 自带的 `@deepseek-ai/dsh-mcp-client`，
  一个启用的服务器一个实例，`fiber.dispose()` 即断开。传输、凭据清洗、重连退避、资源发布、
  命名契约全部复用核心实现。
- **完全不调用 `tools.restrict()`**。唯一的注册表读操作是「一次观测读一次 `ctx.tools.schemas()`，
  内存里按前缀分组」，代价线性。
- **桥的解析走阶梯**：优先运行中 harness 自己那份（从 CLI 入口 realpath 解析），
  其次 profile 链接farm，最后才退回插件自己的依赖树；`/probe` 会报出用的是哪一档。
- 所有宿主半入口都包了异常：MCP 服务器连不上、桥缺失，都不会让 web boot 失败。

### 修复（开发过程中被端到端验证抓到）

- **「停用插件」开关曾经是假的**：面板写的是配置文件里的 `enabled`，而运行时读的是组装行的
  `enabled`，于是拨动开关没有任何效果、所有服务器照旧连着。现在两个开关各自独立且都生效，
  并且有 11 项专门的回归测试（`tests/manager.mjs`）钉住语义。
- **`snapshot()` 曾按「状态文件读过没有」短路成「全部 stopped」**，使任何没调用过
  `initialize()` 的调用者（包括慢启动时的面板）看到一台死掉的机器。改为始终据实计算。

### 验证

- `npm test`：54 项单元测试（定义模型 / 持久化与 0600 / 运行时分组与阶段 / 两个开关语义 /
  桥解析阶梯 / 回环路由与守卫）。
- `npm run verify:live`：真实隔离实例端到端——配置 → 桥 → 真 stdio MCP 服务器（零依赖手写 fixture）
  → `mcp__echo__*` 工具；再走 HTTP 新增 / 停用（工具立刻注销）/ 删除 / 草稿试连 / 总开关，全程无需重启。
- `npm run verify:full`：可移植性门禁（隔离 `DSH_HOME` + tarball 安装 + 健康路由 + 客户端 bundle）。
