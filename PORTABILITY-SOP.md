# dsh-mcp-manager 可移植性验证 SOP

> 规则来源：`~/.dsh/AGENTS.md` 第 10 节（无条件生效）。判定标准：`2️⃣ AI/Standards/DSH插件可移植性验证清单.md`。
> 工具来源：`DSH /DSH-test/dsh-release-kit/`（`portability.mjs` 已复制进本仓 `scripts/`）。
> **门禁：`✅ 通过` 之前不得发布。**

## 为什么这个插件尤其需要它

本插件的核心能力是**在别人的机器上起别人的 MCP 服务器子进程**，因此它比一般插件多三类只在别人机器上才炸的风险：

1. **MCP 桥的解析**。插件不自己实现 MCP 协议，而是驱动 harness 自带的 `@deepseek-ai/dsh-mcp-client`
   （见 `src/core-mcp.ts` 的解析阶梯）。装成 tarball 后这个包还找不找得到，是「装上了但连不上任何服务器」的根因。
2. **`DSH_HOME` 而不是 `~/.dsh`**。服务器定义文件必须落在 harness 自己的 home 里；写死 `~/.dsh` 会让
   搬迁过 home 的机器读到一份空的服务器列表，而真正配置躺在别处。
3. **验证时定义文件不存在**。健康路由必须在**零配置**时也如实应答，否则「全新机器」会被误判成插件坏了。

## 1. 标准动作（每次发布前）

```bash
npm run verify:full          # = node scripts/portability.mjs --health /api/dsh-mcp-manager/probe
npm run verify:live          # 真实实例端到端：配置 → 真 MCP 服务器 → mcp__* 工具
```

八步，全自动，退出码即结论：

| # | 步骤 | 在防什么 |
| --- | --- | --- |
| 1 | 静态体检 | 本机绝对路径 / 未加守卫的平台专有命令 / 写 `.dsh` 却不认 `DSH_HOME` |
| 2 | `npm pack` + 入口核对 | `main`、`exports["./client"]`、`dsh.bundle.patch`、`files` 里的文件没进包 |
| 3 | 干净安装 | 空 profile + **tarball**（不走 `link:`）；装上了有没有进 `dsh.profile.bundles` |
| 4 | 启动 | 在**隔离的 `DSH_HOME`** 里起实例，并检出启动输出里的报错行 |
| 5 | 宿主半 | `GET /api/dsh-mcp-manager/probe` 是否真的应答 |
| 6 | 客户端半 | `dsh.client` 声明、bundle 注册 id **是否等于包名**、`__DSH_BOOT__.entries` 里有没有它 |
| 7 | 真实动作 | 本插件没有重启类接口，跳过（真实动作由 `verify:live` 承担） |
| 8 | **稳定性观察** | **就绪之后是否还活着**（迟到崩溃 = 假成功） |

> 本插件的「真实动作」是 `npm run verify:live`：在隔离实例里真的起一个 stdio MCP 服务器、
> 断言工具以 `mcp__<name>__*` 注册，再走 HTTP 新增 / 停用 / 删除一遍，证明「不需要重启」。

## 2. 本插件的健康路由说明

`/api/dsh-mcp-manager/probe` 在**插件被停用时也返回 200**（只报 `enabled: false`）。
这是刻意的：它是可移植性门禁的健康检查，一个「被关掉的插件」若返回 503，会被读成「安装坏了」。
它同时报出两个开关，便于区分「故意关掉」与「启动失败」：

```json
{ "ok": true, "enabled": true, "masterSwitch": true, "serving": true,
  "servers": 0, "toolCount": 0, "managerTools": ["mcp_manager_add", "..."],
  "bridge": "harness", "bridgeError": null }
```

- `bridge`：`harness` / `profile` = 用的是 harness 自带那份桥；`bare` = 退回了插件自己的依赖树（版本可能漂移）。
- `managerToolCount`：唯一能证明 agent 工具半边真的挂上了的观测点（那些工具在工具注册表上，不在路由后面）。

## 3. 手动复核

```bash
npm pack
export DSH_HOME=$(mktemp -d)/dsh-home                      # ① 必须隔离
dsh --profile verify-mcp-mgr --from-default-profile web --dump-config
dsh plugin --profile verify-mcp-mgr add "file:$PWD/zhengjunyao-dsh-mcp-manager-0.1.0.tgz"
python3 -c "import json;print(json.load(open('$DSH_HOME/profiles/verify-mcp-mgr/package.json'))['dsh']['profile']['bundles'])"
dsh --profile verify-mcp-mgr --port 3456 --no-open > /tmp/verify.log 2>&1 &
grep -n "Error\|error:" /tmp/verify.log                    # ② 端口 LISTEN ≠ 启动成功
curl -s http://127.0.0.1:3456/api/dsh-mcp-manager/probe    # ③ 宿主半
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' /tmp/verify.log | head -1 | cut -d= -f2)
curl -s -L -c /tmp/ck -b /tmp/ck "http://127.0.0.1:3456/?token=$TOKEN" -o /tmp/idx.html
grep -c "@zhengjunyao/dsh-mcp-manager/client.js" /tmp/idx.html    # ④ 客户端半
sleep 15 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3456/api/dsh-mcp-manager/probe   # ⑤ 还活着吗
lsof -ti tcp:3456 -sTCP:LISTEN | xargs -r kill; rm -rf "$DSH_HOME" *.tgz
```

## 4. 四个必须知道的坑

1. **必须隔离 `DSH_HOME`。** 同机第二个实例会等 `~/.dsh/.credentials.yaml` 的写锁直到超时
   （`atomic-write: timed out waiting for the writer lock`）而启动失败——不隔离，验证结果全是假的。
   本插件的 `verify:live` 也因此**从不碰真实 `~/.dsh`**。
2. **端口 LISTEN ≠ 启动成功。** `dsh web` 先绑端口、后加载插件树；凭证写锁超时这类失败要 ~30 秒才爆。
   所以既要看启动输出的报错行，也要在就绪后再守一段。
3. **带 token 的 URL 行来得晚，且不能靠 pipe 抓。** `dsh web` 会 fork 出真正的服务进程，
   wrapper 退出后 pipe 就关了，fork 出去那半写的 token 全丢——所以工具用**文件**做 stdio。
4. **验证只能证明「别人的机器装得上、起得来」**，不能证明「连得上别人的 MCP 服务器」——
   那取决于对方服务器本身。本插件的契约是：**配置写对了就连上，写错了如实报错，且不影响 harness 启动**。

## 5. 一票否决（任一出现即不得发布）

1. 源码里有本机绝对路径。
2. 声明的入口 / 运行时按路径加载的文件没进包。
3. tarball 装进空 profile 后没进 `dsh.profile.bundles`。
4. 启动输出里有报错（哪怕端口能探到）。
5. 客户端 bundle 注册 id 与包名不一致。
6. `__DSH_BOOT__.entries` 里没有 `@zhengjunyao/dsh-mcp-manager/client.js`。
7. 真实动作后服务没能恢复（本插件用 `verify:live` 的增删启停代替）。
8. **就绪后没守住**（观察窗口内健康路由掉线 / 进程被替换 / 冒出新的启动致命行）。

## 6. 通过之后

1. `npm run verify:full` 输出 `✅ 通过`，`npm run verify:live` 输出 `✅ 真实实例端到端验证通过`。
2. 把结论写进项目档案（通过 / 未通过 + 失败项）。
3. 再走版本纪律 → git tag → npm publish → 聚合平台。

> 顺序很重要：**可移植性验证在版本纪律之前**。版本号错了可以再发一版；别人装不上是「发出去就是坏的」。
