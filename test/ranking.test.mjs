// Ranking tests for the two sort orders.
//
// The Host answers two questions: which Sessions contain the words the user
// typed, and in what order. `time` is purely chronological. `relevance` first
// compares how many query characters one message covers -- a phrase covers all
// of them, a scattered word only its own letters -- and breaks ties by time.
// Repetition never adds up, so six `install` rows cannot outrank one
// `pip install` row. These tests pin that down without starting a Harness.
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

test('the phrase follows VS Code literal search: one contiguous string', () => {
  const matcher = buildMatcher('pip install', FLAGS)
  assert.equal(matcher.phrase('run pip install transformers'), true)
  // VS Code's plain search does not match a line break or a second space for
  // the space in the query, and it happily matches inside a longer word.
  assert.equal(matcher.phrase('run pip\ninstall transformers'), false)
  assert.equal(matcher.phrase('run pip  install transformers'), false)
  assert.equal(matcher.phrase('pip, then install'), false)
  assert.equal(matcher.phrase('pip installer'), true)
})

test('whole word only adds boundaries around the phrase ends', () => {
  const wholeMatcher = buildMatcher('pip install', WHOLE_FLAGS)
  assert.equal(wholeMatcher.phrase('x pip install y'), true)
  assert.equal(wholeMatcher.phrase('pip installs here'), false)
  assert.equal(wholeMatcher.phrase('pip installer'), false)
  assert.equal(wholeMatcher.phrase('run pip\ninstall transformers'), false)
  assert.equal(wholeMatcher.phrase('piper installs things'), false)
})

test('a typed double space is part of the phrase', () => {
  const matcher = buildMatcher('pip  install', FLAGS)
  assert.equal(matcher.phrase('pip install'), false)
  assert.equal(matcher.phrase('pip  install'), true)
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

test('phrase matches tie on characters, so the newer Session leads', () => {
  const corpus = new Map([
    ['session-one', entry(['pip install transformers'])],
    [
      'session-two',
      entry(['pip install transformers today', 'again pip install transformers', 'still pip install transformers']),
    ],
  ])
  // Both cover 24 characters; repetition adds nothing, so time decides.
  assert.deepEqual(ids(search(corpus, 'pip install transformers', 'relevance')), ['session-two', 'session-one'])
})

test('messages with every word rank above messages with one word', () => {
  const corpus = new Map([
    ['session-partial', entry(['install only lives here'])],
    ['session-words', entry(['pip and install, far apart'])],
  ])
  // 3 + 7 characters covered beats 7, even though both are two-row matches.
  assert.deepEqual(ids(search(corpus, 'pip install', 'relevance')), ['session-words', 'session-partial'])
})

test('time order is purely chronological, relevance order is not', () => {
  const corpus = new Map([
    ['session-phrase', entry(['old note: pip install transformers'], 500)],
    ['session-words', entry(['newer note about pip, install and transformers'], 1500)],
  ])
  // Pure time: the newer Session leads even though it only scatters the words.
  assert.deepEqual(ids(search(corpus, 'pip install transformers', 'time')), ['session-words', 'session-phrase'])
  // Relevance: 24 covered characters beat 22, no matter which Session is newer.
  assert.deepEqual(ids(search(corpus, 'pip install transformers', 'relevance')), [
    'session-phrase',
    'session-words',
  ])
})

test('one-word query stays a plain substring search', () => {
  const corpus = new Map([
    ['session-a', entry(['pip'])],
    ['session-b', entry(['pip here', 'pip there'])],
  ])
  assert.deepEqual(ids(search(corpus, 'pip', 'relevance')), ['session-b', 'session-a'])
})

test('rows inside one Session follow the requested order', () => {
  const entryRows = entry(['transformers later, then pip, then install', 'pip install transformers'])
  const matcher = buildMatcher('pip install transformers', FLAGS)
  const byTime = collectHits(entryRows, matcher, { inputs: true, outputs: false }, 'time')
  assert.equal(byTime[0].message.text, 'pip install transformers')
  const byRelevance = collectHits(entryRows, matcher, { inputs: true, outputs: false }, 'relevance')
  assert.equal(byRelevance[0].exact, true)
  assert.equal(byRelevance[0].message.text, 'pip install transformers')
})

test('compareHits compares covered characters, then time', () => {
  const matcher = buildMatcher('pip install transformers', FLAGS)
  const row = (text, time) => ({ seq: time, time, text, lower: text.toLowerCase() })
  const hit = (text, time, kind = 'input') => {
    const quality = matcher.analyze(text)
    return { message: row(text, time), kind, matched: quality.matched, exact: quality.exact, chars: quality.chars }
  }
  const exact = hit('pip install transformers', 10)
  const words = hit('pip and install and transformers', 99)
  // 24 covered characters beat 22 even though the scattered row is newer.
  assert.equal(compareHits(exact, words, 'relevance') < 0, true)
  assert.equal(compareHits(words, exact, 'relevance') > 0, true)
  // Pure time ignores the quality of the row.
  assert.equal(compareHits(exact, words, 'time') > 0, true)
  assert.equal(compareHits(words, exact, 'time') < 0, true)
})

test('relevanceOf is characters covered first, newest match second', () => {
  const phrase = { maxChars: 24, newestTime: 10 }
  const noise = { maxChars: 10, newestTime: 99 }
  assert.deepEqual(relevanceOf(phrase), [24, 10])
  assert.deepEqual(relevanceOf(noise), [10, 99])
  assert.deepEqual(rankSessions([noise, phrase], 'relevance'), [phrase, noise])
  // Equal coverage falls back to the newest match.
  const newerNoise = { maxChars: 10, newestTime: 120 }
  assert.deepEqual(rankSessions([noise, newerNoise], 'relevance'), [newerNoise, noise])
})
