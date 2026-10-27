/**
 * dsh-opencode-go-usage — Client half.
 *
 * One ambient row below the composer card:
 * - The current session's provider decides the default: `opencode-go` shows the
 *   quota automatically (and requests it); any other provider stays collapsed
 *   to a small `Go` chip, so no upstream request happens until the user expands
 *   it for that provider.
 * - The expanded/collapsed choice is remembered per provider in localStorage,
 *   so switching providers keeps whatever the user chose for each of them.
 *
 * The browser never sees the API key: it only reads the Host route, which owns
 * the credential and the upstream request.
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/dsh-opencode-go-usage/api/usage'
    const GO_PROVIDER = 'opencode-go'
    const STORAGE_KEY = 'dsh-opencode-go-usage:v1'
    const POLL_MS = 2 * 60 * 1000
    const FLASH_MS = 1600
    const WARN_PERCENT = 80
    const CRITICAL_PERCENT = 95
    const EMPTY_SNAPSHOT = { status: 'loading', current: null }

    const SHORT = { rolling: '5h', weekly: '周', monthly: '月' }
    const FULL = { rolling: '滚动 5 小时', weekly: '本周', monthly: '本月' }
    const WINDOW_ORDER = ['rolling', 'weekly', 'monthly']

    const ERROR_TEXT = {
      NOT_CONFIGURED: '未配置 key',
      AUTH: 'key 无效或无订阅',
      RATE_LIMIT: '被限流，稍后再试',
      TIMEOUT: '请求超时',
      NETWORK: '网络不可达',
      SHAPE: '接口返回异常',
      UPSTREAM: 'opencode.ai 报错',
      FORBIDDEN: '本地服务拒绝访问',
      INTERNAL: '内部错误',
      HTTP: '本地服务异常',
    }

    const CSS = `
@keyframes dsh-ocgo-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`

    const S = {
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 18,
        padding: '0 4px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 'var(--dsh-content-font-size-secondary, 12px)',
        lineHeight: '18px',
        userSelect: 'none',
        whiteSpace: 'nowrap',
      },
      label: { fontWeight: 600 },
      separator: { opacity: 0.5 },
      numbers: { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' },
      icon: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        lineHeight: 'inherit',
        padding: '0 3px',
        opacity: 0.6,
      },
      chip: {
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        font: 'inherit',
        padding: '0 4px',
        opacity: 0.7,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      },
      muted: { opacity: 0.7 },
      success: { color: 'var(--dsw-alias-state-success-primary)' },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
    }

    // -----------------------------------------------------------------------
    // preferences (per provider, localStorage only; no Host state needed)
    // -----------------------------------------------------------------------

    function readPrefs() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function writePrefs(prefs) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
      } catch {}
    }

    // -----------------------------------------------------------------------
    // formatting
    // -----------------------------------------------------------------------

    function formatPercent(percent) {
      return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`
    }

    function percentColor(percent) {
      if (percent >= CRITICAL_PERCENT) return 'var(--dsw-alias-state-error-primary)'
      if (percent >= WARN_PERCENT) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-label-secondary)'
    }

    function pad(value) {
      return String(value).padStart(2, '0')
    }

    function clock(ms) {
      const date = new Date(ms)
      if (Number.isNaN(date.getTime())) return null
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function localDateTime(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return null
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function countdown(resetsAt) {
      if (typeof resetsAt !== 'string') return null
      const target = Date.parse(resetsAt)
      if (!Number.isFinite(target)) return null
      const diff = target - Date.now()
      if (diff <= 0) return '即将重置'
      const minutes = Math.floor(diff / 60_000)
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      const rest = minutes % 60
      if (days > 0) return `${days} 天 ${hours} 小时后重置`
      if (hours > 0) return `${hours} 小时 ${rest} 分后重置`
      return `${Math.max(1, rest)} 分后重置`
    }

    function windowTitle(id, window) {
      const parts = [FULL[id] ?? id, `已用 ${formatPercent(window.percent)}`]
      const left = countdown(window.resetsAt)
      if (left !== null) parts.push(left)
      const at = window.resetsAt ? localDateTime(window.resetsAt) : null
      if (at !== null) parts.push(`（${at}）`)
      return parts.join(' · ')
    }

    // -----------------------------------------------------------------------
    // current provider (the shipped model directory of this session)
    // -----------------------------------------------------------------------

    function useProvider(getDirectories, sessionId) {
      const [directories, setDirectories] = React.useState(() => getDirectories() ?? null)

      React.useEffect(() => {
        if (directories !== null) return undefined
        let stopped = false
        const timers = [50, 300, 1200, 3000].map((ms) =>
          setTimeout(() => {
            if (stopped) return
            const next = getDirectories()
            if (next) setDirectories(next)
          }, ms),
        )
        return () => {
          stopped = true
          for (const timer of timers) clearTimeout(timer)
        }
      }, [directories, getDirectories])

      const instance = React.useMemo(() => {
        if (!directories || sessionId === undefined || sessionId === null) return null
        try {
          const candidate = directories.directoryFor(sessionId)
          return candidate && candidate.store && typeof candidate.store.getSnapshot === 'function' ? candidate : null
        } catch {
          return null
        }
      }, [directories, sessionId])

      React.useEffect(() => {
        if (!instance) return
        try {
          const pending = instance.load()
          if (pending && typeof pending.catch === 'function') pending.catch(() => {})
        } catch {}
      }, [instance])

      const subscribe = React.useCallback(
        (callback) => {
          if (!instance) return () => {}
          try {
            const off = instance.store.subscribe(callback)
            return typeof off === 'function' ? off : () => {}
          } catch {
            return () => {}
          }
        },
        [instance],
      )

      const getSnapshot = React.useCallback(() => {
        if (!instance) return EMPTY_SNAPSHOT
        try {
          return instance.store.getSnapshot() || EMPTY_SNAPSHOT
        } catch {
          return EMPTY_SNAPSHOT
        }
      }, [instance])

      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

      return {
        available: directories !== null,
        status: typeof snapshot.status === 'string' ? snapshot.status : 'loading',
        provider: snapshot && snapshot.current ? snapshot.current.provider : null,
      }
    }

    // -----------------------------------------------------------------------
    // dock row
    // -----------------------------------------------------------------------

    function Dock(props) {
      const providerState = useProvider(props.getDirectories, props.sessionId)
      const provider = providerState.provider
      const [prefs, setPrefs] = React.useState(readPrefs)
      const [state, setState] = React.useState({ data: null, error: null })
      const [busy, setBusy] = React.useState(false)
      const [flash, setFlash] = React.useState(false)
      const flashTimer = React.useRef(undefined)

      const prefKey = provider === null ? '__unknown' : provider
      // Default: opencode-go shows automatically. Any other provider stays
      // collapsed until the user expands it for that provider. When the shipped
      // model directory cannot be read at all, fall back to showing, because
      // this plugin exists to show one account's quota rather than to hide it.
      const expanded =
        prefs[prefKey] === undefined
          ? provider === GO_PROVIDER || (provider === null && !providerState.available)
          : prefs[prefKey] === true

      React.useEffect(
        () => () => {
          if (flashTimer.current !== undefined) clearTimeout(flashTimer.current)
        },
        [],
      )

      const load = React.useCallback(async (force, manual) => {
        setBusy(true)
        setState((prev) => ({ data: prev.data, error: null }))
        try {
          const response = await fetch(`${ROUTE}?refresh=${force ? 1 : 0}`, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          })
          const body = await response.json().catch(() => null)
          if (!body || typeof body !== 'object') {
            setState((prev) => ({ data: prev.data, error: { code: 'HTTP', message: `HTTP ${response.status}` } }))
            return
          }
          if (body.ok !== true) {
            setState((prev) => ({
              data: prev.data,
              error: body.error || { code: 'HTTP', message: `HTTP ${response.status}` },
            }))
            return
          }
          setState({ data: body, error: null })
          if (manual) {
            setFlash(true)
            if (flashTimer.current !== undefined) clearTimeout(flashTimer.current)
            flashTimer.current = setTimeout(() => {
              flashTimer.current = undefined
              setFlash(false)
            }, FLASH_MS)
          }
        } catch {
          setState((prev) => ({ data: prev.data, error: { code: 'NETWORK', message: '无法连接本地服务' } }))
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        if (!expanded) return undefined
        let stopped = false
        const run = (force) => {
          if (!stopped) void load(force, false)
        }
        run(false)
        const timer = setInterval(() => run(false), POLL_MS)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') run(false)
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          stopped = true
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [expanded, load])

      const toggle = React.useCallback(() => {
        setPrefs((prev) => {
          const current = prev[prefKey] === undefined ? provider === GO_PROVIDER : prev[prefKey] === true
          const next = { ...prev, [prefKey]: !current }
          writePrefs(next)
          return next
        })
      }, [prefKey, provider])

      const refreshNow = React.useCallback(() => {
        if (busy) return
        void load(true, true)
      }, [busy, load])

      // While the shipped model directory is still loading (or has no selection
      // yet) there is nothing meaningful to decide: stay out of the dock.
      if (providerState.available && provider === null && providerState.status !== 'error' && !expanded) {
        return null
      }

      if (!expanded) {
        return h(
          'button',
          {
            type: 'button',
            style: S.chip,
            title:
              provider === null
                ? 'OpenCode Go 额度 · 点击显示（正在识别当前 provider）'
                : `OpenCode Go 额度 · 当前 provider：${provider} · 点击显示`,
            onClick: toggle,
            'aria-expanded': false,
          },
          h('span', null, 'Go'),
          state.error !== null ? h('span', { style: S.error }, '!') : null,
        )
      }

      const windows = state.data && state.data.usage ? state.data.usage : null
      const updatedAt = state.data && state.data.fetchedAt ? state.data.fetchedAt : null
      const error = state.error
      const errorText = error ? ERROR_TEXT[error.code] || error.message || '未知错误' : null

      const segments = windows
        ? WINDOW_ORDER.filter((id) => windows[id]).flatMap((id, index) => {
            const window = windows[id]
            const item = h(
              'span',
              { key: id, title: windowTitle(id, window), style: { color: percentColor(window.percent) } },
              `${SHORT[id]} ${formatPercent(window.percent)}`,
            )
            if (index === 0) return [item]
            return [h('span', { key: `${id}-dot`, style: S.separator }, '·'), item]
          })
        : null

      const numbers = windows
        ? h(
            'span',
            {
              style: { ...S.numbers, cursor: busy ? 'default' : 'pointer', opacity: error !== null ? 0.55 : 1 },
              role: 'button',
              tabIndex: 0,
              title: busy ? '正在请求 opencode.ai…' : '点击立即刷新',
              onClick: refreshNow,
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  refreshNow()
                }
              },
            },
            segments,
          )
        : h('span', { style: S.muted }, error !== null ? '暂无数据' : '额度加载中…')

      const status = busy
        ? h('span', { style: S.muted }, '刷新中…')
        : errorText !== null
          ? h('span', { style: S.error, title: error.message || errorText }, `刷新失败：${errorText}`)
          : flash
            ? h('span', { style: S.success }, '✓ 已刷新')
            : null

      const title = [
        provider === null ? 'OpenCode Go 额度' : `OpenCode Go 额度 · 当前 provider：${provider}`,
        errorText !== null ? `错误：${errorText}` : null,
      ]
        .filter(Boolean)
        .join(' · ')

      return h(
        'div',
        { style: S.row, title },
        h('span', { style: S.label }, 'Go'),
        numbers,
        status,
        h(
          'button',
          {
            type: 'button',
            style: {
              ...S.icon,
              opacity: busy ? 0.45 : 0.6,
              cursor: busy ? 'default' : 'pointer',
              animation: busy ? 'dsh-ocgo-spin 0.9s linear infinite' : undefined,
            },
            disabled: busy,
            title: busy
              ? '正在请求 opencode.ai…'
              : updatedAt !== null
                ? `立即刷新 · 更新于 ${clock(updatedAt)} · 与官网可能差 1%`
                : '立即刷新 · 与官网可能差 1%',
            'aria-label': '刷新额度',
            onClick: (event) => {
              event.stopPropagation()
              refreshNow()
            },
          },
          '↻',
        ),
        h(
          'button',
          {
            type: 'button',
            style: S.icon,
            title: '收起（收起后不再请求）',
            'aria-label': '收起并停止请求',
            onClick: (event) => {
              event.stopPropagation()
              toggle()
            },
          },
          '×',
        ),
      )
    }

    // -----------------------------------------------------------------------
    // cordis plugin surface
    // -----------------------------------------------------------------------

    function ensureStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector('style[data-plugin="dsh-opencode-go-usage"]')
      if (existing !== null) return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-opencode-go-usage'
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        try {
          style.remove()
        } catch {}
      }
    }

    function apply(ctx) {
      const slots = ctx.slots
      if (!slots || typeof slots.inject !== 'function') return

      ctx.effect(() => ensureStyles(), 'dsh-opencode-go-usage: styles')

      const getDirectories = () => {
        try {
          const directories = ctx.get('modelDirectories')
          return directories && typeof directories.directoryFor === 'function' ? directories : undefined
        } catch {
          return undefined
        }
      }

      slots.inject('conversation.composer.dock', () =>
        slots.register(
          { name: 'conversation.composer.dock', id: 'opencode-go-usage', order: 2 },
          (props) => h(Dock, { sessionId: props ? props.sessionId : undefined, getDirectories }),
        ),
      )
    }

    return { name: 'dsh-opencode-go-usage', inject: ['slots'], apply }
  },
})
