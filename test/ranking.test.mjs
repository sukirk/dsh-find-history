// Ordering tests for the literal search model: time is purely chronological;
// relevance ranks by coverage of the best hit, then how often the query occurs
// in the Session, then recency.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildApproximateMatcher,
  buildMatcher,
  collectHits,
  compareHits,
  rankSessions,
  relevanceOf,
  searchCorpusIn,
} from '../index.mjs'

const PLAIN = { caseSensitive: false, whole: false, regex: false }
const REGEX = { caseSensitive: false, whole: false, regex: true }
const INPUT = { inputs: true, outputs: false }

/** One corpus entry with one user row per [time, text]. */
function entry(rows) {
  return {
    messages: rows.map(([time, text], index) => ({ seq: index + 1, time, text })),
    outputs: [],
  }
}

/** Session ids in result order. */
function ids(sessions) {
  return sessions.map((session) => session.sessionId)
}

/** Search a private corpus. */
function search(corpus, matcher, filter = { sort: 'time' }) {
  return searchCorpusIn(corpus, matcher, new Set(), INPUT, filter)
}

test('time sort is purely the newest matching message', () => {
  const corpus = new Map([
    ['once', entry([[5000, 'needle here']])],
    ['thrice', entry([[1000, 'needle needle needle']])],
    ['twice', entry([[3000, 'needle needle']])],
  ])
  const sessions = search(corpus, buildMatcher('needle', PLAIN))
  assert.deepEqual(ids(sessions), ['once', 'twice', 'thrice'])
})

test('relevance puts more occurrences first, then the newer Session', () => {
  const corpus = new Map([
    ['once', entry([[5000, 'needle here']])],
    ['thrice', entry([[1000, 'needle needle needle']])],
    ['twice', entry([[3000, 'needle needle']])],
  ])
  const sessions = search(corpus, buildMatcher('needle', PLAIN), { sort: 'relevance' })
  assert.deepEqual(ids(sessions), ['thrice', 'twice', 'once'])
  assert.deepEqual(relevanceOf(sessions[0]), [1, 3, 1000])
})

test('relevance uses coverage first for relaxed matches', () => {
  const corpus = new Map([
    ['low-newer', entry([[5000, '炒股与界面']])],
    ['high-older', entry([[1000, '炒股股界界面']])],
  ])
  const matcher = buildApproximateMatcher('炒股界面', PLAIN)
  const sessions = search(corpus, matcher, { sort: 'relevance' })
  assert.deepEqual(ids(sessions), ['high-older', 'low-newer'])
  assert.equal(sessions[0].maxCoverage, 1)
  assert.equal(sessions[1].maxCoverage, 2 / 3)
  // Pure time order still honours the clock.
  assert.deepEqual(ids(search(corpus, matcher)), ['low-newer', 'high-older'])
})

test('the representative hit follows the requested order', () => {
  const corpus = new Map([
    ['session', entry([[1000, 'needle needle'], [5000, 'needle']])],
  ])
  // Time order opens on the newest hit; the row is not allowed to jump back.
  const [byTime] = search(corpus, buildMatcher('needle', PLAIN))
  assert.equal(byTime.best.message.time, 5000)
  // Relevance counts occurrences, so the older denser hit represents the row.
  const [byRelevance] = search(corpus, buildMatcher('needle', PLAIN), { sort: 'relevance' })
  assert.equal(byRelevance.best.message.time, 1000)
  assert.equal(byRelevance.best.occurrences, 2)
  assert.equal(byRelevance.totalOccurrences, 3)
})

test('grouped rows keep every counter before the display cap', () => {
  const rows = Array.from({ length: 8 }, (_, index) => [1000 + index, 'needle'])
  const corpus = new Map([['chatty', entry(rows)]])
  const [session] = search(corpus, buildMatcher('needle', PLAIN))
  assert.equal(session.totalHits, 8)
  assert.equal(session.hits.length, 6)
  assert.equal(session.totalOccurrences, 8)
})

test('regex mode counts occurrences for relevance', () => {
  const corpus = new Map([
    ['many', entry([[1000, 'a a a']])],
    ['few', entry([[5000, 'a']])],
  ])
  const matcher = buildMatcher('a', REGEX)
  assert.deepEqual(ids(search(corpus, matcher)), ['few', 'many'])
  assert.deepEqual(ids(search(corpus, matcher, { sort: 'relevance' })), ['many', 'few'])
})

test('hits inside one Session honour the requested order', () => {
  const corpus = new Map([['session', entry([[1000, 'needle'], [3000, 'needle needle'], [2000, 'needle']])]])
  const [session] = search(corpus, buildMatcher('needle', PLAIN))
  const timeHits = collectHits(corpus.get('session'), buildMatcher('needle', PLAIN), INPUT, 'time')
  assert.deepEqual(timeHits.map((hit) => hit.message.time), [3000, 2000, 1000])
  const relevanceHits = collectHits(corpus.get('session'), buildMatcher('needle', PLAIN), INPUT, 'relevance')
  assert.deepEqual(relevanceHits.map((hit) => hit.message.time), [3000, 2000, 1000])
})

test('compareHits orders by coverage, occurrences and time', () => {
  const make = (time, occurrences, coverage) => ({ message: { time, seq: 1 }, kind: 'input', occurrences, coverage })
  const hits = [
    make(5000, 1, 1),
    make(1000, 3, 1),
    make(3000, 2, 1),
  ]
  assert.deepEqual(hits.sort((a, b) => compareHits(a, b, 'time')).map((hit) => hit.message.time), [5000, 3000, 1000])
  assert.deepEqual(hits.sort((a, b) => compareHits(a, b, 'relevance')).map((hit) => hit.message.time), [1000, 3000, 5000])
})

test('rankSessions orders in place and breaks ties by id', () => {
  const sessions = [
    { sessionId: 'b', newestTime: 1000, maxCoverage: 1, totalOccurrences: 1 },
    { sessionId: 'a', newestTime: 1000, maxCoverage: 1, totalOccurrences: 1 },
    { sessionId: 'c', newestTime: 2000, maxCoverage: 1, totalOccurrences: 1 },
  ]
  assert.deepEqual(rankSessions(sessions, 'time').map((session) => session.sessionId), ['c', 'a', 'b'])
  assert.deepEqual(
    rankSessions(
      [
        { sessionId: 'a', newestTime: 1000, maxCoverage: 1, totalOccurrences: 1 },
        { sessionId: 'b', newestTime: 2000, maxCoverage: 1, totalOccurrences: 2 },
      ],
      'relevance',
    ).map((session) => session.sessionId),
    ['b', 'a'],
  )
})
