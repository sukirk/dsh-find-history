// The search box follows VS Code's search view: the typed text is one literal
// search string. Spaces, quotes, `!` and punctuation are data; the toggles only
// change case folding, ASCII word boundaries, and whether the text is a
// regular expression. When nothing matches exactly, the Host relaxes to n-gram
// coverage and marks the answer as approximate.
//
// The one deliberate deviation from a browser-side `\b`: a Chinese edge is not
// a word edge. VS Code's `\b` is ASCII-only in practice (microsoft/vscode#226237),
// so a Chinese query inside Chinese prose still matches.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildApproximateMatcher,
  buildMatcher,
  queryUnits,
  regexQueryProblem,
  scanUnits,
  searchCorpusIn,
  searchWithRelaxation,
} from '../index.mjs'

const PLAIN = { caseSensitive: false, whole: false, regex: false }
const WHOLE = { caseSensitive: false, whole: true, regex: false }
const CASE_SENSITIVE = { caseSensitive: true, whole: false, regex: false }
const REGEX = { caseSensitive: false, whole: false, regex: true }
const INPUT = { inputs: true, outputs: false }

/** One corpus entry with one user row per text, oldest first. */
function entry(texts, base = 1000) {
  return {
    messages: texts.map((text, index) => ({ seq: index + 1, time: base + index, text })),
    outputs: [],
  }
}

/** Session ids in result order. */
function ids(sessions) {
  return sessions.map((session) => session.sessionId)
}

/** Escape one literal keyword for the reference regular expression. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** The literal search rule stated independently of `findWholeFrom`. */
function referenceIndex(text, term, caseSensitive) {
  const haystack = caseSensitive === true ? text : text.toLowerCase()
  const needle = caseSensitive === true ? term : term.toLowerCase()
  const pinStart = /[a-z0-9_]/i.test(needle.charAt(0))
  const pinEnd = /[a-z0-9_]/i.test(needle.charAt(needle.length - 1))
  const pattern =
    (pinStart ? '(?<![A-Za-z0-9_])' : '') +
    escapeRegExp(needle) +
    (pinEnd ? '(?![A-Za-z0-9_])' : '')
  const found = new RegExp(pattern, caseSensitive === true ? 'u' : 'iu').exec(haystack)
  return found === null ? -1 : found.index
}

// ------------------------------------------------------------------- literal

test('the whole typed string is one literal search', () => {
  const phrase = buildMatcher('pip install', PLAIN)
  assert.equal(phrase.locate('run pip install now').index, 4)
  // A space is a literal space, not an AND between two words.
  assert.equal(phrase.locate('pip appears, install later').index, -1)
  // Punctuation, quotes and `!` are data, exactly as typed.
  const punctuation = buildMatcher('"a" !b', PLAIN)
  assert.equal(punctuation.locate('x "a" !b y').index, 2)
  assert.equal(punctuation.locate('x a b y').index, -1)
})

test('case folding is the only thing the Aa toggle changes', () => {
  assert.notEqual(buildMatcher('PIP', PLAIN).locate('run pip now').index, -1)
  assert.equal(buildMatcher('PIP', CASE_SENSITIVE).locate('run pip now').index, -1)
  assert.equal(buildMatcher('PIP', CASE_SENSITIVE).locate('run PIP now').index, 4)
})

test('the literal matcher counts every non-overlapping occurrence', () => {
  const matcher = buildMatcher('ha', PLAIN)
  assert.equal(matcher.count('ha haha'), 3)
  assert.equal(matcher.count('nothing'), 0)
  assert.deepEqual(matcher.match('x ha ha', false), { index: 2, length: 2, occurrences: 1, coverage: 1 })
  assert.equal(matcher.match('x ha ha', true).occurrences, 2)
})

// -------------------------------------------------------------- whole word

test('whole word pins ASCII edges only', () => {
  const cases = [
    ['pip', 'pip', 0],
    ['pip', 'run pip now', 4],
    ['pip', 'xpip', -1],
    ['pip', 'pip3', -1],
    ['pip', 'pip_api', -1],
    ['pip', '_pip', -1],
    ['pip', '用pip安装', 1],
    ['pip', 'pip安装', 0],
    ['pip', '安装pip', 2],
    ['pip', 'pip-安装', 0],
    ['pip_install', 'pip_installer', -1],
    ['搜索api', '历史搜索api文档', 2],
    ['搜索api', '历史搜索apidoc', -1],
    ['api搜索', 'xapi搜索', -1],
  ]
  for (const [term, text, expected] of cases) {
    assert.equal(buildMatcher(term, WHOLE).locate(text).index, expected, `${term} in ${text}`)
  }
})

