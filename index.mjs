/**
 * dsh-session-history-search — host half.
 *
 * Serves one authenticated JSON route for the sidebar search icon: it answers
 * which Sessions of any Workspace contain the keywords the user typed, with the
 * matching excerpt, the Session title, the owning Workspace and the archival
 * state. That is what the Client needs to hand a half-forgotten conversation
 * back to its owner.
 *
 * A Harness Session records harness context (time, runtime, skill catalogue,
 * reminders) as `user/message` events too, so the Session log cannot be searched
 * by role alone. The route therefore keeps its own corpus of the messages whose
 * source is the user, and searches that text itself: substring matching is also
 * what Chinese keywords need, because the engine's FTS5 tokenizer only matches
 * at token boundaries.
 *
 * The corpus is one small document per Session. A document records the size and
 * modification time the log had when it was read, so a start only reads what
 * appeared or grew: a warm start is a directory listing plus a few file reads,
 * and a Session that only gained events is read from the byte offset already
 * covered. Logs the corpus has never seen are read by short-lived child
 * processes in batches, newest first, so the history does not have to be built
 * before the first answer and the memory a full pass leaves behind is handed
 * back as each batch exits.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  MAX_MESSAGE_CHARS,
  mergeMessages,
  mergeOutputs,
  readAssistantText,
  readLogTail,
  readMessageText,
} from './scan.mjs'
import {
  indexPaths,
  listLogRecords,
  loadCorpus,
  readSessionDoc,
  removeSessionDoc,
  saveSessionDoc,
} from './store.mjs'

export const name = 'session-history-search'

export const inject = ['webServer', 'connection', 'workspaceRegistry']

/** Prefix some Harness versions write in front of a Session id. */
const SESSION_PREFIX = 'session-'
/** Exact pathname of the route the Client half queries. */
const ROUTE_PATH = '/dsh-session-history-search/search'
/** Short-lived process that reads unseen Session logs, written next to this file. */
const BACKFILL_SCRIPT = fileURLToPath(new URL('./backfill.mjs', import.meta.url))
/** Sessions answered when the caller names no limit. */
const DEFAULT_LIMIT = 24
/** Upper bound for one answer; the list is scanned quickly and need not page. */
const MAX_LIMIT = 60
/** Text pools a query reads: the user's own words, the answers that close turns. */
const DEFAULT_FIELDS = Object.freeze({ inputs: true, outputs: false })

/** Longest accepted query, in characters. */
const MAX_QUERY_CHARS = 300
/** Distinct keywords matched separately; more would only add noise and cost. */
const MAX_TOKENS = 6
/** Repeat queries are common while a user edits keywords; answers are cheap to reuse. */
const CACHE_TTL_MS = 20_000
/** Answers kept for reuse, oldest evicted first. */
const CACHE_MAX = 40
/** Background walks wait for startup work to settle first. */
const SWEEP_START_DELAY_MS = 300
/** A Session that opens or appends outside the rhythm wakes the walk soon after. */
const SWEEP_DEBOUNCE_MS = 1_000
/** Period of the background safety walk over the Session logs. */
const SWEEP_INTERVAL_MS = 5 * 60_000
/** Documents are written in batches; a search burst must not rewrite them per hit. */
const SAVE_DELAY_MS = 1_000
/** Unseen logs read at once: two child processes, as many as the work deserves. */
const BACKFILL_WORKERS = 2
/** Compressed bytes handed to one child, so its memory stays bounded. */
const BACKFILL_BATCH_BYTES = 12 * 1024 * 1024
/** Excerpt length around the first keyword, and the text kept before it. */
const EXCERPT_CHARS = 160
/** Characters kept at each end of a hover preview. */
const PREVIEW_CHARS = 100
const EXCERPT_LEAD = 24

/** Corpus: Session id → { path, size, mtimeMs, readBytes, frames, cwd, title, live, readAt, messages }. */
const corpus = new Map()
/** Session ids the Host has open right now, whose events arrive one by one. */
const liveSessions = new Set()
/** Session ids queued for, or inside, a backfill batch. */
const pending = new Set()
/** Session ids whose document is out of date. */
const dirty = new Set()
/** Logs waiting for a backfill child, newest first. */
let backfillQueue = []
/** Child processes currently reading a batch. */
let backfillRunning = 0
/** Set when the plugin is disposed while a walk or a batch is in flight. */
let stopped = false
/** Directories this plugin reads and writes; null when the profile has no cache. */
let paths = null
/** Pending debounced write of dirty documents. */
let saveTimer = null
/** Guards one walk at a time. */
let sweeping = false
/** Pending debounced walk. */
let sweepDebounce = null
/** Host context kept for the background walk. */
let pluginCtx = null
/** Timers owned by this plugin. */
const timers = new Set()
/** Answers of recent queries, so a paused keystroke is not paid for twice. */
const answerCache = new Map()

/**
 * Read the requested page size.
 * @param {URLSearchParams} params - request parameters.
 * @returns {number} Sessions to answer with.
 */
function readLimit(params) {
  const parsed = Number(params.get('limit') ?? '')
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT
  const limit = Math.trunc(parsed)
  if (limit < 1) return DEFAULT_LIMIT
  return Math.min(limit, MAX_LIMIT)
}

