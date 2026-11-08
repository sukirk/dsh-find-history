# Changelog

## 1.4.0 — 2026-11-08

- 多关键词改成 VS Code 的 AND 语义：空格分隔的每个词都必须出现在同一会话里，可以分散在不同消息；只命中其中一个词的结果不再混进来（`pip install` 不再返回只提到 `pip` 的会话）。
- 新增 VS Code 查询语法：`"pip install"` 引号内是字面连续短语（空格原样保留）；`!transformers` 排除含该词的会话，`!"quick pip install"` 排除含该短语的会话。
- 整词匹配对正则表达式也生效（把整个模式包进词边界），与 VS Code 的 `ab` 开关一致。
- 高亮词表去掉引号、`!` 前缀等语法字符；整句徽标按「正词部分连续出现」判定。
- 文档与测试同步：新增 AND、引号短语、排除、正则+整词、重复空格等用例，`node --test test/ranking.test.mjs` 18/18。

## 1.3.1 — 2026-11-08

- 排序改成真正的「按时间」和「按相关度」，不再用同样的字典序前缀把匹配质量插进时间排序。
- 按时间：只按时间。会话之间按各自最新命中的消息排序，会话内的命中消息也从新到旧；整句、字数、关键词命中数都不再参与。
- 按相关度：先比一条消息覆盖了多少查询字符（整句覆盖全部字符，散开的词只算各自字母，同一子词重复命中不累加），覆盖一样多再按时间。
- 新增排序规则测试：纯时间顺序、字符覆盖优先、同覆盖按时间、会话内行顺序、`compareHits` 双模式；`node --test test/ranking.test.mjs` 13/13。

## 1.3.0 — 2026-11-08

- 整句判定改为 VS Code 字面搜索语义：整句是「你输入的一整段连续文本」，空格就是空格。`pip\ninstall`、`pip  install`（多空格/换行）不再算整句，`pip, then install` 也不算；整词模式只在短语首尾加词边界（`pip installer` 不算整词整句，但普通模式仍可命中子串）。
- 查询内部空格原样保留（不再折叠成单个空格），输入两个空格就要求两个空格。
- 测试更新：整句/整词边界/双空格 query 三组用例，`node --test test/` 13/13。

## 1.2.0 — 2026-11-07

- Relevance ranking now compares match quality as an ordered sequence instead of adding keyword counts up: a Session that quotes the query as one adjacent phrase always ranks above Sessions that only repeat its words, no matter how many times the words repeat. A Session that says `pip install` once outranks one that says `install` six times.
- A phrase may span a line break or several spaces, so `pip\ninstall` inside a wrapped code block counts as the phrase, and whole-word mode treats the phrase as adjacency rather than mere co-presence of the words.
- The order of rows inside one Session follows the same phrase-first rule, and the relevance badge only marks a real adjacent phrase.

## 1.1.0 — 2026-11-07

- Relevance ranking now puts the whole query phrase first: sessions quoting `pip install transformers` as one phrase rank above sessions that only scatter those words, which in turn rank above partial matches. The same order applies to rows inside one session, and the relevance score gives an exact phrase a fixed bonus over repeated keyword noise.
- Add a `node --test test/` suite pinning the ranking rules (phrase tier, full/partial tiers, time order unchanged, single-word queries unchanged).

## 1.0.1 — 2026-10-29

- Docs: English README (`README.en.md`) with a language switch in both READMEs.
- Docs: declare storefront screenshots in `screenshots.json`.
- Publish a prebuilt tarball so installs can skip the build-from-source path.
## 1.0.0 — 2026-10-29

First public release.

- Sidebar Workspaces-header entry (magnifier with a clock hand) opening an inline search panel.
- Searches what you typed (input pool) in every workspace; output (assistant answers) searchable as an opt-in second pool.
- Matching: substring by default; `Aa` case-sensitive, `ab` whole word, `.*` regex; multi-keyword requires all tokens in one message; CJK long-string fallback splits into 2-char chunks.
- Results: per-session best hit, hover preview centred on the match with highlight, click to open, archived sessions excluded.
- Workspace multi-select, group-by-session, time / relevance sort, pagination.
- Storage: reads `~/.dsh/sessions/` zstd logs frame by frame, keeps one sidecar per session under `~/.dsh/cache/find-history/`, appends only new frames when a log grows; first install backfills in child processes (≤2 workers).
- Zero dependencies, no build step, no full-text index service required.
