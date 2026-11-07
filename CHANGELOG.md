# Changelog

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
