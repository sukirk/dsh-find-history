/**
 * dsh-find-history — host half.
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
  capMessageText,
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

export const name = 'find-history'

export const inject = ['webServer', 'connection', 'workspaceRegistry']

/** Prefix some Harness versions write in front of a Session id. */
const SESSION_PREFIX = 'session-'
/** Exact pathname of the route the Client half queries. */
const ROUTE_PATH = '/dsh-find-history/search'
/** Short-lived process that reads unseen Session logs, written next to this file. */
const BACKFILL_SCRIPT = fileURLToPath(new URL('./backfill.mjs', import.meta.url))
/** Sessions answered when the caller names no limit. */
const DEFAULT_LIMIT = 24
/** Upper bound for one answer; the list is scanned quickly and need not page. */
const MAX_LIMIT = 60
/** Text pools a query reads: the user's own words, the answers that close turns. */
const DEFAULT_FIELDS = Object.freeze({ inputs: true, outputs: false })

/** Longest accepted query, in characters; the Client caps its input at the same length. */
const MAX_QUERY_CHARS = 300
/** Longest accepted regex query: past this a pattern is a pasted mistake. */
const MAX_REGEX_CHARS = 120
/** Share of a query's units a message must carry for the auto-relaxed match. */
const APPROXIMATE_COVERAGE = 0.6
/** The relaxed scan needs two units; a single unit is the exact query itself. */
const APPROXIMATE_MIN_UNITS = 2
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
 * @returns {{ text: string, truncated: boolean }} trimmed query and whether it was capped.
 */
function readQuery(params) {
  const raw = (params.get('q') ?? '').trim()
  if (raw.length <= MAX_QUERY_CHARS) return { text: raw, truncated: false }
  return { text: raw.slice(0, MAX_QUERY_CHARS), truncated: true }
}

/**
 * Read the text pools one request searches.
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
 * Characters that count as part of a word for whole-word matching: ASCII
 * letters, digits and the underscore, the same set `\b` uses. Chinese characters
 * are deliberately outside it: Chinese prose is not space-delimited, so treating
 * 汉字 as word characters makes every Chinese keyword sit inside a longer "word"
 * and whole-word mode would never match anything (「历史搜索」inside
 * 「会话历史搜索插件」would be a miss). With this line the toggle keeps its
 * meaning where a word boundary exists and leaves Chinese substrings alone.
 */
const WORD_CHAR = /[a-z0-9_]/i

/**
 * Tell whether one character at an index continues an ASCII word.
 * @param {string} text - haystack.
 * @param {number} index - position to inspect.
 * @returns {boolean} true when the position holds a word character.
 */
function isWordCharAt(text, index) {
  if (index < 0 || index >= text.length) return false
  return WORD_CHAR.test(text.charAt(index))
}

/**
 * Find the first standalone occurrence of the literal query, starting at
 * `from`. Only an ASCII word edge needs a boundary; a query that starts or ends
 * with 汉字 has no word boundary to test, so that edge is skipped. This is the
 * rule VS Code applies in practice: its `\b` is ASCII-only, which is why a
 * Chinese keyword still matches inside Chinese prose (microsoft/vscode#226237).
 * @param {string} text - haystack, already case-folded when needed.
 * @param {string} term - literal query.
 * @param {number} [from] - first offset to search from.
 * @returns {number} index, or -1 when no standalone occurrence exists.
 */
function findWholeFrom(text, term, from = 0) {
  const pinStart = WORD_CHAR.test(term.charAt(0))
  const pinEnd = WORD_CHAR.test(term.charAt(term.length - 1))
  if (!pinStart && !pinEnd) return text.indexOf(term, from)
  let at = from
  for (;;) {
    at = text.indexOf(term, at)
    if (at === -1) return -1
    if (
      (!pinStart || !isWordCharAt(text, at - 1)) &&
      (!pinEnd || !isWordCharAt(text, at + term.length))
    ) {
      return at
    }
    at += 1
  }
}

/**
 * Find the first standalone occurrence from the start of the text.
 * @param {string} text - haystack.
 * @param {string} term - literal query.
 * @returns {number} index, or -1.
 */
function findWhole(text, term) {
  return findWholeFrom(text, term, 0)
}

/** Characters written without spaces between words. */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * The units a relaxed search compares: overlapping two-character n-grams for
 * scripts without spaces, whole words for runs of letters and digits. This is a
 * standard n-gram approximation of "contains most of the query" and needs no
 * length or parity special case.
 * @param {string} query - trimmed query.
 * @param {boolean} caseSensitive - keep case in the units.
 * @returns {string[] | null} distinct units, or null when there are fewer than two.
 */