test('whole-word find agrees with an independent ASCII-boundary reference', () => {
  const texts = [
    'pip',
    'run pip now',
    'xpip',
    'pips',
    'pip3',
    'pip_api',
    '_pip',
    'pip-安装',
    '用pip安装',
    'PIP UP TOP',
    'pip_install here',
    'xpip_install',
    '历史搜索',
    '会话历史搜索插件',
    '搜索api文档',
    'v1.2.3',
    'a.pip.b',
    'foo\npip\nbar',
    '（pip）',
    '',
  ]
  const terms = ['pip', 'pip_install', '搜索', '搜索api', 'api搜索', 'v1']
  for (const term of terms) {
    for (const caseSensitive of [false, true]) {
      const matcher = buildMatcher(term, { caseSensitive, whole: true, regex: false })
      for (const text of texts) {
        assert.equal(
          matcher.locate(text).index,
          referenceIndex(text, term, caseSensitive),
          `${term} in ${text} case=${caseSensitive}`,
        )
      }
    }
  }
})

test('whole word leaves Chinese substrings alone but keeps the phrase contiguous', () => {
  assert.equal(buildMatcher('历史搜索', WHOLE).locate('会话历史搜索插件').index, 2)
  assert.equal(buildMatcher('历史搜索', WHOLE).locate('历史 搜索').index, -1)
  // A multi-word query is still one literal phrase; CJK edges need no boundary.
  assert.equal(buildMatcher('pip install', WHOLE).locate('run pip install now').index, 4)
  assert.equal(buildMatcher('pip install', WHOLE).locate('xpip install').index, -1)
  assert.equal(buildMatcher('pip install', WHOLE).locate('pip installs').index, -1)
})

// --------------------------------------------------------------------- regex

test('regex mode searches the full message text', () => {
  const matcher = buildMatcher('needle', REGEX)
  assert.equal(matcher.locate(`needle${'x'.repeat(80)}`).index, 0)
  // The old 4000-character clip is gone: a match far into a pasted message counts.
  assert.equal(matcher.locate(`${'x'.repeat(5_000)}needle`).index, 5_000)
})

test('regex whole word uses the same ASCII boundaries', () => {
  const matcher = buildMatcher('pip|install', { caseSensitive: false, whole: true, regex: true })
  assert.equal(matcher.locate('run pip now').index, 4)
  assert.equal(matcher.locate('xpip').index, -1)
  assert.notEqual(matcher.locate('用pip安装').index, -1)
  assert.equal(matcher.locate('pip3').index, -1)
})

test('unsafe and over-long regular expressions are refused', () => {
  assert.equal(regexQueryProblem('(a+)+$'), 'unsafe-regex')
  assert.equal(regexQueryProblem('(a|ab)+'), 'unsafe-regex')
  assert.equal(regexQueryProblem('a**'), 'unsafe-regex')
  assert.equal(regexQueryProblem('x'.repeat(121)), 'query-too-long')
  assert.equal(regexQueryProblem('pip|install'), null)
  assert.equal(buildMatcher('(', REGEX), null)
})

// ------------------------------------------------------------- relaxed search

test('query units are overlapping CJK pairs and Latin words', () => {
  assert.deepEqual(queryUnits('历史搜索', false), ['历史', '史搜', '搜索'])
  assert.deepEqual(queryUnits('炒股界面', false), ['炒股', '股界', '界面'])
  assert.deepEqual(queryUnits('炒股界面大', false), ['炒股', '股界', '界面', '面大'])
  assert.deepEqual(queryUnits('历史 搜索', false), ['历史', '搜索'])
  assert.deepEqual(queryUnits('alpha 历史', false), ['alpha', '历史'])
  // One unit is the exact query itself; there is nothing to relax.
  assert.equal(queryUnits('历史', false), null)
  assert.equal(queryUnits('alpha', false), null)
})

