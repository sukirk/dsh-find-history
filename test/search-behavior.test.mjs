// Behaviour tests for the search box: what a query means, what each toggle
// does, and when the Chinese chunk retry is allowed.
//
// The reference is VS Code's search view, where it has a defined answer:
//
// - Case: off by default, `Aa` pins case.
// - Whole word (`ab`): ASCII letters, digits and underscore form a word. `pip`
//   does not match `xpip` or `pip3`, but it does match inside `用pip安装` and
//   `pip安装`, because CJK characters are not ASCII word characters (VS Code
//   has the same gap: its `\b` is ASCII-only, see microsoft/vscode#226237).
// - Whole word pins the query as one literal unit: spaces stay literal and no
//   keyword is split into pieces. The plugin's Chinese chunk retry is a
//   separate convenience feature and is deliberately unavailable while the
//   toggle is on.
// - Regex (`.*`) takes the query literally, including quotes and `!`.
//
// Two behaviours are this plugin's own syntax rather than VS Code's, and the
// tests below pin them as such: space-separated words are AND (VS Code searches
// the literal string), and `"phrase"` / `!exclusion` / `!"exclusion phrase"`
// are extensions (VS Code has no such query syntax).
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMatcher,
  chunkKeywords,
  chunkRetryPlan,
  regexQueryProblem,
  searchCorpusIn,
} from '../index.mjs'

const PLAIN = { caseSensitive: false, whole: false, regex: false }
const WHOLE = { caseSensitive: false, whole: true, regex: false }
const CASE_SENSITIVE = { caseSensitive: true, whole: false, regex: false }
const REGEX = { caseSensitive: false, whole: false, regex: true }
const INPUT = { inputs: true, outputs: false }
const OUTPUT = { inputs: false, outputs: true }

/** One corpus entry with one user row per text, oldest first. */
function entry(texts, base = 1000) {
  return {
    messages: texts.map((text, index) => ({ seq: index + 1, time: base + index, text })),
    outputs: [],
  }
}

/** Session ids in the order the search returned them. */
function ids(sessions) {
  return sessions.map((session) => session.sessionId)
}

/** Search a private corpus the way the route does. */
function search(corpus, query, flags = PLAIN, fields = INPUT) {
  const matcher = buildMatcher(query, flags)
  return searchCorpusIn(corpus, matcher, matcher.terms, new Set(), fields, { sort: 'time' })
}

/** Escape one literal keyword for the reference regular expression. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * The whole-word rule stated independently of `findWhole`: pin only the ASCII
 * edges of the keyword, so CJK edges need no boundary.
 */
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

// --------------------------------------------------------------- plain search

test('a plain query is a case-insensitive substring search', () => {
  const chinese = buildMatcher('历史搜索', PLAIN)
  assert.equal(chinese.find('会话历史搜索插件'), 2)
  assert.equal(chinese.find('没有这两个词'), -1)

  const latin = buildMatcher('PIP', PLAIN)
  assert.equal(latin.find('run pip now'), 4)
  assert.equal(buildMatcher('PIP', CASE_SENSITIVE).find('run pip now'), -1)
  assert.equal(buildMatcher('PIP', CASE_SENSITIVE).find('PIP here'), 0)
})

test('space-separated words are AND across the Session; that is plugin syntax, not VS Code literal search', () => {
  const corpus = new Map([
    ['one-message', entry(['pip and install in one line'])],
    ['two-messages', entry(['pip appears first', 'install appears later'])],
    ['only-one-word', entry(['pip appears alone'])],
    ['glued', entry(['xpip install'])],
  ])
  // VS Code would search the literal "pip install"; this plugin documents AND.
  assert.deepEqual(new Set(ids(search(corpus, 'pip install'))), new Set(['one-message', 'two-messages', 'glued']))
})

test('a quoted phrase must appear contiguously inside one message', () => {
  const corpus = new Map([
    ['same-message', entry(['run pip install now'])],
    ['split-messages', entry(['run pip', 'install now'])],
  ])
  assert.deepEqual(ids(search(corpus, '"pip install"')), ['same-message'])
})