function queryUnits(query, caseSensitive) {
  const fold = (text) => (caseSensitive ? text : text.toLowerCase())
  const units = new Set()
  let run = []
  let runIsCjk = false
  const flush = () => {
    if (run.length === 0) return
    if (runIsCjk) {
      if (run.length === 1) units.add(fold(run[0]))
      for (let index = 0; index + 1 < run.length; index += 1) {
        units.add(fold(run[index] + run[index + 1]))
      }
    } else {
      units.add(fold(run.join('')))
    }
    run = []
  }
  for (const char of query) {
    const isCjk = CJK_CHAR.test(char)
    const isWord = isCjk || /[\p{L}\p{N}_]/u.test(char)
    if (!isWord) {
      flush()
      continue
    }
    if (run.length > 0 && runIsCjk !== isCjk) flush()
    runIsCjk = isCjk
    run.push(char)
  }
  flush()
  return units.size >= APPROXIMATE_MIN_UNITS ? [...units] : null
}

/**
 * Measure how much of the query a message carries, walking its runs once.
 * @param {string} text - message text.
 * @param {ReadonlySet<string>} wanted - folded query units.
 * @param {boolean} caseSensitive - keep case while scanning.
 * @returns {{ matched: number, coverage: number, index: number, length: number }} matched units, coverage, and the longest match.
 */
function scanUnits(text, wanted, caseSensitive) {
  const body = caseSensitive ? text : text.toLowerCase()
  const found = new Set()
  let bestIndex = -1
  let bestLength = 0
  const consider = (unit, index) => {
    if (!wanted.has(unit)) return
    found.add(unit)
    if (unit.length > bestLength) {
      bestLength = unit.length
      bestIndex = index
    }
  }
  let offset = 0
  let runStart = 0
  let run = []
  let runIsCjk = null
  const flush = () => {
    if (run.length === 0) return
    if (runIsCjk === true) {
      let at = runStart
      for (let index = 0; index < run.length; index += 1) {
        const char = run[index]
        consider(char, at)
        if (index + 1 < run.length) consider(char + run[index + 1], at)
        at += char.length
      }
    } else {
      consider(run.join(''), runStart)
    }
    run = []
  }
  for (const char of body) {
    const isCjk = CJK_CHAR.test(char)
    const isWord = isCjk || /[\p{L}\p{N}_]/u.test(char)
    if (!isWord) {
      flush()
      runIsCjk = null
      offset += char.length
      continue
    }
    if (runIsCjk !== null && runIsCjk !== isCjk) flush()
    if (run.length === 0) runStart = offset
    runIsCjk = isCjk
    run.push(char)
    offset += char.length
  }
  flush()
  return {
    matched: found.size,
    coverage: wanted.size === 0 ? 0 : found.size / wanted.size,
    index: bestIndex,
    length: bestLength,
  }
}

/**
 * Decide whether a regular expression is too costly to run on the Host loop.
 * The search runs synchronously over every stored message, so one pattern with
 * catastrophic backtracking (`(a+)+$`) would freeze the whole web server. The
 * check is deliberately conservative: it rejects the shapes that backtrack
 * exponentially, not everything clever.
 * @param {string} source - the regex the user typed.
 * @returns {'query-too-long' | 'unsafe-regex' | null} the refusal, or null when it is safe to compile.
 */
function regexQueryProblem(source) {
  if (typeof source !== 'string') return 'unsafe-regex'
  if (source.length > MAX_REGEX_CHARS) return 'query-too-long'
  // Blank escapes and character classes first: `[.+*]` is data, not quantifiers,
  // and an escape's own letter must not be glued to the next quantifier.
  const stripped = source.replace(/\\./gu, 'a').replace(/\[(?:[^\]\\]|\\.)*\]/gu, '[]')
  // A quantifier inside a group that is itself quantified: (a+)+, (?:a{2})*, (.*)*.
  if (/\((?:\?:|\?=|\?!|\?<=|\?<!)?(?:[^()]|\([^()]*\))*[+*}][^()]*\)\s*(?:[+*]|\{\d*,?\d*\})/u.test(stripped)) {
    return 'unsafe-regex'
  }
  // A quantified group with alternatives: (a|ab)+, (a|a)*.
  if (/\((?:\?:)?[^()]*\|[^()]*\)\s*(?:[+*]|\{\d*,?\d*\})/u.test(stripped)) return 'unsafe-regex'
  // Two quantifiers in a row: a**, a{2}* and friends.
  if (/(?:[+*]|\{\d*,?\d*\})\s*(?:[+*]|\{\d*,?\d*\})/u.test(stripped)) return 'unsafe-regex'
  // Many quantifiers are a cost signal even without nesting.
  const quantifiers = stripped.match(/[+*]|\{\d*,?\d*\}/gu)
  if (quantifiers !== null && quantifiers.length > 12) return 'unsafe-regex'
  return null
}

