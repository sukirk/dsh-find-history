// Ranking tests for the phrase-first ordering.
//
// The Host answers two questions: which Sessions contain the words the user
// typed, and in what order. The order compares match quality lexicographically:
// a message that quotes the phrase beats a message that only scatters its
// words, and no amount of scattered-word repetition may climb above the phrase.
// These tests pin that down without starting a Harness.
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

const FLAGS = { caseSensitive: false, whole: false, regex: false }
const WHOLE_FLAGS = { caseSensitive: false, whole: true, regex: false }

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
function search(corpus, query, sort, flags = FLAGS) {
  const matcher = buildMatcher(query, flags)
  return searchCorpusIn(corpus, matcher, matcher.terms, new Set(), { inputs: true, outputs: false }, { sort })
}

test('a single "pip install" outranks a Session that repeats "install" alone', () => {
  const corpus = new Map([
    ['session-phrase', entry(['first run pip install transformers'])],
    [
      'session-install',
      entry([
        'install the wheel',
        'install the runtime',
        'install the CLI',
        'install the plugin',
        'install the docs',
        'install the desktop app',
      ]),
    ],
  ])
  assert.deepEqual(ids(search(corpus, 'pip install', 'relevance')), ['session-phrase', 'session-install'])
})

test('scattered words never enter the phrase tier, even in whole-word mode', () => {
  const corpus = new Map([
    // Old whole-word mode counted this as the phrase because both words are here.
    ['session-scattered', entry(['pip broke after the install script, so reinstall'])],
    ['session-phrase', entry(['pip install is the command to run'])],
  ])
  const matcher = buildMatcher('pip install', WHOLE_FLAGS)
  assert.equal(matcher.phrase('pip broke after the install script, so reinstall'), false)
  assert.deepEqual(ids(search(corpus, 'pip install', 'relevance', WHOLE_FLAGS)), [
    'session-phrase',
    'session-scattered',
  ])
})

test('the phrase may be spread over a line break or extra spaces', () => {
  const matcher = buildMatcher('pip install', FLAGS)
  assert.equal(matcher.phrase('run pip\ninstall transformers'), true)
  assert.equal(matcher.phrase('run pip  install transformers'), true)
  assert.equal(matcher.phrase('pip, then install'), false)
  const wholeMatcher = buildMatcher('pip install', WHOLE_FLAGS)
  assert.equal(wholeMatcher.phrase('run pip\ninstall transformers'), true)
  assert.equal(wholeMatcher.phrase('piper installs things'), false)
})

test('a phrase wins over any number of scattered all-word messages', () => {
  const corpus = new Map([
    ['session-phrase', entry(['one pip install only'])],
    [
      'session-all-words',
      entry([
        'pip here, install there',
        'pip again, install again',
        'install now, pip later',
        'pip pip pip, install install install',
      ]),
    ],
  ])
  assert.deepEqual(ids(search(corpus, 'pip install', 'relevance')), ['session-phrase', 'session-all-words'])
})

test('more phrase messages rank higher than one phrase message', () => {
  const corpus = new Map([
    ['session-one', entry(['pip install transformers'])],
    [
      'session-two',
      entry(['pip install transformers today', 'again pip install transformers', 'still pip install transformers']),
    ],
  ])
  assert.deepEqual(ids(search(corpus, 'pip install transformers', 'relevance')), ['session-two', 'session-one'])
})

test('messages with every word rank above messages with one word', () => {
  const corpus = new Map([
    ['session-partial', entry(['install only lives here'])],
    ['session-words', entry(['pip and install, far apart'])],
  ])
  assert.deepEqual(ids(search(corpus, 'pip install', 'relevance')), ['session-words', 'session-partial'])
})

test('time order is untouched by the relevance tiers', () => {
  const corpus = new Map([
    ['session-phrase', entry(['old note: pip install transformers'], 500)],
    ['session-words', entry(['newer note about pip, install and transformers'], 1500)],
  ])
  assert.deepEqual(ids(search(corpus, 'pip install transformers', 'time')), ['session-words', 'session-phrase'])
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
    entry(['transformers later, then pip, then install', 'pip install transformers']),
    buildMatcher('pip install transformers', FLAGS),
    { inputs: true, outputs: false },
  )
  assert.equal(hits[0].exact, true)
  assert.equal(hits[0].message.text, 'pip install transformers')
})

test('compareHits prefers the whole phrase before a heavier keyword count', () => {
  const matcher = buildMatcher('pip install transformers', FLAGS)
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

test('relevanceOf is an ordered tuple, not a sum of noise', () => {
  const phrase = { phraseCount: 1, allWordsCount: 0, maxMatched: 2 }
  const noise = { phraseCount: 0, allWordsCount: 6, maxMatched: 2 }
  assert.deepEqual(relevanceOf(phrase), [2, 1, 0, 2])
  assert.deepEqual(relevanceOf(noise), [1, 0, 6, 2])
  assert.deepEqual(rankSessions([noise, phrase], 'relevance'), [phrase, noise])
})