test('a leading ! excludes the Session wherever the keyword appears', () => {
  const corpus = new Map([
    ['good', entry(['pip install the wheel'])],
    ['bad', entry(['pip install the wheel', 'transformers broke'])],
  ])
  assert.deepEqual(ids(search(corpus, 'pip install !transformers')), ['good'])
})

test('!\"phrase\" excludes the literal phrase, not its words', () => {
  const corpus = new Map([
    ['good', entry(['pip install went fine'])],
    ['bad', entry(['pip install went fine', 'quick pip install broke'])],
    ['other-order', entry(['pip install went fine', 'install then pip'])],
  ])
  assert.deepEqual(new Set(ids(search(corpus, 'pip !"quick pip install"'))), new Set(['good', 'other-order']))
})

// ------------------------------------------------------------- whole word: ASCII

test('whole word pins ASCII letters, digits and underscore only', () => {
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
    ['pip_install', 'run pip_install now', 4],
    ['搜索api', '历史搜索api文档', 2],
    ['搜索api', '历史搜索apidoc', -1],
    ['api搜索', 'xapi搜索', -1],
    ['api搜索', 'api搜索栏', 0],
  ]
  for (const [term, text, expected] of cases) {
    const matcher = buildMatcher(term, WHOLE)
    assert.equal(matcher.find(text), expected, `${term} in ${text}`)
    if (expected !== -1) assert.equal(matcher.locate(text).length, term.length)
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
    '搜索apidoc',
    'v1.2.3',
    'a.pip.b',
    'foo\npip\nbar',
    '（pip）',
    'pip安装',
    '安装pip',
    '',
  ]
  const terms = ['pip', 'pip_install', '搜索', '搜索api', 'api搜索', 'v1']
  for (const term of terms) {
    for (const caseSensitive of [false, true]) {
      const matcher = buildMatcher(term, { caseSensitive, whole: true, regex: false })
      for (const text of texts) {
        const expected = referenceIndex(text, term, caseSensitive)
        assert.equal(matcher.find(text), expected, `${term} in ${text} case=${caseSensitive}`)
      }
    }
  }
})

test('whole-word count, phrase and analyze agree with find', () => {
  const matcher = buildMatcher('历史搜索', WHOLE)
  const text = '会话历史搜索插件'
  assert.equal(matcher.find(text), 2)
  assert.equal(matcher.count(text), 1)
  assert.equal(matcher.phrase(text), true)
  assert.deepEqual(matcher.analyze(text), {
    matched: 1,
    exact: true,
    chars: 4,
    indexes: [0],
    negative: 0,
  })
})

// ------------------------------------------------------------- whole word: CJK

test('whole word leaves Chinese substrings alone but still demands them contiguous', () => {
  const matcher = buildMatcher('历史搜索', WHOLE)
  // VS Code's word boundary is ASCII, so CJK prose matches a contiguous phrase.
  assert.equal(matcher.find('会话历史搜索插件'), 2)
  assert.equal(matcher.find('关于 历史搜索 的讨论'), 3)
  // Not contiguous: a space inside the query has to exist in the text.
  assert.equal(matcher.find('历史 搜索'), -1)
  assert.equal(matcher.find('历史与搜索'), -1)
  // A shorter Chinese word keeps matching as a substring, by design.
  assert.equal(buildMatcher('搜索', WHOLE).find('搜索引擎'), 0)
})

test('whole word requires a multi-word query to appear as one contiguous phrase', () => {
  const matcher = buildMatcher('pip install', WHOLE)
  assert.equal(matcher.find('run pip install now'), 4)
  assert.equal(matcher.find('pip -V then install'), -1)
  assert.equal(matcher.find('xpip install'), -1)
  assert.equal(matcher.find('pip installs'), -1)
  assert.equal(matcher.find('pip\ninstall'), -1)
  assert.equal(matcher.find('pip  install'), -1)
  // The same rule works for Chinese words separated by a kept space.
  assert.equal(buildMatcher('历史 搜索', WHOLE).find('关于历史 搜索的讨论'), 2)
})

