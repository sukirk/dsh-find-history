# Changelog

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
