// Ranking tests for the phrase-first ordering added in this branch.
//
// The Host answers two questions: which Sessions contain the words the user
// typed, and in what order. A multi-word query such as `pip install
// transformers` matches both Sessions that quote the phrase and Sessions that
// only scatter its words; the phrase has to win. These tests pin that down
// without starting a Harness.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMatcher,
  collectHits,
  compareHits,
  rankSessions,
  relevanceOf,
  searchCorpusIn,
} from '../index.mjs'

const MATCHER_FLAGS = { caseSensitive: false, whole: false, regex: false }

/** One corpus entry with one user row per text, oldest first. */
function entry(texts, base = 1000) {
  return {
    messages: texts.map((text, index) => ({
      seq: index + 1,
      time: base + index,
      text,
      lower: text.toLowerCase(),
    })),
    outputs: [],
  }
}

/** Session ids in the order the search returned them. */
function ids(sessions) {
  return sessions.map((session) => session.sessionId)
}

/** Search a private corpus with the same arguments the route uses. */
function search(corpus, query, sort) {
  const matcher = buildMatcher(query, MATCHER_FLAGS)
  return searchCorpusIn(corpus, matcher, matcher.terms, new Set(), { inputs: true, outputs: false }, { sort })
}

test('quoted phrase outranks a Session that repeats the same words separately', () => {
  const corpus = new Map([
    ['session-phrase', entry(['please pip install transformers on the box'])],
    [
      'session-words',
      entry([
        'pip and install and transformers are three different words',
        'pip install is not the phrase here',
        'install transformers separately another day',
      ]),
    ],
  ])
  assert.deepEqual(ids(search(corpus, 'pip install transformers', 'relevance')), [
    'session-phrase',
    'session-words',
  ])
})

test('single words of the query still rank below the phrase, above partial matches', () => {
  const corpus = new Map([
    ['session-phrase', entry(['run pip install transformers now'])],
    ['session-words', entry(['pip and install and transformers'])],
    ['session-partial', entry(['pip only lives here'])],
  ])
  assert.deepEqual(ids(search(corpus, 'pip install transformers', 'relevance')), [
    'session-phrase',
    'session-words',
    'session-partial',
  ])
})

test('relevance keeps the heavier phrase match when both Sessions quote the phrase', () => {
  const corpus = new Map([
    ['session-one', entry(['pip install transformers'])],
    [
      'session-two',
      entry([
        'pip install transformers today',
        'again pip install transformers',
        'still pip install transformers',
      ]),
    ],
  ])
  assert.deepEqual(ids(search(corpus, 'pip install transformers', 'relevance')), [
    'session-two',
    'session-one',
  ])
})

test('time order is untouched by the phrase tier', () => {
  const corpus = new Map([
    ['session-phrase', entry(['old note: pip install transformers'], 500)],
    ['session-words', entry(['newer note about pip, install and transformers'], 1500)],
  ])
  // The phrase Session is older here; time order must still put it last.
  assert.deepEqual(ids(search(corpus, 'pip install transformers', 'time')), [
    'session-words',
    'session-phrase',
  ])
})

test('one-word query stays a plain substring search', () => {
  const corpus = new Map([
    ['session-a', entry(['pip'])],
    ['session-b', entry(['pip here', 'pip there'])],
  ])
  assert.deepEqual(ids(search(corpus, 'pip', 'relevance')), ['session-b', 'session-a'])
})

test('phrase hits lead the rows kept for one Session', () => {
  const hits = collectHits(
    entry([
      'transformers later, then pip, then install',
      'pip install transformers',
    ]),
    buildMatcher('pip install transformers', MATCHER_FLAGS),
    { inputs: true, outputs: false },
  )
  assert.equal(hits[0].exact, true)
  assert.equal(hits[0].message.text, 'pip install transformers')
})

test('compareHits prefers the whole phrase before a heavier keyword count', () => {
  const matcher = buildMatcher('pip install transformers', MATCHER_FLAGS)
  const row = (text, time) => ({ seq: time, time, text, lower: text.toLowerCase() })
  const exact = {
    message: row('pip install transformers', 10),
    kind: 'input',
    matched: matcher.count('pip install transformers'),
    exact: true,
  }
  const words = {
    message: row('pip and install and transformers', 99),
    kind: 'input',
    matched: matcher.count('pip and install and transformers'),
    exact: false,
  }
  assert.equal(compareHits(exact, words) < 0, true)
  assert.equal(compareHits(words, exact) > 0, true)
})

test('relevanceOf weights the phrase above repeated keyword noise', () => {
  const session = {
    hits: [
      { matched: 3, exact: true },
      { matched: 2, exact: false },
    ],
  }
  const wordsOnly = {
    hits: [
      { matched: 3, exact: false },
      { matched: 3, exact: false },
      { matched: 3, exact: false },
    ],
  }
  assert.equal(relevanceOf(session) > relevanceOf(wordsOnly), true)
  assert.deepEqual(rankSessions([wordsOnly, session], 'relevance'), [session, wordsOnly])
})

test('whole-word mode still ranks the adjacent phrase above scattered words', () => {
  const flags = { caseSensitive: false, whole: true, regex: false }
  const matcher = buildMatcher('pip install transformers', flags)
  assert.equal(matcher.phrase('just run pip install transformers and restart'), true)
  assert.equal(matcher.phrase('pip broke after the install script; transformers later'), false)
})