/**
 * Compile the literal search VS Code runs: the whole typed string is one search
 * string, spaces and punctuation included. The toggles only change case folding
 * and whether the two ends must sit on ASCII word boundaries.
 * @param {string} query - trimmed literal query.
 * @param {{ caseSensitive: boolean, whole: boolean }} options - matching flags.
 * @returns {object} matcher.
 */
function buildLiteralMatcher(query, options) {
  const caseSensitive = options.caseSensitive === true
  const whole = options.whole === true
  const fold = (text) => (caseSensitive ? text : text.toLowerCase())
  const needle = fold(query)
  const findAt = (body, from) => (whole ? findWholeFrom(body, needle, from) : body.indexOf(needle, from))
  const count = (body) => {
    let total = 0
    let from = 0
    for (;;) {
      const at = findAt(body, from)
      if (at === -1) return total
      total += 1
      from = at + needle.length
    }
  }
  return {
    mode: 'exact',
    query,
    locate: (text) => {
      const at = findAt(fold(text), 0)
      return at === -1 ? { index: -1, length: 0 } : { index: at, length: needle.length }
    },
    count: (text) => count(fold(text)),
    match: (text, needCount) => {
      const body = fold(text)
      const at = findAt(body, 0)
      if (at === -1) return null
      return {
        index: at,
        length: needle.length,
        occurrences: needCount ? count(body) : 1,
        coverage: 1,
      }
    },
  }
}

/**
 * Compile a regular expression over the full message text.
 * @param {string} query - the pattern.
 * @param {{ caseSensitive: boolean, whole: boolean }} options - matching flags.
 * @returns {object | null} matcher, or null when the pattern is refused or invalid.
 */
function buildRegexMatcher(query, options) {
  if (regexQueryProblem(query) !== null) return null
  const flags = options.caseSensitive ? 'u' : 'iu'
  let expression
  let wholeExpression = null
  try {
    expression = new RegExp(query, flags)
    if (options.whole === true) {
      wholeExpression = new RegExp(`(?<![A-Za-z0-9_])(?:${query})(?![A-Za-z0-9_])`, flags)
      wholeExpression.exec('')
    }
  } catch {
    return null
  }
  const source = (wholeExpression ?? expression).source
  const scanner = new RegExp(source, flags)
  const counter = new RegExp(source, `${flags.replace(/g/u, '')}g`)
  const first = (text) => {
    scanner.lastIndex = 0
    const found = scanner.exec(text)
    return found === null ? null : { index: found.index, length: found[0].length }
  }
  const count = (text) => {
    counter.lastIndex = 0
    let total = 0
    for (;;) {
      const one = counter.exec(text)
      if (one === null) return total
      total += 1
      if (one[0].length === 0) counter.lastIndex += 1
    }
  }
  return {
    mode: 'regex',
    query,
    locate: (text) => first(text) ?? { index: -1, length: 0 },
    count,
    match: (text, needCount) => {
      const spot = first(text)
      if (spot === null) return null
      return { ...spot, occurrences: needCount ? count(text) : 1, coverage: 1 }
    },
  }
}

/**
 * Compile the relaxed matcher used when the exact search answers nothing: a
 * message qualifies when it carries enough of the query's n-grams.
 * @param {string} query - trimmed literal query.
 * @param {{ caseSensitive: boolean }} options - matching flags.
 * @returns {object | null} matcher, or null when the query has too few units.
 */
function buildApproximateMatcher(query, options = {}) {
  const units = queryUnits(query, options.caseSensitive === true)
  if (units === null) return null
  const wanted = new Set(units)
  const measure = (text) => scanUnits(text, wanted, options.caseSensitive === true)
  return {
    mode: 'approximate',
    query,
    units,
    locate: (text) => {
      const measured = measure(text)
      return measured.matched === 0
        ? { index: -1, length: 0 }
        : { index: measured.index, length: measured.length }
    },
    match: (text) => {
      const measured = measure(text)
      if (measured.matched < APPROXIMATE_MIN_UNITS || measured.coverage < APPROXIMATE_COVERAGE) {
        return null
      }
      return {
        index: measured.index,
        length: measured.length,
        occurrences: measured.matched,
        coverage: measured.coverage,
      }
    },
  }
}

