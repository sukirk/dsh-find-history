# dsh-session-history-search · 会话历史搜索

在 DSH Web 侧栏「工作区」标题行加一个搜索图标。点开后输入关键词，就能在所有工作区里搜出**你自己说过的内容**，找回忘记的那个会话并继续聊。

中文友好、毫秒级、零依赖、不需要部署任何全文索引服务。

![预览](docs/preview.png)

## 和另外三个 dsh 搜索插件比

| | **本插件** | [dsh-session-search](https://github.com/Ziminli/dsh-session-search) | [dsh-session-search-pro](https://github.com/LeslieWylie/dsh-session-search-pro) | [dsh-companion](https://github.com/beijingwahw/dsh-companion) |
| --- | --- | --- | --- | --- |
| 入口形态 | 侧栏标题行图标 + **内联面板**（不弹独立浮窗） | 侧栏面板 + Ctrl+F | 无界面，3 个 agent 工具 | 套件里的一块：历史列表搜索框 + 对话内查找 |
| 面向谁 | 人：找回忘记的会话 | 人 | 模型 | 人 |
| 数据来源 | **直接读会话日志**（zstd 帧级增量 + 每会话侧车） | DSH `session-query` / controller 服务 | `sessionQuery` FTS5，索引没开时回退扫描 | `sessionQuery` |
| 需要全文索引服务 | **不需要** | 需要部署启用 | 需要（否则退化） | 需要 |
| 中文连写 | **子串扫描 + 两字切块兜底**（"炒股界面"能搜到"炒股界面与K线缩放"） | 依赖引擎分词 | 依赖引擎分词 | 依赖引擎分词 |
| 输入 / 输出分池 | **默认只搜你输入的，可勾选把回答也搜进来** | 有 final-only 选项 | 工具参数 | 部分 |
| 首次建索引 | **约 2 秒**（子进程回填，父进程 RSS < 100MB） | 取决于引擎 | 取决于引擎 / 扫描 | 取决于引擎 |
| 单次搜索延迟 | **2–15ms**（同机同数据实测） | 同机实测其搜索接口 3.5–4s | 未测（无界面） | 未测 |
| 体积与依赖 | **5 个 JS 文件，无第三方依赖，无构建步骤** | 中等 | 小 | 大（四模块套件） |

说明：上表的对手数字来自本机同一份数据（134 个会话 / 774 条用户输入 / 751 条回答）的实测，仅供参考；对手插件在功能广度上更强（模糊匹配、错字容忍、时间范围、多会话选择、agent 工具），本插件刻意只做"快速找回"这一件事。

## 安装

三种方式任选，装完重启 `dsh web`（或刷新页面），在 **设置 → 插件** 里能看到「会话历史搜索 / Session History Search」，并可以随时启停。

**1) npm（发布到 npm 后）**

```bash
dsh plugin --profile web add dsh-session-history-search
```

**2) 从 GitHub 源码装**

```bash
dsh plugin --profile web add github:OWNER/dsh-session-history-search
```

**3) 本地目录或 tarball**

```bash
dsh plugin --profile web add /path/to/dsh-session-history-search
dsh plugin --profile web add ./dsh-session-history-search-1.0.0.tgz
```

**4) 让 AI 助手帮你装**

把这句话发给任意能执行命令的 agent：

> 根据 `OWNER/dsh-session-history-search` 仓库里的 INSTALL_GUIDE.md 安装并验证这个插件。

`dsh plugin add` 会把包名直接转给 pnpm 装进 profile，并把 bundle 加进 profile 的 `dsh.profile.bundles`；本插件是纯 JS、没有构建步骤，git 安装不需要额外授权 `allowBuilds`。

## 怎么用

- **点侧栏「工作区」标题行第一个图标**（放大镜里带钟针，和右侧自带的标题搜索区分开）打开搜索框。
- 输入即搜（260ms 防抖），多关键词默认要求**同一段消息里全部出现**才命中；中文长串搜不到时自动按两字切块兜底。
- 输入框内三个开关：`Aa` 区分大小写、`ab` 整词、`.*` 正则。
- 第二行「搜索：☐ 输入 ☐ 输出」控制搜哪一池；右侧三个图标：工作区多选（文件夹）、按会话分组（列表）、排序（时间 / 相关性）。
- 鼠标停在结果行上会弹出命中消息的预览（命中处前 100 字 + 命中段 + 后 100 字，关键词高亮）。
- 点结果行即打开那个会话并继续对话；归档会话不会被搜到。
- `Esc` 先收起下拉/面板，再按一次关闭搜索；关键词会留在输入框里，下次打开自动重搜。

