/**
 * MCP manager settings panel — rendered inside the web settings page
 * (settings.section entry).
 *
 * One screen: the configured servers with their live state, and a form that
 * adds or edits one. Two behaviours worth calling out:
 *
 *   - **Test before you save.** The form's 测试 button posts the *draft*, so the
 *     host connects the definition without persisting it, reports the tools it
 *     offers, disconnects, and restores the previous live set. A typo is caught
 *     here rather than after a save.
 *   - **Deleting disconnects.** Removal is confirmed, then the host disposes the
 *     bridge instance, which is what unregisters those MCP tools.
 *
 * Plain React, inline styles only (no CSS pipeline, no theme coupling).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ManagerApi, ManagerApiError,
  type ManagerConfigView, type ManagerStateView, type ServerRuntimeView, type ServerView,
} from './api.ts'

/** Module-level API client (stateless; the component closes over it). */
const api = new ManagerApi()

/** One shared style sheet (kept tiny and theme-agnostic). */
const s = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    maxWidth: '880px',
    padding: '14px 16px',
    borderRadius: '10px',
    border: '1px solid rgba(128,128,128,0.3)',
    fontSize: '13px',
    color: 'inherit',
  } as const,
  row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } as const,
  label: { fontSize: '12px', opacity: 0.85, minWidth: '78px' } as const,
  input: {
    flex: 1,
    minWidth: '200px',
    padding: '4px 6px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'rgba(128,128,128,0.08)',
    color: 'inherit',
    fontSize: '12px',
  } as const,
  textarea: {
    flex: 1,
    minWidth: '200px',
    minHeight: '54px',
    padding: '4px 6px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'rgba(128,128,128,0.08)',
    color: 'inherit',
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  } as const,
  button: {
    padding: '4px 10px',
    borderRadius: '6px',
    cursor: 'pointer',
    border: '1px solid rgba(128,128,128,0.4)',
    background: 'rgba(128,128,128,0.14)',
    color: 'inherit',
    fontSize: '12px',
    whiteSpace: 'nowrap',
  } as const,
  buttonPrimary: {
    padding: '4px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    border: '1px solid rgba(110,150,220,0.65)',
    background: 'rgba(90,130,200,0.22)',
    color: 'inherit',
    fontSize: '12px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  } as const,
  buttonDanger: {
    padding: '4px 10px',
    borderRadius: '6px',
    cursor: 'pointer',
    border: '1px solid rgba(190,100,95,0.55)',
    background: 'rgba(190,100,95,0.16)',
    color: 'inherit',
    fontSize: '12px',
    whiteSpace: 'nowrap',
  } as const,
  buttonDisabled: { opacity: 0.45, cursor: 'not-allowed' } as const,
  server: {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    padding: '9px 11px',
    borderRadius: '8px',
    border: '1px solid rgba(128,128,128,0.25)',
    background: 'rgba(128,128,128,0.05)',
  } as const,
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', opacity: 0.85, wordBreak: 'break-all' } as const,
  ok: { fontSize: '12px', color: '#3d8b5f' } as const,
  err: { fontSize: '12px', color: '#c0504d', whiteSpace: 'pre-wrap' } as const,
  warn: { fontSize: '12px', color: '#c9763a' } as const,
  muted: { fontSize: '11px', opacity: 0.65 } as const,
  badge: {
    fontSize: '10px',
    padding: '1px 6px',
    borderRadius: '999px',
    border: '1px solid rgba(128,128,128,0.4)',
    opacity: 0.9,
    whiteSpace: 'nowrap',
  } as const,
} as const

/** The phase badge colour and glyph. */
function phaseBadge(phase: ServerRuntimeView['phase']): { text: string; color: string } {
  switch (phase) {
    case 'active': return { text: '● 已连接', color: '#3d8b5f' }
    case 'waiting': return { text: '◌ 未产出工具', color: '#c9763a' }
    case 'starting': return { text: '◌ 连接中', color: '#c9763a' }
    case 'error': return { text: '✖ 失败', color: '#c0504d' }
    default: return { text: '○ 未加载', color: 'rgba(128,128,128,0.9)' }
  }
}

/** Split a textarea into trimmed, non-empty lines. */
function linesOf(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** Parse `KEY=VALUE` / `KEY: VALUE` lines into a dictionary. */
function dictOf(value: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of linesOf(value)) {
    const match = /^([^=:]+)\s*[=:]\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1].trim()
    if (key !== '') out[key] = match[2]
  }
  return out
}

/** Render a dictionary back into `KEY=VALUE` lines. */
function dictText(value: Record<string, string> | undefined): string {
  if (value === undefined) return ''
  return Object.entries(value).map(([key, item]) => `${key}=${item}`).join('\n')
}

