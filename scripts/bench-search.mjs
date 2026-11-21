// Synthetic benchmark for the search core: 200 Sessions × 100 messages.
// Run with `node scripts/bench-search.mjs`; pass a baseline module path
// (e.g. a 1.6.0 index.mjs) to compare both implementations on the same corpus.
import { pathToFileURL } from 'node:url'
import * as current from '../index.mjs'

const baselinePath = process.argv[2]
const baseline = baselinePath === undefined ? null : await import(pathToFileURL(baselinePath).href)

const TEXTS = [
  'search history for the release notes and the error handling',
  '这次改动把侧栏搜索框放到工作区标题行并且修好了整词匹配',
  'alpha 历史搜索 工具 pip install the wheel',
  'no keyword here at all, just prose',
  'unrelated content about tea and weather',
]
const corpus = new Map()
for (let session = 0; session < 200; session += 1) {
  const messages = []
  for (let index = 0; index < 100; index += 1) {
    const base = TEXTS[(session + index) % TEXTS.length]
    messages.push({
      seq: index + 1,
      time: 1_000_000 + session * 1000 + index,
      text: `${base} #${session}/${index}`,
    })
  }
  corpus.set(`s${session}`, { messages, outputs: [] })
}
const FIELDS = { inputs: true, outputs: false }
const SKIP = new Set()
const CASES = [
  ['error', false, false, 'time'],
  ['search history', false, false, 'time'],
  ['历史搜索', false, false, 'time'],
  ['alpha 历史搜索', false, false, 'time'],
  ['nothing-matches-this', false, false, 'time'],
  ['error', true, false, 'time'],
  ['err(or|ing)', false, true, 'time'],
  ['error', false, false, 'relevance'],
  ['历史搜索', false, false, 'relevance'],
]

/** Median of `rounds` runs after warm-up. */
function measure(fn, rounds = 12) {
  for (let warm = 0; warm < 3; warm += 1) fn()
  const times = []
  for (let index = 0; index < rounds; index += 1) {
    const start = process.hrtime.bigint()
    fn()
    times.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  times.sort((left, right) => left - right)
  return times[Math.floor(times.length / 2)]
}

/** Run one module; the 1.6 API also takes the matcher's terms. */
function run(module, query, whole, regex, sort) {
  const matcher = module.buildMatcher(query, { caseSensitive: false, whole, regex })
  return module === current
    ? module.searchCorpusIn(corpus, matcher, SKIP, FIELDS, { sort })
    : module.searchCorpusIn(corpus, matcher, matcher.terms, SKIP, FIELDS, { sort })
}

let currentTotal = 0
let baselineTotal = 0
for (const [query, whole, regex, sort] of CASES) {
  const currentMs = measure(() => run(current, query, whole, regex, sort))
  const baselineMs = baseline === null ? null : measure(() => run(baseline, query, whole, regex, sort))
  currentTotal += currentMs
  if (baselineMs !== null) baselineTotal += baselineMs
  const ratio = baselineMs === null ? '' : `  baseline ${baselineMs.toFixed(2)}ms (${(currentMs / baselineMs).toFixed(2)}×)`
  console.log(`${query.padEnd(22)} sort=${sort.padEnd(9)} whole=${whole ? 'y' : 'n'} regex=${regex ? 'y' : 'n'}  ${currentMs.toFixed(2)}ms${ratio}`)
}
if (baseline !== null) {
  console.log(`TOTAL ${currentTotal.toFixed(2)}ms vs ${baselineTotal.toFixed(2)}ms (${(currentTotal / baselineTotal).toFixed(2)}×)`)
}
