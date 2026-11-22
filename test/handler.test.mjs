// The route itself: a plain search must answer 200 even when the corpus is
// empty, and a refused regex must carry a JSON reason. This catches broken
// wiring (a missing helper used to turn every search into an empty 400).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.mjs'
import { saveSessionDoc } from '../store.mjs'

/** One corpus entry with one user row per [time, text]. */
function entry(title, rows) {
  return {
    path: `/sessions/${title}`,
    size: 0,
    mtimeMs: 0,
    readBytes: 0,
    frames: 0,
    cwd: '/workspace',
    title,
    live: false,
    readAt: 0,
    messages: rows.map(([time, text], index) => ({ seq: index + 1, time, text, truncated: false })),
    outputs: [],
  }
}

/** Install the plugin on a mock Host with a private corpus. */
function mount(sessions = []) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fh-handler-'))
  const docs = join(root, 'cache', 'find-history', 'sessions')
  for (const [sessionId, value] of sessions) saveSessionDoc({ docs }, sessionId, value)
  const routes = []
  const disposers = []
  const ctx = {
    effect(effect) {
      const dispose = effect()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    webServer: {
      register(spec) {
        routes.push(spec)
        return () => {}
      },
    },
    connection: { authorizeIndex: () => true },
    workspaceRegistry: { list: () => [], archivedSessionIds: [] },
    get(name) {
      return name === 'dshHomePath' ? (...parts) => join(root, ...parts) : undefined
    },
    logger: { warn() {}, info() {} },
    on: () => () => {},
  }
  apply(ctx)
  assert.equal(routes.length, 1)
  return {
    handler: routes[0].handler,
    dispose() {
      for (const dispose of disposers) dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Call the route with one query string. */
async function request(handler, url) {
  const out = { status: 0, headers: {}, body: '' }
  const req = { method: 'GET', url, headers: {} }
  const res = {
    statusCode: 0,
    setHeader(key, value) {
      out.headers[key] = value
    },
    writeHead(code, headers) {
      out.status = code
      Object.assign(out.headers, headers ?? {})
    },
    end(chunk) {
      if (chunk !== undefined) out.body += String(chunk)
    },
  }
  await handler(req, res)
  if (out.status === 0) out.status = res.statusCode
  return { ...out, json: out.body === '' ? null : JSON.parse(out.body) }
}

test('a plain search answers 200 with the result contract', async () => {
  const mounted = mount()
  try {
    const answer = await request(mounted.handler, '/dsh-find-history/search?q=test&fields=input')
    assert.equal(answer.status, 200)
    assert.equal(answer.json.query, 'test')
    assert.equal(answer.json.mode, 'exact')
    assert.equal(answer.json.truncated, false)
    assert.deepEqual(answer.json.items, [])
  } finally {
    mounted.dispose()
  }
})

test('an empty query answers 200 with an empty result', async () => {
  const mounted = mount()
  try {
    const answer = await request(mounted.handler, '/dsh-find-history/search?q=&fields=input')
    assert.equal(answer.status, 200)
    assert.equal(answer.json.total, 0)
    assert.deepEqual(answer.json.items, [])
  } finally {
    mounted.dispose()
  }
})

test('a literal query may contain regex characters', async () => {
  const mounted = mount()
  try {
    const answer = await request(
      mounted.handler,
      `/dsh-find-history/search?q=${encodeURIComponent('(a+)+[')}&fields=input`,
    )
    assert.equal(answer.status, 200)
  } finally {
    mounted.dispose()
  }
})

test('an invalid regex answers 400 with a JSON reason', async () => {
  const mounted = mount()
  try {
    const answer = await request(
      mounted.handler,
      `/dsh-find-history/search?q=${encodeURIComponent('(')}&fields=input&regex=1`,
    )
    assert.equal(answer.status, 400)
    assert.equal(answer.json.error, 'invalid-regex')
  } finally {
    mounted.dispose()
  }
})

test('a query over 300 characters is truncated and flagged', async () => {
  const mounted = mount()
  try {
    const query = 'x'.repeat(301)
    const answer = await request(
      mounted.handler,
      `/dsh-find-history/search?q=${query}&fields=input`,
    )
    assert.equal(answer.status, 200)
    assert.equal(answer.json.query.length, 300)
    assert.equal(answer.json.truncated, true)
  } finally {
    mounted.dispose()
  }
})

test('a populated corpus answers with focus and both orders', async () => {
  const mounted = mount([
    ['new', entry('New', [[5000, 'alpha 历史搜索 工具']])],
    ['old', entry('Old', [[1000, 'alpha 历史搜索 工具 历史搜索 历史搜索']])],
    ['chatty', entry('Chatty', [[2000, '历史搜索 first'], [2500, '历史搜索 second']])],
    ['relaxed', entry('Relaxed', [[4000, '这次部署，有改动才亮']])],
  ])
  try {
    const byTime = await request(
      mounted.handler,
      `/dsh-find-history/search?q=${encodeURIComponent('历史搜索')}&fields=input&sort=time`,
    )
    assert.equal(byTime.status, 200)
    assert.deepEqual(
      byTime.json.items.map((item) => item.sessionId),
      ['new', 'chatty', 'old'],
    )
    assert.equal(byTime.json.items[0].focus, '历史搜索')

    const byRelevance = await request(
      mounted.handler,
      `/dsh-find-history/search?q=${encodeURIComponent('历史搜索')}&fields=input&sort=relevance`,
    )
    assert.deepEqual(
      byRelevance.json.items.map((item) => item.sessionId),
      ['old', 'chatty', 'new'],
    )

    const grouped = await request(
      mounted.handler,
      `/dsh-find-history/search?q=${encodeURIComponent('历史搜索')}&fields=input&group=1`,
    )
    const chatty = grouped.json.items.find((item) => item.sessionId === 'chatty')
    assert.equal(chatty.totalHits, 2)
    assert.equal(chatty.hits.length, 2)
    assert.equal(chatty.hits[0].focus, '历史搜索')
  } finally {
    mounted.dispose()
  }
})

test('no exact hit answers as approximate with coverage', async () => {
  const mounted = mount([['relaxed', entry('Relaxed', [[4000, '这次部署，有改动才亮']])]])
  try {
    const answer = await request(
      mounted.handler,
      `/dsh-find-history/search?q=${encodeURIComponent('这次改动')}&fields=input`,
    )
    assert.equal(answer.status, 200)
    assert.equal(answer.json.mode, 'approximate')
    assert.equal(answer.json.total, 1)
    assert.ok(answer.json.items[0].coverage > 0.6)
    assert.ok(answer.json.items[0].focus.length >= 2)
  } finally {
    mounted.dispose()
  }
})
