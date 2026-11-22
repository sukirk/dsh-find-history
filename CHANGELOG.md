# Changelog

## 1.7.0 — 2026-11-22

- 查询语义完全对齐 VS Code 的搜索框：整段输入是字面量，空格、引号、`!`、标点都是数据；删除 AND、引号短语、`!` 排除和 `splitTokens`。`Aa` / `ab` / `.*` 只改大小写、ASCII 词边界和正则解释。
- 整词开关不再改变查询结构：多词查询仍是一整段字面量，开关只在首尾校验 ASCII 词边界；中文两侧没有这种边界，仍按连续子串匹配（与 VS Code 的 `\b` 实际行为一致）。整词模式不参与自动放宽。
- 无精确结果时自动放宽：按查询的重叠字对（CJK）/ 词（Latin）的覆盖率匹配（阈值 60%，至少 2 个单元）；响应带 `mode` 与 `coverage`，界面提示“近似匹配”并在每行显示覆盖率。正则与整词不参与。
- 删除按 4 字起、非重叠两字切块、奇数末字并入前块的兜底——没有语言学依据。
- 相关性排序改为可解释的三元组：最佳命中覆盖率 → 会话内出现次数 → 最新时间；时间排序保持纯时间。
- 正则扫描全文（去掉 4000 字符截断），复用编译后的表达式；保留 120 字符上限与灾难性回溯拒绝。
- 结果契约新增 `mode`、`truncated`、`focus`（消息里实际命中的原文）、`coverage`、分组 `totalHits`；客户端用 `focus` 高亮和滚动定位，正则与近似命中不再高亮错位。
- 查询 300 字符上限在输入框可见；超过 20000 字符的消息截断带 `truncated` 标记并在状态栏提示。
- 关键词历史只在提交（回车/关闭）时记录，删除前缀猜测与“跳过当前词”特判。
- 性能（2 万条消息的合成语料）：中位与 1.6.0 基本持平（总耗时约 1.0–1.2×，最坏整词 1.5×），未超过 2×。
- 测试：重写行为与排序用例，新增 `test/search-acceptance.test.mjs`（20 条长度 2–10 的查询）和 `test/handler.test.mjs`（真实语料的 HTTP 路由、分组、近似与截断）；共 35 例通过。
- 修复开发中丢失 `listWorkspaces` 导致所有搜索返回空 400 的问题；客户端只在 Body 说明是正则问题时才显示“正则表达式无效”，其余 400/HTTP 错误显示真实原因。

## 1.6.0 — 2026-11-22

- 适配 DSH 0.2.2（实测 `0.2.2-rc.3`）：搜索框改为在「工作区」标题行内原地展开，标题、内置搜索与操作按钮按内置搜索的同一套过渡收起（`max-width` + 180ms `--ds-ease-in-out`），侧栏整块切换为搜索页。会话列表用 `data-sidebar-list-area` + `display:none !important` 收起（宿主 `.root:not(.rail) .listArea` 的 `display:block` 会压过普通选择器）；`prefers-reduced-motion` 下关闭过渡。
- 关键词历史：输入框内 `↑` 回看最近 10 条搜索词、`↓` 回到正在输入的内容；存浏览器 `localStorage`，不写会话日志。
- 整词匹配修正：词边界只认 ASCII 字母、数字、下划线（和 `\b`、VS Code 的实际表现一致），中文关键词按连续子串匹配；开启整词后不再启用中文切块兜底，修复「这次改动」命中只分别出现「这次」「改动」的会话。
- 中文切块兜底补全覆盖：奇数长度的关键词把末字并入前一块（`炒股界面大` → `炒股` + `界面大`），不再丢掉末字。
- 扫描器：按 zstd 帧头解析帧边界而不是在载荷里搜魔数，坏帧和未写完的尾帧保持未读、下一轮重试；单条消息截断改为保留头尾两半，长粘贴两端的关键词都能命中。
- 正则：模式最长 120 字符、每条消息只扫前 4000 字符，拒绝嵌套量词等可能灾难性回溯的写法（`400 unsafe-regex`）；非法正则返回 `400 invalid-regex`。
- 测试：新增 `test/search-behavior.test.mjs`，覆盖大小写 / 整词 ASCII 边界 / 中文整词 / 多关键词 / 引号 / 排除 / 正则 / 切块重试的允许条件，并用独立的边界参考实现做差分；`npm test` 48 例通过。
- 文档：README / README.en 标记适配 0.2.2，写清整词与中文口径、关键词历史和布局变化；新增 AGENTS.md（维护与挂载说明）。

## 1.5.0 — 2026-11-08

- 整词匹配（`ab`）按 VS Code 的「全字匹配」语义重做：查询文本作为一整段字面量，开关只在首尾校验词边界。多关键词在整词模式下必须**连续出现**——`pip` 和 `install` 分散在不同位置不再算命中，`xpip install` 这种首尾粘连也不算，因此 `pip install` 的整词结果里不会混进只提到单个词的会话。
- 整词模式下每一行都是整句命中，摘录与「整句匹配」徽标因此始终对齐；单关键词整词查询的表现不变（仍会避开 `piper`、`installed` 等粘连形式）。
- 文档写清词边界口径：字母、数字、下划线、汉字算词内字符；连字符、点、斜杠算分隔符（与 VS Code 的 `\b` 一致），所以 `--no-install-recommends` 里的 `install` 是整词。
- 测试同步：整词模式要求查询连续、拒绝首尾粘连、单关键词边界不变，`node --test test/ranking.test.mjs` 21/21。

## 1.4.1 — 2026-11-08

- 结果行的摘录与「整句匹配」徽标改为描述该会话里**匹配质量最高**的那条消息，而不是当前排序下的第一条。按时间排序时第一条常是很新的弱命中（只含一个子词），旧逻辑会把散词摘录和错位的徽标显示出来——现在行内文字、徽标、命中词表都指向真正命中整句的那条消息。
- 摘录窗口优先落在整句位置：同一条消息里前面先出现裸 `pip -V`、后面才有 `python3 -m pip install ...` 时，行内文字从整句处开始显示（此前从最早的单关键词处开始，用户会看到「没有 pip install 却标着整句匹配」）。整词模式同样按整句定位。
- 测试新增 3 例（摘录定位到整句、整词模式跳过近邻误配、弱命中较新时仍以整句为行代表），`node --test test/ranking.test.mjs` 21/21。

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