## 为什么这么快

DSH 把每个会话写成 `~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`——**多帧 zstd**拼接。本插件不去解压整份日志，而是：

1. **扫描 zstd 帧头**（`0x28 0xb5 0x2f 0xfd`）得到帧边界；
2. 逐帧解压后**只解析命中标记的行**（`"type":"user/message"` / `"assistant/message"` / `"session/title"`），其余行整行跳过；
3. 每个会话存一个**侧车文件**（`~/.dsh/cache/session-history-search/`），记录读到的字节数、帧数、标题和提取出的消息；
4. 日志变大时**只从上次的字节位置续读**（增量尾部解压），不是重扫；
5. 首次安装时把回填任务丢给**子进程分批做**（每批约 12MB、最多 2 个 worker），父进程内存不涨；
6. 搜索就是**内存里扫 700 多条消息**——一次 0.1ms 量级。

实测（134 个会话 / 193MB 压缩日志 / 818MB 解压后）：

| 项目 | 结果 |
| --- | --- |
| 冷建（首次安装） | 约 2.1 秒，父进程 RSS < 100MB |
| 再次启动（有侧车） | 不重建，读侧车约 3ms |
| 某会话日志变大 | 只解新增帧，约 4ms |
| 单次搜索（含标题、工作区） | 2–15ms |
| 内存语料扫描 | 751 条约 0.13ms；10 万条约 46ms |
| 磁盘占用 | 侧车索引约 2.5MB（不复制日志正文） |

### 为什么不用 FTS / 不用 ripgrep

- DSH 自带的 `session-query` 用 SQLite FTS5 的 `unicode61` 分词：连续中文会被当成**一整个 token**，两个汉字的子串基本搜不到；而且它索引的是**全部 `user/message` 事件**，Harness 注入的运行时上下文、技能目录、时间戳也会被索引，搜出来的"会话"点进去常常一个字都对不上。
- `ripgrep` 扫已解压文本很快（782MB 约 79ms），但会话日志是压缩的：让 rg 直接扫 zstd 需要每次解压（1.18s），先解压成镜像又要多占一份磁盘。129 个文件的进程启动开销也不划算——常驻内存的 0.13ms 比它快两个数量级。
- 顺带记录一个坑：Node 22 的 `zlib.zstdDecompressSync` / `createZstdDecompress` **只解第一帧**，14MB 的日志只吐出 198 字节且不报错。所以这里自己按帧走。

## 隐私

- 只读本机 `~/.dsh/sessions/` 下的会话日志，只写 `~/.dsh/cache/session-history-search/`。
- 不发任何网络请求。
- 会话日志本身不会被修改；卸载插件后把 cache 目录删掉即可。

## 兼容性

- 需要 DSH 0.2.1-rc.x，`engines.dsh` 声明为 `>=0.2.1-rc.1 <0.3.0`。
- 只对 Web profile 有界面；Host 半边在别的 profile 里也能加载，但没有侧栏图标。
- 侧栏「工作区」标题行是 DSH 自带组件渲染的，没有公开插槽，所以入口图标是**portal 注入**到该行的 DOM 里（只动我们自己的节点，卸载即移除）。

## 仓库结构

```
index.mjs        Host：HTTP 路由、语料、匹配、排序、分组、分页
scan.mjs         帧级日志读取（帧头扫描 / 全量 / 尾部增量 / 行分类）
store.mjs        侧车索引的读写（每会话一文件，原子写）
backfill.mjs     子进程回填脚本
client.js        Client：侧栏图标、内联面板、结果渲染、悬停预览、打开会话
cordis.patch.yml bundle 安装声明
locale/*.json    zh / en 文案与插件列表元数据
icon.svg         插件列表图标
```

开发时把仓库目录用 `dsh plugin --profile web add /path/to/repo` 挂进去，改完在插件列表里关掉再打开即可重载 Host 半边。

## License

MIT