/** The editable form state (strings, so a half-typed value survives a keystroke). */
interface DraftForm {
  /** The name the server is currently stored under (empty = a new server). */
  originalName: string
  name: string
  transport: 'stdio' | 'streamable-http'
  enabled: boolean
  description: string
  command: string
  argsText: string
  envText: string
  cwd: string
  url: string
  headersText: string
  timeoutText: string
}

/** Build the form state for a new server. */
function blankForm(): DraftForm {
  return {
    originalName: '',
    name: '',
    transport: 'stdio',
    enabled: true,
    description: '',
    command: '',
    argsText: '',
    envText: '',
    cwd: '',
    url: '',
    headersText: '',
    timeoutText: '60000',
  }
}

/** Build the form state for an existing server. */
function formOf(server: ServerView): DraftForm {
  return {
    originalName: server.name,
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    description: server.description,
    command: server.command,
    argsText: server.args.join('\n'),
    envText: dictText(server.env),
    cwd: server.cwd,
    url: server.url,
    headersText: dictText(server.headers),
    timeoutText: String(server.toolCallTimeoutMs),
  }
}

/** Project the form onto the payload the host accepts. */
function payloadOf(form: DraftForm): Record<string, unknown> {
  const timeout = Number(form.timeoutText)
  return {
    name: form.name.trim(),
    transport: form.transport,
    enabled: form.enabled,
    description: form.description,
    command: form.transport === 'stdio' ? form.command.trim() : '',
    args: form.transport === 'stdio' ? linesOf(form.argsText) : [],
    env: form.transport === 'stdio' ? dictOf(form.envText) : {},
    cwd: form.transport === 'stdio' ? form.cwd.trim() : '',
    url: form.transport === 'streamable-http' ? form.url.trim() : '',
    headers: form.transport === 'streamable-http' ? dictOf(form.headersText) : {},
    toolCallTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 60_000,
  }
}

/**
 * The MCP manager settings card.
 * @returns the rendered panel.
 */
