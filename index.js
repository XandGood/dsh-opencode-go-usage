/**
 * dsh-opencode-go-usage — Host half.
 *
 * Reads the OpenCode Go subscription quota (rolling 5h / week / month) with the
 * API key the Harness already stores for the `opencode-go` provider, then serves
 * the normalized result to this package's browser half over one same-origin,
 * authenticated GET route.
 *
 * Security posture:
 * - The key is resolved per request from `ctx.credentials` and used for exactly
 *   one upstream GET. It is never logged, never cached, never returned.
 * - The upstream URL is fixed; the browser can only pass `refresh=1`.
 * - The route is GET-only, same-origin, and gated by the Harness connection
 *   trust checks when that service is available.
 */

export const name = 'dsh-opencode-go-usage'

const ROUTE_PATH = '/dsh-opencode-go-usage/api/usage'

const DEFAULT_PROVIDER = {
  id: 'opencode-go',
  apiKeyRef: 'OPENCODE_GO_API_KEY',
  usageUrl: 'https://opencode.ai/zen/go/v1/usage',
}

const DEFAULTS = {
  /** How long one successful quota answer is reused, in milliseconds. */
  cacheMs: 60_000,
  /** Upstream request timeout, in milliseconds. */
  timeoutMs: 20_000,
  /** Hard cap on the upstream response body, in bytes. */
  maxBytes: 64 * 1024,
}

const WINDOW_KEYS = ['rolling', 'weekly', 'monthly']

/**
 * Mount the Host half: one exact Web route under the Harness Web carrier.
 * @param ctx Host Cordis context.
 * @param config Optional row config: { provider?, cacheMs?, timeoutMs? }.
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const cache = { at: 0, payload: null, providerId: cfg.provider.id }

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const dispose = scope.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (req, res) => handleRequest(ctx, cfg, cache, req, res),
      })
      return () => {
        try {
          dispose()
        } catch {}
      }
    }, 'dsh-opencode-go-usage: usage route')
  })

  try {
    ctx.logger?.info?.(`[dsh-opencode-go-usage] mounted ${ROUTE_PATH}`)
  } catch {}
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const provider = { ...DEFAULT_PROVIDER, ...(raw.provider && typeof raw.provider === 'object' ? raw.provider : {}) }
  const positive = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    provider: {
      id: String(provider.id ?? DEFAULT_PROVIDER.id),
      apiKeyRef: String(provider.apiKeyRef ?? DEFAULT_PROVIDER.apiKeyRef),
      usageUrl: String(provider.usageUrl ?? DEFAULT_PROVIDER.usageUrl),
    },
    cacheMs: positive(raw.cacheMs, DEFAULTS.cacheMs),
    timeoutMs: positive(raw.timeoutMs, DEFAULTS.timeoutMs),
    maxBytes: positive(raw.maxBytes, DEFAULTS.maxBytes),
  }
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

async function handleRequest(ctx, cfg, cache, req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, failure('METHOD', '只支持 GET'))
  }

  const rejection = trustRejection(ctx, req)
  if (rejection !== undefined) {
    return sendJson(res, rejection, failure('FORBIDDEN', '请求来源不受信任'))
  }

  let url
  try {
    const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost'
    url = new URL(typeof req.url === 'string' && req.url.length > 0 ? req.url : ROUTE_PATH, `http://${host}`)
  } catch {
    return sendJson(res, 400, failure('BAD_REQUEST', '请求无效'))
  }

  const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') ?? '').toLowerCase())
  const now = Date.now()

  if (!refresh && cache.payload !== null && now - cache.at < cfg.cacheMs && cache.providerId === cfg.provider.id) {
    return sendJson(res, 200, { ...cache.payload, cached: true })
  }

  let result
  try {
    result = await queryUsage(ctx, cfg)
  } catch (error) {
    result = failureFrom(error)
  }

  if (result.ok === true) {
    cache.at = now
    cache.payload = result
    cache.providerId = cfg.provider.id
  }

  return sendJson(res, 200, result)
}

/**
 * Apply the Harness connection trust checks to this ordinary Web route.
 * Absent connection service (headless compositions) leaves the route open on
 * the carrier, which the Web carrier itself already binds to loopback.
 */
function trustRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (!connection || typeof connection.requestRejection !== 'function') return undefined
  try {
    return connection.requestRejection({ headers: req.headers })
  } catch {
    return undefined
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  } catch {}
}

// ---------------------------------------------------------------------------
// quota query
// ---------------------------------------------------------------------------

async function queryUsage(ctx, cfg) {
  const key = await resolveApiKey(ctx, cfg.provider.apiKeyRef)
  if (key === undefined) {
    return failure('NOT_CONFIGURED', `未配置 ${cfg.provider.apiKeyRef}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  let response
  try {
    response = await fetch(cfg.provider.usageUrl, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        'user-agent': 'dsh-opencode-go-usage/0.1',
      },
      redirect: 'manual',
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return failure('TIMEOUT', '请求 opencode.ai 超时')
    }
    return failure('NETWORK', '无法连接 opencode.ai')
  } finally {
    clearTimeout(timer)
  }

  if (response.status >= 300 && response.status < 400) {
    return failure('UPSTREAM', `opencode.ai 返回重定向 (${response.status})`)
  }
  if (response.status === 401 || response.status === 403) {
    return failure('AUTH', 'key 无效，或该账号没有 OpenCode Go 订阅')
  }
  if (response.status === 429) {
    return failure('RATE_LIMIT', 'opencode.ai 限流，请稍后再试')
  }
  if (!response.ok) {
    return failure('UPSTREAM', `opencode.ai 返回 HTTP ${response.status}`)
  }

  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cfg.maxBytes) {
    return failure('SHAPE', 'opencode.ai 响应过大')
  }

  let text
  try {
    text = await response.text()
  } catch {
    return failure('NETWORK', '读取 opencode.ai 响应失败')
  }
  if (text.length > cfg.maxBytes) {
    return failure('SHAPE', 'opencode.ai 响应过大')
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return failure('SHAPE', 'opencode.ai 返回的不是 JSON')
  }

  const usage = normalizeUsage(payload)
  if (usage === null) {
    return failure('SHAPE', 'opencode.ai 额度响应无法识别（接口可能已变更）')
  }

  return {
    ok: true,
    provider: cfg.provider.id,
    keySource: cfg.provider.apiKeyRef,
    fetchedAt: Date.now(),
    usage,
  }
}

/**
 * Resolve the API key. Resolution is per request: a key replaced in Settings
 * reaches the next call without a restart. Nothing is cached here.
 */
async function resolveApiKey(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(ref)
      const value = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
      if (value.length > 0) return value
    } catch {}
  }
  const ambient = typeof process.env[ref] === 'string' ? process.env[ref].trim() : ''
  return ambient.length > 0 ? ambient : undefined
}

/** Keep only the three known windows and their numeric fields. */
function normalizeUsage(payload) {
  const usage = payload && typeof payload === 'object' ? payload.usage : undefined
  if (!usage || typeof usage !== 'object') return null

  const out = {}
  for (const id of WINDOW_KEYS) {
    const window = usage[id]
    if (!window || typeof window !== 'object') continue
    const percent = Number(window.percent)
    if (!Number.isFinite(percent)) continue
    out[id] = {
      percent: Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10,
      status: typeof window.status === 'string' ? window.status : 'unknown',
      resetsAt: typeof window.resetsAt === 'string' && window.resetsAt.length > 0 ? window.resetsAt : null,
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

// ---------------------------------------------------------------------------
// failures
// ---------------------------------------------------------------------------

function failure(code, message) {
  return { ok: false, error: { code, message } }
}

function failureFrom(error) {
  const message = error instanceof Error ? error.message : String(error)
  // Never leak key material even if an unexpected error string carried it.
  const redacted = message.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
  return failure('INTERNAL', redacted)
}