test('the relaxed match is a coverage threshold, not a fixed split', () => {
  const matcher = buildApproximateMatcher('这次改动', PLAIN)
  // 这次 and 改动 are present, 次改 is not: 2/3 passes.
  const scattered = matcher.match('这次部署，有改动才亮')
  assert.equal(scattered.coverage, 2 / 3)
  assert.equal(scattered.occurrences, 2)
  // Only one of the three units: below the threshold.
  assert.equal(matcher.match('这次部署完成'), null)
  // A five-character keyword has four units; dropping the tail is not special.
  const five = buildApproximateMatcher('炒股界面大', PLAIN)
  assert.equal(five.match('炒股交易界面大').coverage, 3 / 4)
  assert.equal(five.match('炒股交易界面'), null)
})

test('a two-word query must carry both words in one message', () => {
  const matcher = buildApproximateMatcher('alpha 工具', PLAIN)
  assert.equal(matcher.match('alpha and 工具').coverage, 1)
  assert.equal(matcher.match('alpha only'), null)
  assert.equal(matcher.match('工具 only'), null)
})

test('relaxation starts only when the exact search has no answer', () => {
  const corpus = new Map([
    ['exact', entry(['这次改动完成了'])],
    ['scattered', entry(['这次部署，有改动才亮'])],
  ])
  const exact = searchWithRelaxation(corpus, '这次改动', PLAIN, new Set(), INPUT, { sort: 'time' })
  assert.equal(exact.matcher.mode, 'exact')
  assert.deepEqual(ids(exact.sessions), ['exact'])

  const onlyScattered = new Map([['scattered', entry(['这次部署，有改动才亮'])]])
  const relaxed = searchWithRelaxation(onlyScattered, '这次改动', PLAIN, new Set(), INPUT, { sort: 'time' })
  assert.equal(relaxed.matcher.mode, 'approximate')
  assert.deepEqual(ids(relaxed.sessions), ['scattered'])
  assert.equal(relaxed.sessions[0].maxCoverage, 2 / 3)
})

test('whole word and regex never relax', () => {
  const corpus = new Map([['scattered', entry(['这次部署，有改动才亮'])]])
  const whole = searchWithRelaxation(corpus, '这次改动', WHOLE, new Set(), INPUT, { sort: 'time' })
  assert.equal(whole.matcher.mode, 'exact')
  assert.deepEqual(ids(whole.sessions), [])
  const regex = searchWithRelaxation(corpus, '这次改动', REGEX, new Set(), INPUT, { sort: 'time' })
  assert.equal(regex.matcher.mode, 'regex')
  assert.deepEqual(ids(regex.sessions), [])
})

test('scanUnits reports coverage and the longest matched unit', () => {
  const wanted = new Set(['这次', '次改', '改动'])
  const measured = scanUnits('这次部署，有改动才亮', wanted, false)
  assert.equal(measured.matched, 2)
  assert.equal(measured.coverage, 2 / 3)
  assert.equal(measured.length, 2)
  assert.equal(measured.index, 0)
})

// -------------------------------------------------------------------- corpus

test('the corpus search honours pools, time bounds and skipped Sessions', () => {
  const corpus = new Map([
    [
      'session-a',
      {
        messages: [{ seq: 1, time: 1000, text: 'pip in the input' }],
        outputs: [{ seq: 2, time: 2000, text: 'install in the answer' }],
      },
    ],
    ['session-b', entry(['pip in a newer input'], 5000)],
  ])
  const pip = buildMatcher('pip', PLAIN)
  const install = buildMatcher('install', PLAIN)
  assert.deepEqual(ids(searchCorpusIn(corpus, install, new Set(), INPUT, { sort: 'time' })), [])
  assert.deepEqual(
    ids(searchCorpusIn(corpus, install, new Set(), { inputs: false, outputs: true }, { sort: 'time' })),
    ['session-a'],
  )
  assert.deepEqual(
    ids(searchCorpusIn(corpus, pip, new Set(), INPUT, { sort: 'time', since: 3000 })),
    ['session-b'],
  )
  assert.deepEqual(
    ids(searchCorpusIn(corpus, pip, new Set(), INPUT, { sort: 'time', until: 3000 })),
    ['session-a'],
  )
  assert.deepEqual(
    ids(searchCorpusIn(corpus, pip, new Set(['session-a']), INPUT, { sort: 'time' })),
    ['session-b'],
  )
})
