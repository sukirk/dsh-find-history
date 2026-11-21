// Acceptance corpus: 20 queries of length 2–10, each checked for the exact
// Session set, the time order and the relevance order. Sessions are chosen so
// both orders differ for the same query (an older Session with more
// occurrences must beat a newer Session with one).
import assert from 'node:assert/strict'
import test from 'node:test'
import { searchWithRelaxation } from '../index.mjs'

const PLAIN = { caseSensitive: false, whole: false, regex: false }
const WHOLE = { caseSensitive: false, whole: true, regex: false }
const CASE_SENSITIVE = { caseSensitive: true, whole: false, regex: false }
const REGEX = { caseSensitive: false, whole: false, regex: true }
const INPUT = { inputs: true, outputs: false }
const APPROXIMATE_COVERAGE = 0.6

/** One corpus entry with one user row per [time, text]. */
function entry(rows) {
  return {
    messages: rows.map(([time, text], index) => ({ seq: index + 1, time, text })),
    outputs: [],
  }
}

const corpus = new Map([
  ['new', entry([[5000, 'alpha 历史搜索 工具']])],
  ['old', entry([[1000, 'alpha 历史搜索 工具 历史搜索 历史搜索']])],
  ['mixed', entry([[3000, '历史搜索 在 alpha']])],
  ['approx', entry([[4000, '历史 搜索 分开了']])],
  ['split', entry([[2000, 'alpha'], [4500, '历史搜索 完成']])],
  ['other', entry([[6000, '完全无关']])],
])

const CASES = [
  { query: '历史搜索', mode: 'exact', time: ['new', 'split', 'mixed', 'old'], relevance: ['old', 'new', 'split', 'mixed'] },
  { query: '历史', mode: 'exact', time: ['new', 'split', 'approx', 'mixed', 'old'], relevance: ['old', 'new', 'split', 'approx', 'mixed'] },
  { query: '搜索', mode: 'exact', time: ['new', 'split', 'approx', 'mixed', 'old'], relevance: ['old', 'new', 'split', 'approx', 'mixed'] },
  { query: 'alpha', mode: 'exact', time: ['new', 'mixed', 'split', 'old'], relevance: ['new', 'mixed', 'split', 'old'] },
  { query: '工具', mode: 'exact', time: ['new', 'old'], relevance: ['new', 'old'] },
  { query: '无关', mode: 'exact', time: ['other'], relevance: ['other'] },
  { query: '完全无关', mode: 'exact', time: ['other'], relevance: ['other'] },
  { query: '历史搜索工具', mode: 'approximate', time: ['new', 'split', 'mixed', 'old'], relevance: ['new', 'old', 'split', 'mixed'] },
  { query: '历史 搜索', mode: 'exact', time: ['approx'], relevance: ['approx'] },
  { query: '搜索历史', mode: 'approximate', time: ['new', 'split', 'approx', 'mixed', 'old'], relevance: ['new', 'split', 'approx', 'mixed', 'old'] },
  { query: '历史搜索工', mode: 'approximate', time: ['new', 'split', 'mixed', 'old'], relevance: ['new', 'split', 'mixed', 'old'] },
  { query: 'alpha 历史', mode: 'exact', time: ['new', 'old'], relevance: ['new', 'old'] },
  { query: '历史 alpha', mode: 'approximate', time: ['new', 'mixed', 'old'], relevance: ['new', 'mixed', 'old'] },
  { query: '历史搜索在', mode: 'approximate', time: ['new', 'split', 'mixed', 'old'], relevance: ['new', 'split', 'mixed', 'old'] },
  { query: '在 alpha', mode: 'exact', time: ['mixed'], relevance: ['mixed'] },
  { query: 'alpha 工具', mode: 'approximate', time: ['new', 'old'], relevance: ['new', 'old'] },
  { query: 'pha', mode: 'exact', time: ['new', 'mixed', 'split', 'old'], relevance: ['new', 'mixed', 'split', 'old'] },
  { query: 'ph', mode: 'exact', time: ['new', 'mixed', 'split', 'old'], relevance: ['new', 'mixed', 'split', 'old'] },
  { query: '史搜', mode: 'exact', time: ['new', 'split', 'mixed', 'old'], relevance: ['old', 'new', 'split', 'mixed'] },
  { query: 'alpha 历史搜索', mode: 'exact', time: ['new', 'old'], relevance: ['new', 'old'] },
]

/** Session ids in the requested order. */
function run(query, flags = PLAIN, sort = 'time') {
  const found = searchWithRelaxation(corpus, query, flags, new Set(), INPUT, { sort })
  return { mode: found.matcher.mode, sessions: found.sessions, ids: found.sessions.map((session) => session.sessionId) }
}

test('20 queries of length 2–10 return exactly the expected Sessions in both orders', () => {
  assert.equal(CASES.length, 20)
  for (const item of CASES) {
    const length = [...item.query].length
    assert.ok(length >= 2 && length <= 10, `${item.query} length ${length}`)

    const byTime = run(item.query, PLAIN, 'time')
    assert.equal(byTime.mode, item.mode, `${item.query} mode`)
    assert.deepEqual(byTime.ids, item.time, `${item.query} time order`)

    const byRelevance = run(item.query, PLAIN, 'relevance')
    assert.equal(byRelevance.mode, item.mode, `${item.query} mode (relevance)`)
    assert.deepEqual(byRelevance.ids, item.relevance, `${item.query} relevance order`)

    // No false positives: an approximate row always carries enough of the query.
    if (item.mode === 'approximate') {
      for (const session of byTime.sessions) {
        assert.ok(session.maxCoverage >= APPROXIMATE_COVERAGE, `${item.query} on ${session.sessionId}`)
      }
    }
  }
})

test('case, whole-word and regex variants on the acceptance corpus', () => {
  assert.deepEqual(run('ALPHA').ids, ['new', 'mixed', 'split', 'old'])
  assert.deepEqual(run('ALPHA', CASE_SENSITIVE).ids, [])
  assert.equal(run('ALPHA', CASE_SENSITIVE).mode, 'exact')

  assert.deepEqual(run('alpha', WHOLE).ids, ['new', 'mixed', 'split', 'old'])
  // Whole word refuses the relaxed fallback: alp is no word in alpha.
  assert.deepEqual(run('alp', WHOLE).ids, [])
  assert.equal(run('alp', WHOLE).mode, 'exact')
  assert.deepEqual(run('alpha 历史', WHOLE).ids, ['new', 'old'])
  assert.deepEqual(run('历史', WHOLE).ids, ['new', 'split', 'approx', 'mixed', 'old'])

  const regex = run('历[史]搜索', REGEX)
  assert.equal(regex.mode, 'regex')
  assert.deepEqual(regex.ids, ['new', 'split', 'mixed', 'old'])
})

test('a query that only appears in old messages still ranks by occurrences', () => {
  const time = run('史搜')
  const relevance = run('史搜', PLAIN, 'relevance')
  assert.deepEqual(time.ids, ['new', 'split', 'mixed', 'old'])
  assert.deepEqual(relevance.ids, ['old', 'new', 'split', 'mixed'])
})
