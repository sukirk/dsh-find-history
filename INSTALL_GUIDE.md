# INSTALL_GUIDE — for an AI agent or a human in a hurry

Goal: install **dsh-find-history** into a DSH profile and confirm the sidebar search icon works.

## 0. Prerequisites

- DSH `0.2.1-rc.x` with a Web profile (`dsh --profile web` serves the browser UI).
- Node.js ≥ 22.
- A `dsh` command. If it is not on `PATH`, use the CLI inside the DSH installation instead:
  - local install: `<dsh-root>/node_modules/.bin/dsh`
  - one-off: `npx --yes @deepseek-ai/dsh@0.2.1-rc.4`

The commands below write `dsh`; substitute whichever form you have.

## 1. Install the plugin

```bash
# from GitHub source
dsh plugin --profile web add github:OWNER/dsh-find-history

# from a local checkout (development)
dsh plugin --profile web add /path/to/dsh-find-history
```

Rules of thumb:

- Use the profile that serves your UI. In the stock setup that is `web`; if you renamed it, substitute `<profile>`.
- The command forwards to pnpm and appends the bundle to the profile's `dsh.profile.bundles`. Expect pnpm output ending with `+ dsh-find-history link:...` or `+ dsh-find-history 1.0.0`.
- This package is plain JavaScript with **no build step**, so git installs need no `allowBuilds` permission. If pnpm still asks, allow `dsh-find-history` only.
- Do **not** hand-edit `~/.dsh/profiles/<profile>/package.json` or run pnpm in the profile directory yourself; let `dsh plugin add` do it.

## 2. Restart the Web UI

```bash
# stop the running dsh web, then:
dsh --profile web --port 44449 --no-open      # any free port
```

The printed URL is the one to open. `--no-open` keeps the browser closed; drop it to auto-open.

## 3. Verify

Fast automated check — the sidecar index is built automatically a few seconds after the Host half loads (no search needed):

```bash
sleep 6; ls ~/.dsh/cache/find-history/sessions 2>/dev/null | wc -l   # expect one file per unarchived session, > 0
```

The token for the Web UI is printed on stdout (`dsh web: http://127.0.0.1:<port>/?token=…`); DSH 0.2.1-rc.x does not write a `web.log`.

Human-visible checklist (open the URL from step 2):

1. Left sidebar → the **Workspaces（工作区）** section header now shows a **magnifier with a clock hand** as its first icon (the built-in title search sits next to it; they must look different).
2. Click it: an inline search panel opens under the header, with the placeholder `搜索对话内容 / Search conversation content`, toggles `Aa` `ab` `.*`, and a second row `搜索：☐ 输入 ☐ 输出`.
3. Type a word you know you wrote in some past session (e.g. a project name). Rows appear with the matched fragment highlighted; the status line reads `找到 N 个会话`.
4. Hover a row → a preview popup shows the matched message with the keyword highlighted.
5. Click a row → that session opens in the conversation pane.
6. `Esc` closes the panel; reopen it and the previous query is still there.
7. Sidebar **插件 / Plugins** page → “已安装插件 / Installed plugins”: the entry **查找历史 / Session History Search** is listed and can be toggled off/on (display metadata comes from `locale/*.json` + `icon.svg`). Turning it off removes the icon immediately.

If step 1 shows no new icon, the client half did not load: check the browser console for errors mentioning `dsh-find-history`, and confirm the profile entry exists:

```bash
grep -o 'dsh-find-history[^,]*' ~/.dsh/profiles/<profile>/package.json
```

## 4. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `dsh plugin add` reports a peer/engine warning | Harmless unless it is about `engines.dsh`; upgrade DSH to 0.2.1-rc.x. |
| Icon missing after restart | Hard-reload the page (Ctrl+Shift+R). The icon is injected into the sidebar header at runtime. |
| Panel opens but every search says "no results" | Give it a few seconds on first run: the index is built in child processes (~2s for ~130 sessions). The panel shows a "still indexing" line while that runs. |
| Old sessions are not searchable | Archived sessions are excluded on purpose. Un-archive one to make it searchable again. |
| Two look-alike magnifiers in the header | Our icon has a clock hand inside the lens; the shipped one is a plain magnifier. |

## 5. Uninstall

```bash
dsh plugin --profile web remove dsh-find-history
rm -rf ~/.dsh/cache/find-history
```

Session logs are never modified, so uninstalling loses nothing else.