export function McpManagerPanel(): JSX.Element {
  const [state, setState] = useState<ManagerStateView | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [form, setForm] = useState<DraftForm | null>(null)
  const [expanded, setExpanded] = useState<string>('')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState(await api.state())
      setError('')
    } catch (failure) {
      setError(failure instanceof ManagerApiError ? failure.message : String(failure))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  /** Run one mutating action with shared busy/notice plumbing. */
  const act = useCallback(async (key: string, task: () => Promise<{ ok: boolean; message: string }>): Promise<void> => {
    setBusy(key)
    setNotice('')
    try {
      const result = await task()
      setNotice(result.message)
      await refresh()
    } catch (failure) {
      setError(failure instanceof ManagerApiError ? failure.message : String(failure))
    } finally {
      setBusy('')
    }
  }, [refresh])

  const runtimeOf = useCallback((name: string): ServerRuntimeView | undefined =>
    state?.runtime.find((view) => view.name === name), [state])

  const totals = useMemo(() => {
    const views = state?.runtime ?? []
    return {
      servers: state?.servers.length ?? 0,
      active: views.filter((view) => view.phase === 'active').length,
      tools: views.reduce((sum, view) => sum + view.toolCount, 0),
      broken: views.filter((view) => view.phase === 'error').length,
    }
  }, [state])

  const update = (patch: Partial<DraftForm>): void => {
    setForm((current) => (current === null ? current : { ...current, ...patch }))
  }

  const config: ManagerConfigView = state?.config ?? { enabled: true, announceToAgent: true }

  return (
    <div style={s.card}>
      <div style={s.row}>
        <strong style={{ fontSize: '14px' }}>MCP 管理</strong>
        <span style={s.muted}>
          {totals.servers} 个服务器 · 已连接 {totals.active} · MCP 工具 {totals.tools}
          {totals.broken > 0 ? ` · 失败 ${totals.broken}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={{ ...s.button, ...(busy === 'plugin' ? s.buttonDisabled : {}) }}
          disabled={busy !== ''}
          onClick={() => { void act('plugin', async () => await api.setConfig({ enabled: !config.enabled })) }}
        >
          {config.enabled ? '停用插件' : '启用插件'}
        </button>
      </div>

      <div style={s.muted}>
        支持 stdio 与 Streamable HTTP；连接与断开都在运行时完成，不需要重启 DSH。
        服务器提供的工具以 <code>mcp__&lt;服务器名&gt;__&lt;工具名&gt;</code> 出现在会话里。
      </div>

      {state?.bridgeError != null && state.bridgeError !== '' && (
        <div style={s.err}>
          找不到 harness 内置的 MCP 桥（@deepseek-ai/dsh-mcp-client）：{state.bridgeError}
        </div>
      )}
      {state !== null && state.bridge !== null && (
        <div style={s.muted}>MCP 桥：{state.bridge.source}（{state.bridge.via}）</div>
      )}
      {state !== null && state.dropped > 0 && (
        <div style={s.warn}>配置文件里有 {state.dropped} 条无法识别或重名的记录，已忽略。</div>
      )}
      {error !== '' && <div style={s.err}>{error}</div>}
      {notice !== '' && <div style={s.ok}>{notice}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
        {(state?.servers ?? []).length === 0 && (
          <div style={s.muted}>还没有配置任何 MCP 服务器。点下方「新增服务器」开始。</div>
        )}
        {(state?.servers ?? []).map((server) => {
          const view = runtimeOf(server.name)
          const phase = view?.phase ?? 'stopped'
          const badge = phaseBadge(phase)
          const open = expanded === server.name
          const target = server.transport === 'stdio'
            ? `${server.command} ${server.args.join(' ')}`.trim() || '（未填 command）'
            : server.url || '（未填 url）'
          return (
            <div key={server.name} style={s.server}>
              <div style={s.row}>
                <span style={{ ...s.badge, color: badge.color, borderColor: badge.color }}>{badge.text}</span>
                <strong style={{ fontSize: '13px' }}>{server.name}</strong>
                <span style={s.badge}>{server.transport}</span>
                <span style={s.muted}>工具 {view?.toolCount ?? 0} 个</span>
                {!server.enabled && <span style={s.muted}>（已停用）</span>}
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  style={{ ...s.button, ...(busy !== '' ? s.buttonDisabled : {}) }}
                  disabled={busy !== ''}
                  onClick={() => { void act(`test:${server.name}`, async () => await api.test(server.name)) }}
                >
                  测试
                </button>
                <button
                  type="button"
                  style={{ ...s.button, ...(busy !== '' ? s.buttonDisabled : {}) }}
                  disabled={busy !== ''}
                  onClick={() => { void act(`toggle:${server.name}`, async () => await api.toggleServer(server.name, !server.enabled)) }}
                >
                  {server.enabled ? '停用' : '启用'}
                </button>
                <button
                  type="button"
                  style={{ ...s.button, ...(busy !== '' ? s.buttonDisabled : {}) }}
                  disabled={busy !== ''}
                  onClick={() => { setForm(formOf(server)); setNotice('') }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  style={{ ...s.buttonDanger, ...(busy !== '' ? s.buttonDisabled : {}) }}
                  disabled={busy !== ''}
                  onClick={() => {
                    if (!window.confirm(`确定删除服务器「${server.name}」？它的 MCP 工具会随之注销。`)) return
                    void act(`remove:${server.name}`, async () => await api.removeServer(server.name))
                  }}
                >
                  删除
                </button>
              </div>
              <div style={s.mono}>{target}</div>
              {server.description !== '' && <div style={s.muted}>{server.description}</div>}
              {view?.error != null && view.error !== '' && <div style={s.err}>{view.error}</div>}
              {(view?.tools.length ?? 0) > 0 && (
                <div>
                  <button
                    type="button"
                    style={{ ...s.button, padding: '1px 7px', fontSize: '11px' }}
                    onClick={() => setExpanded(open ? '' : server.name)}
                  >
                    {open ? '收起工具' : `展开 ${view?.toolCount ?? 0} 个工具`}
                  </button>
                  {open && <div style={{ ...s.mono, marginTop: '4px' }}>{(view?.tools ?? []).join('、')}</div>}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {form === null
        ? (
          <div style={s.row}>
            <button type="button" style={s.buttonPrimary} onClick={() => { setForm(blankForm()); setNotice('') }}>
              新增服务器
            </button>
            <button
              type="button"
              style={{ ...s.button, ...(busy !== '' ? s.buttonDisabled : {}) }}
              disabled={busy !== ''}
              onClick={() => { void act('reload', async () => {
                const result = await api.reload()
                return { ok: result.ok, message: result.message }
              }) }}
            >
              重新读取配置
            </button>
            <button
              type="button"
              style={{ ...s.button, ...(busy !== '' ? s.buttonDisabled : {}) }}
              disabled={busy !== ''}
              onClick={() => { void act('import', async () => {
                const result = await api.importServers()
                return { ok: result.ok, message: result.message }
              }) }}
            >
              从旧管理插件导入
            </button>
          </div>
        )
        : (
          <div style={{ ...s.server, borderColor: 'rgba(110,150,220,0.5)' }}>
            <strong style={{ fontSize: '13px' }}>
              {form.originalName === '' ? '新增服务器' : `编辑「${form.originalName}」`}
            </strong>

            <div style={s.row}>
              <span style={s.label}>名称</span>
              <input
                style={s.input}
                value={form.name}
                placeholder="garmin（会成为 mcp__garmin__* 命名空间）"
                onChange={(event) => update({ name: event.target.value })}
              />
            </div>

            <div style={s.row}>
              <span style={s.label}>传输</span>
              <select
                style={s.input}
                value={form.transport}
                onChange={(event) => update({ transport: event.target.value as DraftForm['transport'] })}
              >
                <option value="stdio">stdio（本地子进程）</option>
                <option value="streamable-http">streamable-http（远程 URL）</option>
              </select>
              <label style={{ ...s.muted, display: 'flex', gap: '4px', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => update({ enabled: event.target.checked })}
                />
                保存后启用
              </label>
            </div>

            {form.transport === 'stdio'
              ? (
                <>
                  <div style={s.row}>
                    <span style={s.label}>命令</span>
                    <input
                      style={s.input}
                      value={form.command}
                      placeholder="/opt/homebrew/bin/uvx"
                      onChange={(event) => update({ command: event.target.value })}
                    />
                  </div>
                  <div style={s.row}>
                    <span style={s.label}>参数</span>
                    <textarea
                      style={s.textarea}
                      value={form.argsText}
                      placeholder={'每行一个参数：\ngarmin-mcp'}
                      onChange={(event) => update({ argsText: event.target.value })}
                    />
                  </div>
                  <div style={s.row}>
                    <span style={s.label}>环境变量</span>
                    <textarea
                      style={s.textarea}
                      value={form.envText}
                      placeholder={'每行 KEY=VALUE（可空）'}
                      onChange={(event) => update({ envText: event.target.value })}
                    />
                  </div>
                  <div style={s.row}>
                    <span style={s.label}>工作目录</span>
                    <input
                      style={s.input}
                      value={form.cwd}
                      placeholder="（可空）"
                      onChange={(event) => update({ cwd: event.target.value })}
                    />
                  </div>
                </>
              )
              : (
                <>
                  <div style={s.row}>
                    <span style={s.label}>URL</span>
                    <input
                      style={s.input}
                      value={form.url}
                      placeholder="https://example.com/mcp"
                      onChange={(event) => update({ url: event.target.value })}
                    />
                  </div>
                  <div style={s.row}>
                    <span style={s.label}>请求头</span>
                    <textarea
                      style={s.textarea}
                      value={form.headersText}
                      placeholder={'每行 KEY=VALUE，例如：\nAuthorization=Bearer xxx'}
                      onChange={(event) => update({ headersText: event.target.value })}
                    />
                  </div>
                </>
              )}

            <div style={s.row}>
              <span style={s.label}>单次超时</span>
              <input
                style={{ ...s.input, maxWidth: '120px' }}
                value={form.timeoutText}
                onChange={(event) => update({ timeoutText: event.target.value })}
              />
              <span style={s.muted}>毫秒（默认 60000）</span>
            </div>

            <div style={s.row}>
              <span style={s.label}>备注</span>
              <input
                style={s.input}
                value={form.description}
                placeholder="仅用于显示，不进连接配置"
                onChange={(event) => update({ description: event.target.value })}
              />
            </div>

            <div style={s.row}>
              <button
                type="button"
                style={{ ...s.button, ...(busy !== '' ? s.buttonDisabled : {}) }}
                disabled={busy !== ''}
                onClick={() => { void act('draft-test', async () => await api.test(form.name.trim(), payloadOf(form))) }}
              >
                测试连接（不保存）
              </button>
              <button
                type="button"
                style={{ ...s.buttonPrimary, ...(busy !== '' ? s.buttonDisabled : {}) }}
                disabled={busy !== ''}
                onClick={() => {
                  void act('save', async () => {
                    const result = await api.saveServer(
                      payloadOf(form),
                      form.originalName === '' ? undefined : form.originalName,
                    )
                    if (result.ok) setForm(null)
                    return { ok: result.ok, message: result.message }
                  })
                }}
              >
                保存
              </button>
              <button type="button" style={s.button} onClick={() => setForm(null)}>取消</button>
            </div>
          </div>
        )}

      <div style={s.muted}>
        状态文件：{state?.file ?? '（未知）'}
        {(state?.legacyCandidates ?? []).length > 0 ? ' · 导入时会依次尝试 mcp-servers.json 等旧位置' : ''}
      </div>
    </div>
  )
}