/**
 * Compile one query into a matcher.
 * @param {string} query - trimmed query.
 * @param {{ caseSensitive: boolean, whole: boolean, regex: boolean }} options - matching flags.
 * @returns {object | null} matcher, or null when a regex is refused or does not compile.
 */
function buildMatcher(query, options = {}) {
  if (options.regex === true) return buildRegexMatcher(query, options)
  return buildLiteralMatcher(query, options)
}

/**
 * Build the excerpt shown for one matching message: a window around the match.
 * @param {string} text - full message text.
 * @param {number} index - where the match starts, or -1.
 * @returns {string} collapsed one-line excerpt.
 */
function makeExcerpt(text, index) {
  const start = index <= EXCERPT_LEAD || index === -1 ? 0 : index - EXCERPT_LEAD
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
 * Order hits inside one Session: time is chronological; relevance puts the
 * strongest hit (coverage, then occurrences) first and breaks ties by time.
 * @param {object} left - hit.
 * @param {object} right - hit.
 * @param {'time' | 'relevance'} sort - requested order.
 * @returns {number} sort order.
 */
function compareHits(left, right, sort = 'time') {
  if (sort === 'relevance') {
    if (left.coverage !== right.coverage) return right.coverage - left.coverage
    if (left.occurrences !== right.occurrences) return right.occurrences - left.occurrences
  }
  if (left.message.time !== right.message.time) return right.message.time - left.message.time
  if (left.kind !== right.kind) return left.kind === 'input' ? -1 : 1
  return right.message.seq - left.message.seq
}

/**
 * Match quality of one hit: coverage, then occurrences, then time. Occurrence
 * counts are only collected for the relevance order, so a time-ordered row
 * opens on the newest hit and a relevance-ordered row on the strongest one.
 * @param {object} left - hit.
 * @param {object} right - hit.
 * @returns {number} sort order.
 */
function compareQuality(left, right) {
  if (left.coverage !== right.coverage) return right.coverage - left.coverage
  if (left.occurrences !== right.occurrences) return right.occurrences - left.occurrences
  if (left.message.time !== right.message.time) return right.message.time - left.message.time
  if (left.kind !== right.kind) return left.kind === 'input' ? -1 : 1
  return right.message.seq - left.message.seq
}

/**
 * Collect the matching rows of one Session. The counters used for ranking are
 * taken across every matching row, before the display cap.
 * @param {object} entry - corpus entry.
 * @param {object} matcher - compiled matcher.
 * @param {{ inputs: boolean, outputs: boolean }} fields - pools to search.
 * @param {(time: number) => boolean} inTime - time-window filter.
 * @param {'time' | 'relevance'} sort - requested order.
 * @param {boolean} needCounts - count every occurrence for relevance ranking.
 * @returns {{ hits: object[], best: object | null, totalHits: number, totalOccurrences: number, maxCoverage: number, newestTime: number }} hits and ranking counters.
 */
function collectHitsDetailed(entry, matcher, fields, inTime, sort = 'time', needCounts = false) {
  const hits = []
  let totalHits = 0
  let totalOccurrences = 0
  let maxCoverage = 0
  let newestTime = -Infinity
  const scan = (rows, kind) => {
    for (const row of rows) {
      if (!inTime(row.time)) continue
      const found = matcher.match(row.text, needCounts)
      if (found === null) continue
      const hit = { message: row, kind, ...found }
      totalHits += 1
      totalOccurrences += hit.occurrences
      if (hit.coverage > maxCoverage) maxCoverage = hit.coverage
      if (row.time > newestTime) newestTime = row.time
      hits.push(hit)
    }
  }
  if (fields.inputs === true) scan(entry.messages, 'input')
  if (fields.outputs === true) scan(entry.outputs ?? [], 'output')
  let best = null
  for (const hit of hits) if (best === null || compareQuality(hit, best) < 0) best = hit
  hits.sort((left, right) => compareHits(left, right, sort))
  return {
    hits: hits.slice(0, MAX_GROUP_HITS),
    best,
    totalHits,
    totalOccurrences,
    maxCoverage,
    newestTime,
  }
}

/**
 * Collect the matching rows of one Session, in the requested order.
 * @param {object} entry - corpus entry.
 * @param {object} matcher - compiled matcher.
 * @param {{ inputs: boolean, outputs: boolean }} fields - pools to search.
 * @param {'time' | 'relevance'} sort - requested order.
 * @returns {object[]} hits, best first.
 */
function collectHits(entry, matcher, fields, sort = 'time') {
  return collectHitsDetailed(entry, matcher, fields, () => true, sort, sort === 'relevance').hits
}

/**
 * Relevance of one Session as an ordered tuple: coverage of its best hit, the
 * number of occurrences in the Session, then the newest match. Coverage is 1
 * for exact and regex hits, so relevance then ranks by how often the query
 * appears (a Session quoting it three times beats one quoting it once).
 * @param {object} session - matched Session.
 * @returns {[number, number, number]} relevance key.
 */
function relevanceOf(session) {
  return [session.maxCoverage ?? 0, session.totalOccurrences ?? 0, session.newestTime ?? 0]
}

/**
 * Compare two Sessions by relevance: coverage, occurrences, then newest match.
 * @param {object} left - Session.
 * @param {object} right - Session.
 * @returns {number} sort order.
 */
function compareRelevance(left, right) {
  const a = relevanceOf(left)
  const b = relevanceOf(right)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index]
  }
  return compareIds(left, right)
}

