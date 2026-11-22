# AGENTS.md

本目录是 dsh-find-history，一个 DSH bundle 插件：Host 侧 ESM 模块（`index.mjs`）+ 预构建的 Web 客户端（`client.js`）。插件在侧边栏「工作区」标题行挂搜索入口，用自建语料按用户输入过的文字找回会话。

## 项目是什么

- `cordis.patch.yml` 只声明一行（`id: find-history`），`package.json` 的 `dsh.bundle.patch` 指向它；`dsh.client.platform` 是 `web`，`immediately: true` 让客户端尽早加载。
- Host 注册一条 `kind: 'exact'` 路由 `/dsh-find-history/search`；不建全文索引，不修改部署里的 `sessionQuery` 行。
- 语料来源是 Session 日志：只保留用户输入的消息和每轮收尾的 assistant 回答；中文用子串匹配，不依赖 FTS5 分词。

## 关键文件

| 位置 | 作用 |
| --- | --- |
| `index.mjs` | 路由与鉴权、匹配器（`buildMatcher` / `buildApproximateMatcher` / `searchWithRelaxation`）、排序（`rankSessions` / `relevanceOf`）、结果组装、增量巡检、事件监听、语料缓存 |
| `scan.mjs` | 逐 zstd frame 解压 Session 日志（`MAX_MESSAGE_CHARS` 截断），抽出用户消息与每轮收尾回答 |
| `store.mjs` | 每个 Session 一个语料文档（`DOC_VERSION`），记录日志路径、大小、mtime 与已读偏移；`indexPaths` 把缓存根解析到 `$DSH_HOME/cache/find-history/` |
| `backfill.mjs` | 冷启动子进程入口：`node backfill.mjs <docs> <cache root> <JSON batch>`，批次结束即退出 |
| `client.js` | 预构建客户端：侧边栏按钮、标题行内联搜索框（与内置搜索同样的展开动画）、结果列表、悬停预览、续聊跳转 |
| `locale/zh.json`、`locale/en.json` | 插件元信息文案 |
| `test/ranking.test.mjs` | `node:test`，直接测匹配器、命中收集、排序、语料搜索 |
| `test/search-behavior.test.mjs` | 检索行为规格：字面量语义 / 大小写 / 整词（ASCII 边界 + 中文子串）/ 正则 / n-gram 近似与自动放宽，含与独立边界实现的差分测试 |
| `test/search-acceptance.test.mjs` | 验收语料：20 条长度 2–10 的查询，核对精确/近似、时间序、相关性序、大小写/整词/正则变体 |

## 构建与验证

```bash
npm test                                   # node --test，跑 test/ 下全部用例
node --check index.mjs scan.mjs store.mjs backfill.mjs client.js
```

没有打包步骤：`client.js` 是直接维护的 `__ModuleLoader__` bundle，改完刷新页面生效。真实回归需要运行中的 DSH：在侧边栏点搜索图标，搜一个你确定说过的词，确认能点回会话；再搜一个只在标题里被拆开出现的中文词，确认结果被标为“近似匹配”且行内有覆盖率。

## 维护规则

- 鉴权顺序别改：`handleSearch` 先校验方法是 GET，再 `ctx.connection.authorizeIndex(req, res)`，然后才解析查询；路由是 exact，拿不到 `/api` 的 body 上限，读请求本身没有 body。
- 查询语义对齐 VS Code：整段输入是一个字面量，空格/引号/`!` 是数据；`Aa` / `ab` / `.*` 只影响大小写、ASCII 词边界和正则。不要重新引入 AND、引号短语或 `!` 排除。
- 改动匹配器需同时覆盖 `buildMatcher`（literal/regex；正则用 `m` 标志让 `^`/`$` 按行锚定）、`findWholeFrom`（ASCII 边界）、`buildApproximateMatcher` + `queryUnits`/`scanUnits`（自动放宽，覆盖率和 60% 阈值）与 `searchWithRelaxation`（仅在无精确结果、非整词、非正则时启用），并在 `test/search-behavior.test.mjs` / `test/search-acceptance.test.mjs` 补用例。
- 响应字段是客户端契约：`query`、`mode`、`truncated`、`limit`、`offset`、`total`、`matched`、`pending`、`group`、`workspaces`、`items`；`items` 的 `sessionId` / `title` / `cwd` / `workspaceId` / `workspaceTitle` 与 `snippet` / `head` / `match` / `tail` / `time` / `seq` / `kind` / `focus` / `coverage` / `truncated`，分组时还有 `totalHits` / `hits`。客户端高亮与跳转依赖 `focus`，不要改成语义字符串。
- 语料文档格式变了必须 bump `DOC_VERSION`：旧文档会被当成空语料重建，不要写兼容旧格式的代码。
- 缓存路径只能通过 `ctx.get('dshHomePath')('cache', …)` 解析，不要手拼 `~/.dsh`；拿不到缓存目录时让插件空跑，不要抛错影响 DSH 启动。
- 事件监听（`session/created`、`session/event`、`session/disposed`）与定时器都要在 dispose 里清掉，`corpus` 不能留在模块级内存里；归档会话通过 `workspaceRegistry.archivedSessionIds` 跳过。
- 客户端挂载依赖侧边栏 CSS module 的类名后缀（`sectionHeader` / `searchSlot` / `headerActions` / `listArea`）和两个属性：容器上的 `data-dsh-find-history-open`（整页切到搜索面：隐藏 `.listArea` 并让区块占满侧边栏高度，`display:none !important` 用来压过宿主的 `.root:not(.rail) .listArea{display:block}`）、标题行上的 `data-dsh-find-history-expanded`（收起标题/原生搜索/操作按钮并展开搜索框）。搜索框常驻标题行、折叠时宽度为 0，靠 `max-width` 过渡做出与原生搜索一致的展开动画；改挂载点要同步改 `MutationObserver` 的重挂逻辑。

## 与上游的差异

自有项目，没有上游。设计上与宿主内建的会话检索不同：不走 FTS5、不改 `sessionQuery`，因为 Session 日志把 harness 上下文也记成 `user/message`，按角色无法区分，而且 FTS5 分词器只按 token 边界匹配中文；因此把日志读成「用户输入语料」在内存里做子串匹配，并用每 Session 一个文档 + 已读偏移把冷启动成本摊到后台批次。

## 常见修改

- **加筛选参数**：`readX` 解析 + 传给 `searchCorpusIn` 的 `filter`，再在 `client.js` 的搜索面加控件，最后补 README 参数表。
- **改排序**：`relevanceOf` / `compareHits` / `rankSessions`，同步 `test/ranking.test.mjs`。
- **改语料抽取**：`scan.mjs` 的 `readMessageText` / `readAssistantText`；注意保留「同一轮只留最后一条回答」的语义。
- **改入口位置**：`client.js` 里的 portal 与 class 后缀选择器，别引入构建步骤。
- **改缓存布局**：`store.mjs` 的 `DOC_DIR` / `LOG_FILE` / `DOC_VERSION` 必须一起改，并保证旧目录不会让新代码读到半份文档。

## 完成判据

- `npm test` 与 `node --check` 全部通过；
- 手工验证：入口出现在侧边栏标题行、中英文关键词都能命中、点结果能进入对应会话、清空后恢复原会话列表；
- 改动涉及查询语义或排序时，`test/ranking.test.mjs` / `test/search-behavior.test.mjs` / `test/search-acceptance.test.mjs` 有新用例；
- README 的参数表、响应字段、边界与实现一致；没有改动宿主的 `sessionQuery` 行。