test('whole word applies the same boundaries to excluded words', () => {
  const matcher = buildMatcher('pip !pipenv', WHOLE)
  assert.equal(matcher.analyze('pip only').negative, 0)
  assert.equal(matcher.analyze('pip and pipenv').negative, 1)
  // pipenv glued into a longer ASCII word is not a whole word.
  assert.equal(matcher.analyze('pip and xpipenv').negative, 0)
  assert.equal(matcher.analyze('pip and 用pipenv安装').negative, 1)
})

test('whole-word mode pins a quoted phrase as one literal unit', () => {
  const matcher = buildMatcher('"pip install"', WHOLE)
  assert.equal(matcher.find('run pip install now'), 4)
  assert.equal(matcher.find('pip installer'), -1)
  assert.equal(matcher.find('xpip install'), -1)
})

// ------------------------------------------------------- the reported regression

test('whole-word mode never retries by splitting the keyword into sub-words', () => {
  const matcher = buildMatcher('这次改动', WHOLE)
  // The retry is exactly what turned 「这次 + 改动」 into a match.
  assert.equal(chunkRetryPlan(matcher, matcher.terms, WHOLE), null)

  const subWords = new Map([['sub-words', entry(['这次部署完成后，有改动才亮'])]])
  assert.deepEqual(ids(search(subWords, '这次改动', WHOLE)), [])

  const contiguous = new Map([['contiguous', entry(['这次改动把标题行切成了搜索页'])]])
  assert.deepEqual(ids(search(contiguous, '这次改动', WHOLE)), ['contiguous'])
})

test('the chunk retry is only planned for a plain single keyword', () => {
  const plain = buildMatcher('炒股界面', PLAIN)
  const plan = chunkRetryPlan(plain, plain.terms, PLAIN)
  assert.notEqual(plan, null)
  assert.deepEqual(plan.tokens, ['炒股', '界面'])
  assert.deepEqual(plan.matcher.terms, ['炒股', '界面'])

  const quoted = buildMatcher('"炒股界面"', PLAIN)
  assert.equal(chunkRetryPlan(quoted, quoted.terms, PLAIN), null)

  const excluded = buildMatcher('炒股界面 !交易', PLAIN)
  assert.equal(chunkRetryPlan(excluded, excluded.terms, PLAIN), null)

  const regex = buildMatcher('炒股界面', REGEX)
  assert.equal(chunkRetryPlan(regex, regex.terms, REGEX), null)

  const twoKeywords = buildMatcher('炒股 界面', PLAIN)
  assert.equal(chunkRetryPlan(twoKeywords, twoKeywords.terms, PLAIN), null)

  const ascii = buildMatcher('foobarbaz', PLAIN)
  assert.equal(chunkRetryPlan(ascii, ascii.terms, PLAIN), null)
})

test('chunkKeywords splits Chinese by pairs and covers the whole keyword', () => {
  assert.deepEqual(chunkKeywords('炒股界面'), ['炒股', '界面'])
  assert.deepEqual(chunkKeywords('炒股交易界面'), ['炒股', '交易', '界面'])
  // An odd tail joins the chunk before it instead of being dropped.
  assert.deepEqual(chunkKeywords('炒股界面大'), ['炒股', '界面大'])
  assert.deepEqual(chunkKeywords('这次改动很大啊'), ['这次', '改动', '很大啊'])
  // Mixed scripts split where the script changes.
  assert.deepEqual(chunkKeywords('炒股api界面'), ['炒股', 'api', '界面'])
  // Nothing to split: too short, one script run, or no Chinese at all.
  assert.equal(chunkKeywords('abc'), null)
  assert.equal(chunkKeywords('foobarbaz'), null)
  for (const token of ['炒股界面', '历史搜索插件', '这次改动很大啊', '一二三四五六七八九十']) {
    assert.equal(chunkKeywords(token).join(''), token)
  }
})