/**
 * Compare two Sessions by their newest matching message, newest first.
 * @param {object} left - Session.
 * @param {object} right - Session.
 * @returns {number} sort order.
 */
function compareNewest(left, right) {
  if (left.newestTime !== right.newestTime) return right.newestTime - left.newestTime
  return compareIds(left, right)
}

/**
 * Order two Sessions deterministically when their ranking keys tie.
 * @param {object} left - Session.
 * @param {object} right - Session.
 * @returns {number} sort order.
 */
function compareIds(left, right) {
  return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
}

/**
 * Order Sessions: purely by newest match with `time`, by relevance key otherwise.
 * @param {object[]} sessions - sessions to order in place.
 * @param {'time' | 'relevance'} sort - requested order.
 * @returns {object[]} the same list.
 */
function rankSessions(sessions, sort = 'time') {
  sessions.sort((left, right) => (sort === 'relevance' ? compareRelevance(left, right) : compareNewest(left, right)))
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
 * Search one corpus with the exact matcher, auto-relaxing to n-gram coverage
 * when nothing matches. Regex and whole-word searches are never relaxed.
 * @param {Map<string, object>} source - corpus to search.
 * @param {string} query - trimmed query.
 * @param {{ caseSensitive: boolean, whole: boolean, regex: boolean }} options - matching flags.
 * @param {ReadonlySet<string>} skip - Session ids to leave out.
 * @param {{ inputs: boolean, outputs: boolean }} fields - pools to search.
 * @param {object} filter - Session, time, and order filters.
 * @returns {{ matcher: object, sessions: object[] } | null} matcher and sessions, or null for an invalid regex.
 */
function searchWithRelaxation(source, query, options, skip, fields, filter) {
  const matcher = buildMatcher(query, options)
  if (matcher === null) return null
  let sessions = searchCorpusIn(source, matcher, skip, fields, filter)
  if (sessions.length > 0 || matcher.mode !== 'exact' || options.whole === true) {
    return { matcher, sessions }
  }
  const relaxed = buildApproximateMatcher(query, options)
  if (relaxed === null) return { matcher, sessions }
  const relaxedSessions = searchCorpusIn(source, relaxed, skip, fields, filter)
  return relaxedSessions.length > 0
    ? { matcher: relaxed, sessions: relaxedSessions }
    : { matcher, sessions }
}

/**
 * Search one corpus with one matcher.
 * @param {Map<string, object>} source - corpus to search.
 * @param {object} matcher - compiled matcher.
 * @param {ReadonlySet<string>} skip - Session ids left out of the search entirely.
 * @param {{ inputs: boolean, outputs: boolean }} fields - pools to search.
 * @param {{ accept?: (entry: object) => boolean, since?: number | null, until?: number | null, sort?: 'time' | 'relevance' }} filter - Session, time, and order filters.
 * @returns {object[]} matching Sessions, best first.
 */
function searchCorpusIn(source, matcher, skip, fields, filter = {}) {
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
  // Counting every occurrence only pays for the relevance order; a time-ordered
  // search opens on the newest hit, where all literal matches are equal.
  const needCounts = sort === 'relevance'
  const sessions = []
  for (const [sessionId, entry] of source) {
    if (skip.has(sessionId) || skip.has(sessionKey(sessionId))) continue
    if (accept !== null && !accept(entry)) continue
    const collected = collectHitsDetailed(entry, matcher, fields, inTime, sort, needCounts)
    if (collected.totalHits === 0) continue
    sessions.push({ sessionId, entry, ...collected })
  }
  return rankSessions(sessions, sort)
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
 * @param {object} hit - hit from {@link collectHitsDetailed}.
 * @returns {object} row fields shared by both layouts.
 */
function describeHit(hit) {
  const focus = hit.message.text.slice(hit.index, hit.index + hit.length)
  const preview = messagePreview(hit.message.text, hit.index, hit.length)
  return {
    snippet: makeExcerpt(hit.message.text, hit.index),
    head: preview.head,
    match: preview.match,
    tail: preview.tail,
    time: hit.message.time,
    seq: hit.message.seq,
    kind: hit.kind,
    focus,
    coverage: hit.coverage,
    truncated: hit.message.truncated === true,
  }
}

/**
 * Describe the matching Sessions for the Client.
 * @param ctx - Host context.
 * @param {object[]} sessions - matching sessions from {@link searchCorpus}.
 * @param {boolean} group - whether to keep every hit of a Session.
 * @returns {object[]} rows for the Client.
 */
function describeMatches(ctx, sessions, group) {
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
        totalHits: session.totalHits,
        hits: session.hits.map((hit) => describeHit(hit)),
      }
    }
    return { ...item, ...describeHit(session.best) }
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
  const { text: query, truncated } = readQuery(params)
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
      mode: 'exact',
      truncated,
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
  if (options.regex === true) {
    const problem = regexQueryProblem(query)
    if (problem !== null) {
      sendJson(res, 400, {
        error: problem,
        message:
          problem === 'query-too-long'
            ? `正则查询最长 ${MAX_REGEX_CHARS} 个字符；请改用子串搜索（去掉 regex=1）或缩短模式`
            : '这个正则可能引发灾难性回溯，已拒绝执行；请改用子串搜索（去掉 regex=1）或简化模式',
      })
      return
    }
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
    const found = searchWithRelaxation(corpus, query, options, skip, fields, filter)
    if (found === null) {
      sendJson(res, 400, { error: 'invalid-regex', message: 'invalid regular expression' })
      return
    }
    const matcher = found.matcher
    const sessions = found.sessions
    const total = sessions.length
    const page = sessions.slice(offset, offset + limit)
    const items = describeMatches(ctx, page, group)
    const payload = {
      query,
      mode: matcher.mode,
      truncated,
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
      `[find-history] search failed: ${error instanceof Error ? error.message : String(error)}`,
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
    const text = capMessageText(readAssistantText(event.data))
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
  const capped = capMessageText(text)
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
    let childReport = null
    try {
      childReport = JSON.parse(stdout)
    } catch {
      childReport = null
    }
    if (childReport !== null && (childReport.damaged > 0 || childReport.incomplete > 0)) {
      pluginCtx?.logger?.warn?.(
        `[find-history] backfill: ${childReport.damaged} damaged frame(s), ${childReport.incomplete} log(s) with an incomplete tail`,
      )
    }
    pluginCtx?.logger?.debug?.(`[find-history] backfill ${stdout.slice(0, 200)}`)
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
        if (part.damaged > 0 || part.complete === false) {
          // 损坏或还在写入的帧：告警，而不是把这段字节当成已读悄悄跳过。
          ctx.logger?.warn?.(
            `[find-history] ${record.sessionId}: ${part.damaged} damaged frame(s)` +
              (part.complete === false ? ', tail frame incomplete (will retry)' : ''),
          )
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
      if (alive.has(sessionId)) continue
      // A Session with no log file is either live-only (kept while this Host
      // still has it open) or was never written to disk; once it is gone from
      // both sets the stale row must go too, or disposed Sessions stay findable.
      if (liveSessions.has(sessionId) || entry.live === true) continue
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
    'find-history: route',
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
    'find-history: corpus',
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

/**
 * Matching and ordering helpers the test suite exercises directly. They stay
 * unexported from the package surface: package.json only maps `./` to this
 * module for the Host, and nothing imports these names at runtime.
 */
export {
  buildApproximateMatcher,
  buildMatcher,
  searchWithRelaxation,
  collectHits,
  compareHits,
  compareQuality,
  queryUnits,
  rankSessions,
  regexQueryProblem,
  relevanceOf,
  scanUnits,
  searchCorpusIn,
}
