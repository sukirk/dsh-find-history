# dsh-session-history-search · Session History Search

Adds a search icon to the Workspaces header in the DSH Web sidebar. Type a few words you remember writing, and it finds that forgotten conversation across **every** workspace so you can pick it up again.

CJK-friendly, millisecond-fast, zero dependencies, no full-text index service required.

![preview](docs/preview.png)

> 中文说明见 [README.md](README.md)

## Highlights

- **Search where you already are**: the entry sits in the Workspaces header and results render inside the sidebar — no floating window, no context switch.
- **Finds what you typed, not what the harness injected**: input is the default pool; tick Output when you want to search answers too. Runtime context and skill catalogs never show up as "your words".
- **CJK works**: `炒股界面` matches 「炒股界面与K线缩放」; long runs with no hit fall back to 2-character chunks.
- **Milliseconds**: 0.4–13ms per query on the same machine and dataset (median 0.7ms over 5 runs).
- **No index service**: does not depend on DSH `session-query` and needs no FTS — it works right after install.
- **Zero dependencies, no build step**: 5 JS files, installed straight through `dsh plugin add`, no `allowBuilds` prompt.
- **Background index build**: the first install backfills in child processes (≈12MB batches, at most 2 workers), so the host stays small and search works while it runs.
- **Reversible**: only writes sidecar files under `~/.dsh/cache/`; delete the directory to forget everything.

### Measured on the same machine (DSH 0.2.1-rc.4, 137 sessions / 192MB logs)

| | **this plugin** | [dsh-session-search](https://github.com/Ziminli/dsh-session-search) 0.1.1 | [dsh-companion](https://github.com/beijingwahw/dsh-companion) 0.4.0 | [dsh-session-search-pro](https://github.com/LeslieWylie/dsh-session-search-pro) 0.2.0 |
| --- | --- | --- | --- | --- |
| Entry point | Header icon + inline sidebar panel | Sidebar panel + `Ctrl+F` | History field and in-conversation find, part of a suite | No UI, 3 agent tools |
| What it searches | Your input (answers optional) | Only the last completed answer of each session | Requires the built-in full-text index | The model calls tools |
| Per query (median of 5) | **0.7ms** (0.4–13ms) | 12.6 s | search errors out, no usable result | cannot be installed, no UI |
| Time to first use | auto build in background, ~4.7s | first successful result 14.5 s | search never succeeds | rejected by the version gate |
| CJK substrings | substring scan + 2-char fallback | engine tokenizer | engine tokenizer | engine tokenizer |
| Dependencies | zero, no build | — | needs the built-in FTS enabled by hand; still incompatible on rc.4 | install rejected by the version gate |

Hit counts are not directly comparable (this plugin defaults to user input, dsh-session-search to final assistant answers); latency is. The competitors cover more ground (fuzzy matching, typo tolerance, time ranges); this plugin deliberately does one thing — fast recall of what you wrote.

## Install

From the GitHub source:

```bash
dsh plugin --profile web add github:OWNER/dsh-session-history-search
```

Reload the page (or restart `dsh web`). The entry **Session History Search** appears in the sidebar **Plugins** page and can be toggled anytime. The package is plain JS with no build step, so git installs need no `allowBuilds` permission.

Prefer to let an agent do it:

> Install and verify the plugin by following `OWNER/dsh-session-history-search/INSTALL_GUIDE.md`.

## Usage

- Click the new icon in the Workspaces header (magnifier with a clock hand, distinct from the built-in title search).
- Type to search (260ms debounce). Multiple keywords must all appear in the same message; long CJK strings fall back to 2-char chunks.
- Inline toggles: `Aa` case-sensitive, `ab` whole word, `.*` regex.
- Second row: `Search: ☐ input ☐ output`; on the right, workspace multi-select, group-by-session, and sort (time / relevance).
- Hover a row for a preview of the matched message (100 chars before + match + 100 after, highlighted).

![Hover preview](docs/preview-hover.png)
- Click a row to open that session; archived sessions are excluded. `Esc` closes, and your query is kept for next time.

## Why it is fast

DSH stores each session as a **multi-frame** zstd file at `~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`. The plugin never decompresses the whole log:

1. scan zstd frame headers (`0x28 0xb5 0x2f 0xfd`) to get frame boundaries;
2. decompress frame by frame and parse **only** the lines it needs (`user/message`, `assistant/message`, `session/title`), skipping the rest;
3. keep one **sidecar** per session under `~/.dsh/cache/session-history-search/` (bytes consumed, frame count, title, extracted messages);
4. when a log grows, **continue from the last byte offset** instead of rescanning;
5. first install backfills in **child processes** (≈12MB batches, at most 2 workers) so the host process stays small;
6. searching is then an in-memory substring scan over a few hundred messages — about 0.1ms.

Measured on 134 sessions (193MB compressed, 818MB decompressed):

| Task | Result |
| --- | --- |
| Cold build (first install) | 137 sessions / 192MB in ~4.7s; starts 0.3s after the Host loads and searches see partial results meanwhile; first UI rows ~2.4s after process start |
| Second start (sidecars present) | no rebuild, ~3ms |
| One session grew | decompress only new frames, ~4ms |
| Single search (titles included) | 0.4–13ms, median 0.7ms |
| In-memory scan | 0.13ms for 751 messages, 46ms for 100k |
| Disk | ~2.5MB of sidecars |

## Privacy

Reads only `~/.dsh/sessions/`, writes only `~/.dsh/cache/session-history-search/`, makes no network requests, never modifies session logs. Delete the cache directory to forget everything.

## Compatibility

- Requires DSH 0.2.1-rc.x (`engines.dsh: >=0.2.1-rc.1 <0.3.0`).
- UI is Web-profile only.
- The Workspaces header is rendered by a shipped component with no public slot, so the entry icon is **portal-injected** next to it — only its own DOM node is added, and it is removed on unload.

## License

MIT