/**
 * Read and normalize the query text.
 * @param {URLSearchParams} params - request parameters.
 * @returns {string} trimmed query, capped at {@link MAX_QUERY_CHARS}.
 */
function readQuery(params) {
  const raw = params.get('q') ?? ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS)
}

/**
 * Read which text pools one request searches.
 * @param {URLSearchParams} params - request parameters.
 * @returns {{ inputs: boolean, outputs: boolean }} pools to search.
 */
function readFields(params) {
  const raw = params.get('fields')
  if (raw === null) return DEFAULT_FIELDS
  const wanted = new Set(raw.split(','))
  const inputs = wanted.has('input')
  const outputs = wanted.has('output')
  return inputs || outputs ? { inputs, outputs } : DEFAULT_FIELDS
}

/**
 * Read the matching switches one request asks for.
 * @param {URLSearchParams} params - request parameters.
 * @returns {{ caseSensitive: boolean, whole: boolean, regex: boolean }} matcher flags.
 */
function readMatchOptions(params) {
  return {
    caseSensitive: params.get('case') === '1',
    whole: params.get('whole') === '1',
    regex: params.get('regex') === '1',
  }
}

/**
 * Read one epoch-millisecond bound.
 * @param {URLSearchParams} params - request parameters.
 * @param {string} name - parameter name.
 * @returns {number | null} bound, or null when the request carries none.
 */
function readBound(params, name) {
  const raw = Number(params.get(name) ?? '')
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null
}

/**
 * Workspace ids a request restricts itself to; repeated or comma separated.
 * @param {URLSearchParams} params - request query.
 * @returns {Set<string>} selected Workspace ids.
 */
function readWorkspaces(params) {
  const ids = new Set()
  for (const value of params.getAll('ws')) {
    for (const part of value.split(',')) {
      const id = part.trim()
      if (id !== '') ids.add(id)
    }
  }
  return ids
}

/**
 * Read the order one request asks for: newest hit first, or the Session that
 * mentions the keywords most often first.
 * @param {URLSearchParams} params - request parameters.
 * @returns {'time' | 'relevance'} the requested order.
 */
function readSort(params) {
  return params.get('sort') === 'relevance' ? 'relevance' : 'time'
}

/**
 * Read the page offset one request asks for.
 * @param {URLSearchParams} params - request parameters.
 * @returns {number} rows to skip.
 */
function readOffset(params) {
  const raw = Number(params.get('offset') ?? '')
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(Math.trunc(raw), 1000)
}

/**
 * Split a query into the keywords matched one by one.
 * @param {string} query - normalized query.
 * @returns {string[]} distinct lowercased keywords.
 */
function splitTokens(query) {
  const tokens = []
  for (const part of query.toLowerCase().split(' ')) {
    if (part === '') continue
    if (tokens.includes(part)) continue
    tokens.push(part)
    if (tokens.length >= MAX_TOKENS) break
  }
  return tokens
}

