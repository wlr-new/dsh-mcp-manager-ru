/**
 * MCP manager settings panel — rendered inside the web settings page
 * (settings.section entry).
 *
 * One screen: the configured servers with their live state, and a form that
 * adds or edits one. Two behaviours worth calling out:
 *
 *   - **Test before you save.** The form's «Тест» button posts the *draft*, so the
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
    case 'active': return { text: '● Подключено', color: '#3d8b5f' }
    case 'waiting': return { text: '◌ Нет инструментов', color: '#c9763a' }
    case 'starting': return { text: '◌ Подключение…', color: '#c9763a' }
    case 'error': return { text: '✖ Ошибка', color: '#c0504d' }
    default: return { text: '○ Не подключён', color: 'rgba(128,128,128,0.9)' }
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
        <strong style={{ fontSize: '14px' }}>Управление MCP</strong>
        <span style={s.muted}>
          Серверы: {totals.servers} · Подключено: {totals.active} · Инструменты MCP: {totals.tools}
          {totals.broken > 0 ? ` · Ошибки: ${totals.broken}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={{ ...s.button, ...(busy === 'plugin' ? s.buttonDisabled : {}) }}
          disabled={busy !== ''}
          onClick={() => { void act('plugin', async () => await api.setConfig({ enabled: !config.enabled })) }}
        >
          {config.enabled ? 'Отключить плагин' : 'Включить плагин'}
        </button>
      </div>

      <div style={s.muted}>
        Поддерживаются stdio и Streamable HTTP; подключение и отключение выполняются в рантайме, без перезапуска DSH.
        Инструменты сервера появляются в сессии как <code>mcp__&lt;имя_сервера&gt;__&lt;имя_инструмента&gt;</code>.
      </div>

      {state?.bridgeError != null && state.bridgeError !== '' && (
        <div style={s.err}>
          Не найден встроенный в harness MCP-мост (@deepseek-ai/dsh-mcp-client): {state.bridgeError}
        </div>
      )}
      {state !== null && state.bridge !== null && (
        <div style={s.muted}>MCP-мост: {state.bridge.source} ({state.bridge.via})</div>
      )}
      {state !== null && state.dropped > 0 && (
        <div style={s.warn}>В файле конфигурации есть {state.dropped} записей, которые не распознаны или имеют дублирующиеся имена — они пропущены.</div>
      )}
      {error !== '' && <div style={s.err}>{error}</div>}
      {notice !== '' && <div style={s.ok}>{notice}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
        {(state?.servers ?? []).length === 0 && (
          <div style={s.muted}>MCP-серверы ещё не настроены. Нажмите «Добавить сервер» ниже, чтобы начать.</div>
        )}
        {(state?.servers ?? []).map((server) => {
          const view = runtimeOf(server.name)
          const phase = view?.phase ?? 'stopped'
          const badge = phaseBadge(phase)
          const open = expanded === server.name
          const target = server.transport === 'stdio'
            ? `${server.command} ${server.args.join(' ')}`.trim() || '(command не указан)'
            : server.url || '(url не указана)'
          return (
            <div key={server.name} style={s.server}>
              <div style={s.row}>
                <span style={{ ...s.badge, color: badge.color, borderColor: badge.color }}>{badge.text}</span>
                <strong style={{ fontSize: '13px' }}>{server.name}</strong>
                <span style={s.badge}>{server.transport}</span>
                <span style={s.muted}>Инструменты: {view?.toolCount ?? 0}</span>
                {!server.enabled && <span style={s.muted}>(отключён)</span>}
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  style={{ ...s.button, ...(busy !== '' ? s.buttonDisabled : {}) }}
                  disabled={busy !== ''}
                  onClick={() => { void act(`test:${server.name}`, async () => await api.test(server.name)) }}
                >
                  Тест
                </button>
                <button
                  type="button"
                  style={{ ...s.button, ...(busy !== '' ? s.buttonDisabled : {}) }}
                  disabled={busy !== ''}
                  onClick={() => { void act(`toggle:${server.name}`, async () => await api.toggleServer(server.name, !server.enabled)) }}
                >
                  {server.enabled ? 'Отключить' : 'Включить'}
                </button>
                <button
                  type="button"
                  style={{ ...s.button, ...(busy !== '' ? s.buttonDisabled : {}) }}
                  disabled={busy !== ''}
                  onClick={() => { setForm(formOf(server)); setNotice('') }}
                >
                  Изменить
                </button>
                <button
                  type="button"
                  style={{ ...s.buttonDanger, ...(busy !== '' ? s.buttonDisabled : {}) }}
                  disabled={busy !== ''}
                  onClick={() => {
                    if (!window.confirm(`Точно удалить сервер «${server.name}»? Его MCP-инструменты будут сняты с регистрации.`)) return
                    void act(`remove:${server.name}`, async () => await api.removeServer(server.name))
                  }}
                >
                  Удалить
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
                    {open ? 'Свернуть список инструментов' : `Показать инструменты (${view?.toolCount ?? 0})`}
                  </button>
                  {open && <div style={{ ...s.mono, marginTop: '4px' }}>{(view?.tools ?? []).join(', ')}</div>}
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
              Добавить сервер
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
              Перечитать конфигурацию
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
              Импортировать из старого менеджера
            </button>
          </div>
        )
        : (
          <div style={{ ...s.server, borderColor: 'rgba(110,150,220,0.5)' }}>
            <strong style={{ fontSize: '13px' }}>
              {form.originalName === '' ? 'Добавить сервер' : `Редактирование «${form.originalName}»`}
            </strong>

            <div style={s.row}>
              <span style={s.label}>Имя</span>
              <input
                style={s.input}
                value={form.name}
                placeholder="garmin (станет пространством имён mcp__garmin__*)"
                onChange={(event) => update({ name: event.target.value })}
              />
            </div>

            <div style={s.row}>
              <span style={s.label}>Транспорт</span>
              <select
                style={s.input}
                value={form.transport}
                onChange={(event) => update({ transport: event.target.value as DraftForm['transport'] })}
              >
                <option value="stdio">stdio (локальный процесс)</option>
                <option value="streamable-http">streamable-http (удалённый URL)</option>
              </select>
              <label style={{ ...s.muted, display: 'flex', gap: '4px', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => update({ enabled: event.target.checked })}
                />
                Включить после сохранения
              </label>
            </div>

            {form.transport === 'stdio'
              ? (
                <>
                  <div style={s.row}>
                    <span style={s.label}>Команда</span>
                    <input
                      style={s.input}
                      value={form.command}
                      placeholder="/opt/homebrew/bin/uvx"
                      onChange={(event) => update({ command: event.target.value })}
                    />
                  </div>
                  <div style={s.row}>
                    <span style={s.label}>Аргументы</span>
                    <textarea
                      style={s.textarea}
                      value={form.argsText}
                      placeholder={'по одному аргументу на строку:\ngarmin-mcp'}
                      onChange={(event) => update({ argsText: event.target.value })}
                    />
                  </div>
                  <div style={s.row}>
                    <span style={s.label}>Переменные окружения</span>
                    <textarea
                      style={s.textarea}
                      value={form.envText}
                      placeholder={'строки KEY=VALUE (можно оставить пустым)'}
                      onChange={(event) => update({ envText: event.target.value })}
                    />
                  </div>
                  <div style={s.row}>
                    <span style={s.label}>Рабочая директория</span>
                    <input
                      style={s.input}
                      value={form.cwd}
                      placeholder="(необязательно)"
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
                    <span style={s.label}>Заголовки</span>
                    <textarea
                      style={s.textarea}
                      value={form.headersText}
                      placeholder={'строки KEY=VALUE, например:\nAuthorization=Bearer xxx'}
                      onChange={(event) => update({ headersText: event.target.value })}
                    />
                  </div>
                </>
              )}

            <div style={s.row}>
              <span style={s.label}>Таймаут вызова</span>
              <input
                style={{ ...s.input, maxWidth: '120px' }}
                value={form.timeoutText}
                onChange={(event) => update({ timeoutText: event.target.value })}
              />
              <span style={s.muted}>мс (по умолчанию 60000)</span>
            </div>

            <div style={s.row}>
              <span style={s.label}>Заметка</span>
              <input
                style={s.input}
                value={form.description}
                placeholder="только для отображения, в настройки подключения не входит"
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
                Проверить соединение (без сохранения)
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
                Сохранить
              </button>
              <button type="button" style={s.button} onClick={() => setForm(null)}>Отмена</button>
            </div>
          </div>
        )}

      <div style={s.muted}>
        Файл состояния: {state?.file ?? '(неизвестно)'}
        {(state?.legacyCandidates ?? []).length > 0 ? ' · при импорте будут опробованы старые расположения (mcp-servers.json и т. д.)' : ''}
      </div>
    </div>
  )
}