test('the fallback answers only when one message carries every chunk', () => {
  const corpus = new Map([
    ['one-message', entry(['炒股交易界面怎么调'])],
    ['scattered', entry(['先炒股', '再看交易界面'])],
  ])
  const matcher = buildMatcher('炒股界面', PLAIN)
  assert.equal(searchCorpusIn(corpus, matcher, matcher.terms, new Set(), INPUT, { sort: 'time' }).length, 0)

  const plan = chunkRetryPlan(matcher, matcher.terms, PLAIN)
  const retried = searchCorpusIn(
    corpus,
    plan.matcher,
    plan.tokens,
    new Set(),
    INPUT,
    { sort: 'time' },
  ).filter((session) => session.maxMatched === plan.tokens.length)
  assert.deepEqual(ids(retried), ['one-message'])
})

// --------------------------------------------------------------------- regex

test('regex mode takes the query literally, without quote or exclusion syntax', () => {
  const matcher = buildMatcher('a "b"', REGEX)
  assert.deepEqual(matcher.terms, ['a "b"'])
  assert.notEqual(matcher.find('x a "b" y'), -1)
  assert.equal(matcher.find('a b'), -1)
})

test('regex whole-word uses the same ASCII boundaries', () => {
  const matcher = buildMatcher('pip|install', { caseSensitive: false, whole: true, regex: true })
  assert.equal(matcher.find('run pip now'), 4)
  assert.equal(matcher.find('xpip'), -1)
  assert.notEqual(matcher.find('用pip安装'), -1)
  assert.equal(matcher.find('pip3'), -1)
})

test('regex only scans the opening part of one message', () => {
  const matcher = buildMatcher('needle', REGEX)
  assert.equal(matcher.find(`needle${'x'.repeat(80)}`), 0)
  assert.equal(matcher.find(`${'x'.repeat(4_100)}needle`), -1)
})

test('unsafe and over-long regular expressions are refused', () => {
  assert.equal(regexQueryProblem('(a+)+$'), 'unsafe-regex')
  assert.equal(regexQueryProblem('(a|ab)+'), 'unsafe-regex')
  assert.equal(regexQueryProblem('a**'), 'unsafe-regex')
  assert.equal(regexQueryProblem('x'.repeat(121)), 'query-too-long')
  assert.equal(regexQueryProblem('pip|install'), null)
  assert.equal(regexQueryProblem('a{2,3}'), null)
  assert.equal(regexQueryProblem('x'.repeat(120)), null)
  // A pattern that is safe by shape but does not compile.
  assert.equal(buildMatcher('(', REGEX), null)
})

// ------------------------------------------------------------ corpus mechanics

test('the corpus search honours text pools, time bounds and skipped Sessions', () => {
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

  assert.deepEqual(ids(searchCorpusIn(corpus, install, install.terms, new Set(), INPUT, { sort: 'time' })), [])
  assert.deepEqual(ids(searchCorpusIn(corpus, install, install.terms, new Set(), OUTPUT, { sort: 'time' })), ['session-a'])

  assert.deepEqual(ids(searchCorpusIn(corpus, pip, pip.terms, new Set(), INPUT, { sort: 'time', since: 3000 })), ['session-b'])
  assert.deepEqual(ids(searchCorpusIn(corpus, pip, pip.terms, new Set(), INPUT, { sort: 'time', until: 3000 })), ['session-a'])

  // Archived Sessions are skipped by id.
  assert.deepEqual(ids(searchCorpusIn(corpus, pip, pip.terms, new Set(['session-a']), INPUT, { sort: 'time' })), ['session-b'])
})

test('a Session needs every keyword before it ranks, across messages', () => {
  const corpus = new Map([
    ['complete', entry(['pip first', 'install second'])],
    ['partial', entry(['pip only here'])],
  ])
  const sessions = search(corpus, 'pip install')
  assert.deepEqual(ids(sessions), ['complete'])
})