/** Characters that count as part of a word for whole-word matching. */
const WORD_CHAR = /[a-z0-9_\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/i

/**
 * Tell whether one character at an index continues a word.
 * @param {string} text - haystack.
 * @param {number} index - position to inspect.
 * @returns {boolean} true when the position holds a word character.
 */
function isWordCharAt(text, index) {
  if (index < 0 || index >= text.length) return false
  return WORD_CHAR.test(text.charAt(index))
}

/**
 * Find the first standalone occurrence of one keyword.
 * @param {string} text - haystack, already case-folded when needed.
 * @param {string} term - keyword.
 * @returns {number} index, or -1 when no standalone occurrence exists.
 */
function findWhole(text, term) {
  let from = 0
  for (;;) {
    const at = text.indexOf(term, from)
    if (at === -1) return -1
    if (!isWordCharAt(text, at - 1) && !isWordCharAt(text, at + term.length)) return at
    from = at + 1
  }
}

/** Characters that make up Chinese text, for the chunking fallback. */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u

/**
 * Split one long keyword into chunks worth retrying when it matched nothing:
 * Chinese has no word boundaries, so 「炒股界面」 is retried as 「炒股 界面」;
 * mixed Chinese and Latin text is split where the script changes.
 * @param {string} token - one keyword from the query.
 * @returns {string[] | null} chunks to retry with, or null when there is nothing to split.
 */
function chunkKeywords(token) {
  const chars = [...token]
  if (chars.length < 4) return null
  if (chars.every((char) => CJK_CHAR.test(char))) {
    const chunks = []
    for (let index = 0; index + 1 < chars.length; index += 2) {
      chunks.push(chars[index] + chars[index + 1])
    }
    return chunks.length >= 2 ? chunks.slice(0, MAX_TOKENS) : null
  }
  const runs = token.match(/[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/giu) ?? []
  return runs.length >= 2 ? runs.slice(0, MAX_TOKENS) : null
}

/**
 * Compile one query into the matching primitives the search needs: how many
 * keywords a text contains, where the first one starts, and whether the whole
 * phrase appears.
 * @param {string} query - normalized query.
 * @param {{ caseSensitive: boolean, whole: boolean, regex: boolean }} options - matcher flags.
 * @returns {object | null} matcher, or null when a regex does not compile.
 */
function buildMatcher(query, options) {
  if (options.regex === true) {
    let expression
    try {
      expression = new RegExp(query, options.caseSensitive ? 'u' : 'iu')
    } catch {
      return null
    }
    const find = (text) => {
      expression.lastIndex = 0
      const found = expression.exec(text)
      return found === null ? -1 : found.index
    }
    const locate = (text) => {
      expression.lastIndex = 0
      const found = expression.exec(text)
      return found === null ? { index: -1, length: 0 } : { index: found.index, length: found[0].length }
    }
    return {
      regex: true,
      terms: [query],
      find,
      locate,
      count: (text) => (find(text) === -1 ? 0 : 1),
      phrase: (text) => find(text) !== -1,
    }
  }
  const whole = options.whole === true
  const fold = (text) => (options.caseSensitive ? text : text.toLowerCase())
  const terms = query
    .split(' ')
    .filter((part) => part !== '')
    .map((part) => fold(part))
  const phraseText = fold(query)
  const locate = (text, term) => (whole ? findWhole(text, term) : text.indexOf(term))
  return {
    regex: false,
    terms,
    locate: (text) => {
      const body = fold(text)
      let best = { index: -1, length: 0 }
      for (const term of terms) {
        const here = locate(body, term)
        if (here !== -1 && (best.index === -1 || here < best.index)) best = { index: here, length: term.length }
      }
      return best
    },
    find: (text) => {
      const body = fold(text)
      let first = -1
      for (const term of terms) {
        const here = locate(body, term)
        if (here !== -1 && (first === -1 || here < first)) first = here
      }
      return first
    },
    count: (text) => {
      const body = fold(text)
      let matched = 0
      for (const term of terms) if (locate(body, term) !== -1) matched += 1
      return matched
    },
    phrase: (text) => {
      const body = fold(text)
      if (terms.length === 1) return locate(body, terms[0]) !== -1
      if (whole) {
        let matched = 0
        for (const term of terms) if (locate(body, term) !== -1) matched += 1
        return matched === terms.length
      }
      return body.includes(phraseText)
    },
  }
}

/**
 * Build the excerpt shown for one matching message: a window around the first
 * keyword, so the row shows why it matched.
 * @param {string} text - full message text.
 * @param {number} index - where the first keyword starts, or -1.
 * @param {string[]} tokens - lowercased keywords used for highlighting.
 * @returns {string} collapsed one-line excerpt.
 */
function makeExcerpt(text, index, tokens) {
  let at = index
  if (at === -1 && tokens.length > 0) {
    const lower = text.toLowerCase()
    for (const token of tokens) {
      const here = lower.indexOf(token)
      if (here !== -1 && (at === -1 || here < at)) at = here
    }
  }
  const start = at <= EXCERPT_LEAD || at === -1 ? 0 : at - EXCERPT_LEAD
  const end = Math.min(text.length, start + EXCERPT_CHARS)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  return `${head}${body}${tail}`
}

/**
 * Window of a message centred on the matched keywords, for the hover preview:
 * roughly {@link PREVIEW_CHARS} characters either side, with the hit itself
 * kept in the middle so the reader sees why the row matched.
 * @param {string} text - full message text.
 * @param {number} index - where the first keyword starts, or -1.
 * @param {number} length - how many characters that keyword spans.
 * @returns {{ head: string, match: string, tail: string }} collapsed window.
 */
function messagePreview(text, index, length) {
  const collapse = (part) => part.replace(/\s+/gu, ' ')
  if (index < 0) {
    const body = collapse(text).trim()
    if (body.length <= PREVIEW_CHARS * 2) return { head: body, match: '', tail: '' }
    return { head: body.slice(0, PREVIEW_CHARS), match: '', tail: body.slice(-PREVIEW_CHARS) }
  }
  const span = Math.max(length, 1)
  const start = Math.max(0, index - PREVIEW_CHARS)
  const end = Math.min(text.length, index + span + PREVIEW_CHARS)
  return {
    head: `${start > 0 ? '…' : ''}${collapse(text.slice(start, index)).trimStart()}`,
    match: collapse(text.slice(index, index + span)),
    tail: `${collapse(text.slice(index + span, end)).trimEnd()}${end < text.length ? '…' : ''}`,
  }
}

/** Hits kept per Session when the Client asks for grouped rows. */
const MAX_GROUP_HITS = 6

/**
 * Order hits inside one Session: more keywords, then the phrase, then the
 * user's own words, then the newest.
 * @param {object} left - hit.
 * @param {object} right - hit.
 * @returns {number} sort order.
 */
function compareHits(left, right) {
  if (left.matched !== right.matched) return right.matched - left.matched
  if (left.exact !== right.exact) return left.exact ? -1 : 1
  if (left.kind !== right.kind) return left.kind === 'input' ? -1 : 1
  return right.message.time - left.message.time
}

/**
 * Collect the matching rows of one Session.
 * @param {object} entry - corpus entry.
 * @param {object} matcher - compiled matcher.
 * @param {{ inputs: boolean, outputs: boolean }} fields - pools to search.
 * @returns {object[]} hits, best first.
 */
function collectHits(entry, matcher, fields) {
  const hits = []
  const scan = (rows, kind) => {
    for (const row of rows) {
      const matched = matcher.count(row.text)
      if (matched === 0) continue
      hits.push({ message: row, kind, matched, exact: matcher.phrase(row.text) })
    }
  }
  if (fields.inputs === true) scan(entry.messages, 'input')
  if (fields.outputs === true) scan(entry.outputs ?? [], 'output')
  hits.sort(compareHits)
  return hits.slice(0, MAX_GROUP_HITS)
}

/**
 * How strongly one Session matches: the text it keeps repeating the keywords
 * in, with an extra point for the whole phrase.
 * @param {object} session - matched Session.
 * @returns {number} relevance score.
 */
function relevanceOf(session) {
  let score = 0
  for (const hit of session.hits) score += hit.matched + (hit.exact ? 1 : 0)
  return score
}

/**
 * Order Sessions: more keywords, then the phrase, then the user's own words,
 * then the newest hit. With `relevance` the most mentions come first.
 * @param {object[]} sessions - sessions to order in place.
 * @param {'time' | 'relevance'} sort - requested order.
 * @returns {object[]} the same list.
 */
function rankSessions(sessions, sort = 'time') {
  sessions.sort((left, right) => {
    if (sort === 'time') {
      const leftTime = left.best.message.time
      const rightTime = right.best.message.time
      if (leftTime !== rightTime) return rightTime - leftTime
      return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
    }
    if (sort === 'relevance') {
      const leftScore = relevanceOf(left)
      const rightScore = relevanceOf(right)
      if (leftScore !== rightScore) return rightScore - leftScore
    }
    if (left.best.matched !== right.best.matched) return right.best.matched - left.best.matched
    if (left.best.exact !== right.best.exact) return left.best.exact ? -1 : 1
    if (left.best.kind !== right.best.kind) return left.best.kind === 'input' ? -1 : 1
    if (left.best.message.time !== right.best.message.time) {
      return right.best.message.time - left.best.message.time
    }
    return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
  })
  return sessions
}

/** Empty id set, used when no archived Session has to be skipped. */
const EMPTY_SET = new Set()

/**
 * Compare Session ids without the `session-` prefix: logs written by different
 * Harness versions carry the id both with and without it.
 * @param {string} id - Session id from the index or the Workspace registry.
 * @returns {string} the id without its prefix.
 */
function sessionKey(id) {
  return id.startsWith(SESSION_PREFIX) ? id.slice(SESSION_PREFIX.length) : id
}

/**
 * Collect the archived Session ids in the form the index keys them.
 * @param ctx - Host context.
 * @returns {Set<string>} prefixed and bare archived ids.
 */
function archivedSessionIds(ctx) {
  const ids = new Set()
  for (const id of ctx.workspaceRegistry.archivedSessionIds) {
    if (typeof id !== 'string') continue
    ids.add(id)
    ids.add(sessionKey(id))
  }
  return ids
}

/**
 * Search the corpus for Sessions containing the keywords.
 * @param {object} matcher - compiled matcher.
 * @param {string[]} tokens - lowercased keywords, kept for highlighting.
 * @param {ReadonlySet<string>} skip - Session ids left out of the search entirely.
 * @param {{ inputs: boolean, outputs: boolean }} fields - pools to search.
 * @param {{ accept?: (entry: object) => boolean, since?: number | null, until?: number | null, sort?: 'time' | 'relevance' }} filter - Session, time, and order filters.
 * @returns {object[]} matching Sessions, best first.
 */
function searchCorpus(matcher, tokens, skip, fields, filter = {}) {
  const accept = typeof filter.accept === 'function' ? filter.accept : null
  const sort = filter.sort === 'relevance' ? 'relevance' : 'time'
  const since = Number.isFinite(filter.since) ? filter.since : null
  const until = Number.isFinite(filter.until) ? filter.until : null
  const inTime = (time) => {
    if (!Number.isFinite(time)) return since === null && until === null
    if (since !== null && time < since) return false
    if (until !== null && time > until) return false
    return true
  }
  const full = []
  const partial = []
  const all = matcher.terms.length
  for (const [sessionId, entry] of corpus) {
    if (skip.has(sessionId) || skip.has(sessionKey(sessionId))) continue
    if (accept !== null && !accept(entry)) continue
    const hits = collectHits(entry, matcher, fields).filter((hit) => inTime(hit.message.time))
    if (hits.length === 0) continue
    const session = { sessionId, entry, hits, best: hits[0] }
    if (hits[0].matched >= all) full.push(session)
    else partial.push(session)
  }
  if (sort === 'time') return rankSessions(full.concat(partial), 'time')
  rankSessions(full, sort)
  rankSessions(partial, sort)
  return full.concat(partial)
}

/**
 * Resolve the Workspace that owns a Session directory, most specific path
 * first so a Session started in a subdirectory keeps its Workspace.
 * @param {object[]} workspaces - Workspaces ordered by descending path length.
 * @param {string | null} cwd - recorded Session working directory.
 * @returns {object | null} owning Workspace.
 */
function locateWorkspace(workspaces, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null
  for (const workspace of workspaces) {
    const root = workspace.path
    if (typeof root !== 'string' || root === '') continue
    if (cwd === root) return workspace
    if (cwd.startsWith(root.endsWith('/') ? root : `${root}/`)) return workspace
  }
  return null
}

/**
 * Describe one matching message for the Client.
 * @param {object} hit - hit from {@link collectHits}.
 * @param {object} matcher - compiled matcher.
 * @param {string[]} tokens - lowercased keywords, used for highlighting.
 * @returns {object} row fields shared by both layouts.
 */
function describeHit(hit, matcher, tokens) {
  const spot = matcher.locate(hit.message.text)
  const preview = messagePreview(hit.message.text, spot.index, spot.length)
  return {
    snippet: makeExcerpt(hit.message.text, spot.index, tokens),
    head: preview.head,
    match: preview.match,
    tail: preview.tail,
    time: hit.message.time,
    seq: hit.message.seq,
    kind: hit.kind,
    matchedTokens: hit.matched,
    // One keyword is its own phrase, so the badge only means something for
    // queries the user wrote as several words.
    phrase: matcher.chunked !== true && hit.exact && matcher.terms.length > 1,
  }
}

/**
 * List the known Workspaces, for the Client's scope selector.
 * @param ctx - Host context.
 * @returns {object[]} Workspaces with a display title.
 */
function listWorkspaces(ctx) {
  return ctx.workspaceRegistry.list().map((workspace) => ({
    id: workspace.id,
    title: workspace.title || workspace.path.split('/').pop() || workspace.path,
    path: workspace.path,
  }))
}

/**
 * Describe the matching Sessions for the Client.
 * @param ctx - Host context.
 * @param {object[]} sessions - matching Sessions from {@link searchCorpus}.
 * @param {object} matcher - compiled matcher.
 * @param {string[]} tokens - lowercased keywords.
 * @param {boolean} group - whether to keep every hit of a Session.
 * @returns {object[]} rows for the Client.
 */
function describeMatches(ctx, sessions, matcher, tokens, group) {
  const workspaces = [...ctx.workspaceRegistry.list()].sort(
    (left, right) => right.path.length - left.path.length,
  )
  return sessions.map((session) => {
    const workspace = locateWorkspace(workspaces, session.entry.cwd)
    const item = {
      sessionId: session.sessionId,
      title: typeof session.entry.title === 'string' ? session.entry.title : null,
      cwd: session.entry.cwd,
      workspaceId: workspace === null ? null : workspace.id,
      workspaceTitle:
        workspace === null ? null : workspace.title || workspace.path.split('/').pop() || null,
    }
    if (group === true) {
      return {
        ...item,
        matchedTokens: session.best.matched,
        phrase: session.best.exact,
        count: session.hits.length,
        hits: session.hits.map((hit) => describeHit(hit, matcher, tokens)),
      }
    }
    return { ...item, ...describeHit(session.best, matcher, tokens) }
  })
}

/**
 * Write one JSON response.
 * @param res - response owned by this handler.
 * @param {number} status - HTTP status code.
 * @param {object} body - JSON-serializable payload.
 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Read a cached answer.
 * @param {string} key - cache key.
 * @param {number} ttl - age after which the entry is dropped.
 * @returns {object | undefined} cached payload, or undefined when absent or stale.
 */
function readCached(key, ttl) {
  const entry = answerCache.get(key)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > ttl) {
    answerCache.delete(key)
    return undefined
  }
  return entry.payload
}

/**
 * Store one answer, evicting the oldest entry past the cap.
 * @param {string} key - cache key.
 * @param {object} payload - answer to keep.
 */
function writeCached(key, payload) {
  answerCache.set(key, { at: Date.now(), payload })
  while (answerCache.size > CACHE_MAX) {
    const oldest = answerCache.keys().next()
    if (oldest.done === true) break
    answerCache.delete(oldest.value)
  }
}

/**
 * Answer one search request.
 * @param ctx - Host context.
 * @param req - incoming request.
 * @param res - response owned by this handler once authorized.
 */
async function handleSearch(ctx, req, res) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET')
    res.statusCode = 405
    res.end()
    return
  }
  const workspaces = listWorkspaces(ctx)
  if (!ctx.connection.authorizeIndex(req, res)) return
  const url = new URL(req.url ?? ROUTE_PATH, 'http://dsh.invalid')
  const params = url.searchParams
  const query = readQuery(params)
  const limit = readLimit(params)
  const offset = readOffset(params)
  const fields = readFields(params)
  const options = readMatchOptions(params)
  const since = readBound(params, 'since')
  const until = readBound(params, 'until')
  const workspaceIds = readWorkspaces(params)
  const group = params.get('group') === '1'
  const sort = readSort(params)
  if (query === '') {
    sendJson(res, 200, {
      query,
      tokens: [],
      limit,
      offset,
      total: 0,
      matched: 0,
      pending: pending.size,
      group,
      workspaces,
      items: [],
    })
    return
  }
  let matcher = buildMatcher(query, options)
  if (matcher === null) {
    sendJson(res, 400, { error: 'invalid-regex', message: 'invalid regular expression' })
    return
  }
  const cacheKey = [
    limit,
    offset,
    query,
    fields.inputs ? 1 : 0,
    fields.outputs ? 1 : 0,
    options.caseSensitive ? 1 : 0,
    options.whole ? 1 : 0,
    options.regex ? 1 : 0,
    since === null ? '' : since,
    until === null ? '' : until,
    [...workspaceIds].sort().join(','),
    group ? 1 : 0,
    sort,
  ].join('\u0000')
  const cached = readCached(cacheKey, CACHE_TTL_MS)
  if (cached !== undefined) {
    sendJson(res, 200, { ...cached, pending: pending.size })
    return
  }
  let tokens = splitTokens(query)
  const skip = archivedSessionIds(ctx)
  const scope = workspaceIds.size === 0 ? null : workspaceIds
  // Resolve each Session's Workspace once per request; the selector is cheap
  // and keeps the filter consistent with the rows the Client already shows.
  const ordered = [...ctx.workspaceRegistry.list()].sort(
    (left, right) => right.path.length - left.path.length,
  )
  const filter = {
    since,
    until,
    sort,
    accept:
      scope === null
        ? undefined
        : (entry) => {
            const workspace = locateWorkspace(ordered, entry.cwd)
            return workspace !== null && scope.has(workspace.id)
          },
  }
  try {
    let sessions = searchCorpus(matcher, tokens, skip, fields, filter)
    if (sessions.length === 0 && tokens.length === 1 && options.regex === false && options.whole === false) {
      // 「炒股界面」 has no space, so the substring misses a message that says
      // 「炒股交易界面」; retry with its two-character chunks before giving up.
      const chips = chunkKeywords(tokens[0])
      if (chips !== null) {
        const chunked = buildMatcher(chips.join(' '), options)
        if (chunked !== null) {
          // A guessed split only counts when one message carries every chunk:
          // a single common chunk would answer for the whole query.
          chunked.chunked = true
          matcher = chunked
          tokens = chips
          sessions = searchCorpus(chunked, tokens, skip, fields, filter).filter(
            (session) => session.best.matched === chips.length,
          )
        }
      }
    }
    const total = sessions.length
    const page = sessions.slice(offset, offset + limit)
    const items = describeMatches(ctx, page, matcher, tokens, group)
    const payload = {
      query,
      tokens,
      limit,
      offset,
      total,
      matched: items.length,
      pending: pending.size,
      group,
      workspaces,
      items,
    }
    writeCached(cacheKey, payload)
    sendJson(res, 200, payload)
  } catch (error) {
    ctx.logger?.warn?.(
      `[session-history-search] search failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    sendJson(res, 500, { error: 'search-failed' })
  }
}

/**
 * Read the working directory recorded in a live Session's header.
 * @param {object} session - live Session.
 * @returns {string | null} cwd, or null when the header carries none.
 */
function readSessionCwd(session) {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' ? cwd : null
}

/**
 * Mark one Session document out of date.
 * @param {string} sessionId - Session id.
 */
function markDirty(sessionId) {
  dirty.add(sessionId)
  if (saveTimer !== null) return
  const timer = setTimeout(() => {
    timers.delete(timer)
    saveTimer = null
    flushDirty()
  }, SAVE_DELAY_MS)
  timer.unref?.()
  timers.add(timer)
  saveTimer = timer
}

/**
 * Write every out-of-date Session document now.
 */
function flushDirty() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (paths === null) return
  for (const sessionId of dirty) {
    const entry = corpus.get(sessionId)
    if (entry === undefined) {
      removeSessionDoc(paths, sessionId)
      continue
    }
    saveSessionDoc(paths, sessionId, entry)
  }
  dirty.clear()
}

/**
 * Move the answer held for the finished turn into the entry's output list.
 * @param {object} entry - corpus entry.
 * @param {string} sessionId - Session the entry belongs to.
 */
function commitLiveOutput(entry, sessionId) {
  const pending = entry.pendingOutput
  entry.pendingOutput = null
  if (pending === null || pending === undefined) return
  const held = Array.isArray(entry.outputs) ? entry.outputs : []
  held.push(pending)
  entry.outputs = held
  markDirty(sessionId)
  answerCache.clear()
}

/**
 * Append one message the user typed as soon as its event is committed, so a
 * search never pays for re-reading the whole Session log.
 * @param {object} session - the live Session the event belongs to.
 * @param {object} event - the committed Session event.
 */
function appendLiveEvent(session, event) {
  if (stopped || event === null || typeof event !== 'object') return
  const sessionId = session?.id
  if (typeof sessionId !== 'string') return
  if (event.type === 'session/title') {
    const title = event.data?.title
    if (typeof title !== 'string' || title === '') return
    const titled = corpus.get(sessionId)
    if (titled === undefined) return
    titled.title = title
    markDirty(sessionId)
    answerCache.clear()
    return
  }
  if (event.type === 'turn/start') {
    const live = corpus.get(sessionId)
    if (live === undefined) return
    const turn = Number.isFinite(event.data?.turn) ? event.data.turn : null
    if (turn !== null) live.turn = turn
    commitLiveOutput(live, sessionId)
    return
  }
  if (event.type === 'assistant/message') {
    const live = corpus.get(sessionId)
    if (live === undefined) return
    const text = readAssistantText(event.data).slice(0, MAX_MESSAGE_CHARS)
    if (text === '') return
    const turn = Number.isFinite(event.data?.turn) ? event.data.turn : (live.turn ?? null)
    const seq = Number.isFinite(event.seq) ? event.seq : 0
    const time = Number.isFinite(event.time) ? event.time : 0
    if (live.pendingOutput !== null && live.pendingOutput !== undefined) {
      // Later steps of the same turn replace the earlier text: only the last one
      // is the answer the user read.
      if (live.pendingOutput.turn === turn) {
        live.pendingOutput.seq = seq
        live.pendingOutput.time = time
        live.pendingOutput.text = text
        live.pendingOutput.lower = text.toLowerCase()
        markDirty(sessionId)
        answerCache.clear()
        return
      }
      commitLiveOutput(live, sessionId)
    }
    live.pendingOutput = { turn, seq, time, text, lower: text.toLowerCase() }
    markDirty(sessionId)
    answerCache.clear()
    return
  }
  if (event.type !== 'user/message') return
  const kind = event.data?.source?.kind
  // A known foreign source is harness context, not the user's own words.
  if (kind !== undefined && kind !== null && kind !== 'user') return
  const text = readMessageText(event.data)
  if (text === '') return
  let entry = corpus.get(sessionId)
  if (entry === undefined) {
    // The Session's history is still unread; the batch that reads its log fills
    // it in, and this message is in that log already.
    entry = {
      path: null,
      size: 0,
      mtimeMs: 0,
      readBytes: 0,
      frames: 0,
      cwd: readSessionCwd(session),
      title: null,
      live: true,
      readAt: Date.now(),
      messages: [],
      outputs: [],
      turn: null,
      pendingOutput: null,
    }
    corpus.set(sessionId, entry)
  }
  commitLiveOutput(entry, sessionId)
  const last = entry.messages[entry.messages.length - 1]
  if (last !== undefined && last.seq >= (Number(event.seq) || 0)) return
  const capped = text.slice(0, 20_000)
  entry.messages.push({
    seq: Number.isFinite(event.seq) ? event.seq : 0,
    time: Number.isFinite(event.time) ? event.time : 0,
    text: capped,
    lower: capped.toLowerCase(),
  })
  entry.live = true
  entry.readAt = Date.now()
  liveSessions.add(sessionId)
  markDirty(sessionId)
  answerCache.clear()
}

/**
 * Keep the corpus' live set in step with the Sessions this Host opens.
 * @param {HostContext} ctx - Host context.
 */
function observeSessions(ctx) {
  ctx.on('session/created', (session) => {
    if (stopped) return
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    liveSessions.add(sessionId)
    const known = corpus.get(sessionId)
    if (known !== undefined) known.live = true
    // A resumed Session carries history the corpus may have never seen; the
    // walk reads the log the Session appends to, soon after it opens.
    scheduleSweep()
  })
  ctx.on('session/event', (session, event) => appendLiveEvent(session, event))
  ctx.on('session/disposed', (session) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    liveSessions.delete(sessionId)
    const known = corpus.get(sessionId)
    if (known !== undefined) known.live = false
  })
}

/**
 * Wake the walk soon, so a Session that just opened becomes searchable without
 * waiting for the next periodic pass.
 */
function scheduleSweep() {
  if (stopped || pluginCtx === null || sweepDebounce !== null) return
  const timer = setTimeout(() => {
    timers.delete(timer)
    sweepDebounce = null
    if (pluginCtx !== null) void sweepCorpus(pluginCtx)
  }, SWEEP_DEBOUNCE_MS)
  timer.unref?.()
  timers.add(timer)
  sweepDebounce = timer
}

/**
 * Fold a log range into a corpus entry.
 * @param {object} entry - corpus entry to update.
 * @param {{ sessionId: string, path: string, size: number, mtimeMs: number }} record - log on disk.
 * @param {object} part - what {@link readLogTail} read.
 */
function applyPart(entry, record, part) {
  entry.messages = mergeMessages(entry.messages, part.messages)
  entry.outputs = mergeOutputs(entry.outputs ?? [], part.outputs ?? [])
  entry.path = record.path
  entry.size = record.size
  entry.mtimeMs = record.mtimeMs
  entry.readBytes = part.readBytes
  entry.frames = (entry.frames ?? 0) + part.frames
  if (part.cwd !== null) entry.cwd = part.cwd
  if (part.title !== null) entry.title = part.title
  entry.live = liveSessions.has(record.sessionId)
  entry.readAt = Date.now()
}

/**
 * Read one unseen or rewritten log with a short-lived child process, so the
 * memory a full pass leaves behind is returned when the child exits.
 * @param {object[]} batch - logs to read.
 */
function runBackfill(batch) {
  backfillRunning += 1
  const child = spawn(
    process.execPath,
    [BACKFILL_SCRIPT, paths.docs, paths.root, JSON.stringify(batch)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  child.stdout?.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr?.on('data', () => {
    // Diagnostics from the child would only repeat what the parent already logs.
  })
  let settled = false
  const finished = () => {
    if (settled) return
    settled = true
    backfillRunning -= 1
    if (stopped) return
    let indexed = 0
    for (const record of batch) {
      pending.delete(record.sessionId)
      const doc = readSessionDoc(paths, record.sessionId)
      if (doc === null) {
        // The child could not read the log; try again on a later pass.
        backfillQueue.push(record)
        continue
      }
      indexed += 1
      const known = corpus.get(record.sessionId)
      if (known === undefined) {
        corpus.set(record.sessionId, doc)
        continue
      }
      // Keep what live events added after the child read the log.
      doc.messages = mergeMessages(doc.messages, known.messages)
      doc.outputs = mergeOutputs(doc.outputs ?? [], known.outputs ?? [])
      if (known.readBytes > doc.readBytes) doc.readBytes = known.readBytes
      doc.live = known.live || doc.live
      corpus.set(record.sessionId, doc)
    }
    if (indexed > 0) answerCache.clear()
    pluginCtx?.logger?.debug?.(`[session-history-search] backfill ${stdout.slice(0, 200)}`)
    pumpBackfill()
  }
  child.on('error', finished)
  child.on('exit', finished)
}

/**
 * Start as many backfill children as the queue and the worker cap allow.
 */
function pumpBackfill() {
  if (stopped || paths === null) return
  while (backfillRunning < BACKFILL_WORKERS && backfillQueue.length > 0) {
    const batch = []
    let bytes = 0
    while (backfillQueue.length > 0) {
      const next = backfillQueue[0]
      if (batch.length > 0 && bytes + next.size > BACKFILL_BATCH_BYTES) break
      batch.push(next)
      backfillQueue = backfillQueue.slice(1)
      bytes += next.size
      pending.add(next.sessionId)
    }
    runBackfill(batch)
  }
}

/**
 * Walk the Session logs and read only what the corpus does not hold yet.
 * @param ctx - Host context.
 */
async function sweepCorpus(ctx) {
  if (sweeping || stopped) return
  sweeping = true
  const startedAt = Date.now()
  const report = { logs: 0, tailed: 0, queued: 0, removed: 0, ms: 0, error: null }
  try {
    if (paths === null) {
      report.error = 'no cache directory'
      return
    }
    const records = listLogRecords(paths.logs)
    report.logs = records.length
    const alive = new Set()
    const unseen = []
    for (const record of records) {
      if (stopped) return
      alive.add(record.sessionId)
      const known = corpus.get(record.sessionId)
      // A Session whose document already covers the log at the same size and
      // modification time has nothing new to read.
      if (known !== undefined && known.path === record.path) {
        if (
          record.size === known.size &&
          record.mtimeMs === known.mtimeMs &&
          known.readBytes === record.size
        ) {
          continue
        }
        if (
          record.size < known.readBytes ||
          (record.size === known.size && record.mtimeMs !== known.mtimeMs)
        ) {
          // The log was rewritten in place, so only that one log is read again.
          unseen.push(record)
          continue
        }
        const part = readLogTail(record.path, known.readBytes, record.size)
        if (part === null) {
          unseen.push(record)
          continue
        }
        applyPart(known, record, part)
        markDirty(record.sessionId)
        report.tailed += 1
        // Reading a large log is synchronous; let the Host breathe between logs.
        await new Promise((resolve) => setImmediate(resolve))
        continue
      }
      unseen.push(record)
    }
    for (const [sessionId, entry] of corpus) {
      if (typeof entry.path !== 'string') continue
      if (alive.has(sessionId)) continue
      corpus.delete(sessionId)
      dirty.delete(sessionId)
      removeSessionDoc(paths, sessionId)
      report.removed += 1
    }
    if (unseen.length > 0) {
      // Newest first: the Sessions a user is most likely to look for again are
      // the ones that become searchable first.
      unseen.sort((left, right) => right.mtimeMs - left.mtimeMs)
      const queued = new Set(backfillQueue.map((record) => record.sessionId))
      for (const record of unseen) {
        if (pending.has(record.sessionId) || queued.has(record.sessionId)) continue
        backfillQueue.push(record)
        queued.add(record.sessionId)
      }
      report.queued = backfillQueue.length
      pumpBackfill()
    }
    flushDirty()
    answerCache.clear()
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  } finally {
    report.ms = Date.now() - startedAt
    sweeping = false
  }
}

/**
 * Register the search route, load the corpus and keep it warm.
 * @param ctx - Host context.
 */
export function apply(ctx) {
  // Enabling the plugin again re-applies this module; clear the disposal flag
  // the previous instance set, or every listener and walk stays inert.
  stopped = false
  sweeping = false
  sweepDebounce = null
  saveTimer = null
  backfillRunning = 0
  backfillQueue = []
  pending.clear()
  dirty.clear()
  pluginCtx = ctx
  paths = indexPaths(ctx)
  corpus.clear()
  answerCache.clear()
  if (paths !== null) loadCorpus(paths, corpus)
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (req, res) => handleSearch(ctx, req, res),
      }),
    'session-history-search: route',
  )
  ctx.effect(
    () => () => {
      stopped = true
      pluginCtx = null
      sweepDebounce = null
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      flushDirty()
      // The module instance outlives a disable/enable cycle, so the corpus must
      // not stay in memory after the plugin stops answering.
      corpus.clear()
      pending.clear()
      backfillQueue = []
      answerCache.clear()
    },
    'session-history-search: corpus',
  )
  observeSessions(ctx)
  const startTimer = setTimeout(() => {
    timers.delete(startTimer)
    void sweepCorpus(ctx)
  }, SWEEP_START_DELAY_MS)
  startTimer.unref?.()
  timers.add(startTimer)
  const sweepTimer = setInterval(() => {
    void sweepCorpus(ctx)
  }, SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
  timers.add(sweepTimer)
}
