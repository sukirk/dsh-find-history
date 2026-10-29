# dsh-find-history · 查找历史

在 DSH Web 侧栏「工作区」标题行加一个搜索图标。点开后输入关键词，就能在所有工作区里搜出**你自己说过的内容**，找回忘记的那个会话并继续聊。

中文友好、毫秒级、零依赖、不需要部署任何全文索引服务。

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/DSH-0.2.1--rc.x-7c3aed" alt="DSH">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="dependencies">
  <img src="https://img.shields.io/badge/build-none-lightgrey" alt="build">
</p>

<p align="center">
  <img src="docs/preview-hover.png" alt="在侧栏里搜索，悬停看命中原文" width="483">
</p>

## 优点

- **就在侧栏里搜**：入口是「工作区」标题行的一个图标，结果直接铺在侧栏，不弹独立浮窗，也不打断当前对话。
- **只找你说过的话**：默认只搜你自己输入的内容；需要翻回答时勾一下「输出」，不会把 Harness 注入的上下文、技能目录当成你的话搜出来。
- **中文连写能搜到**：`炒股界面` 能命中「炒股界面与K线缩放」，长串搜不到时按两字切块兜底。
- **毫秒级**：同一台机器、同一份数据，单次搜索 0.4–13ms（5 次中位 0.7ms）。
- **不需要索引服务**：不依赖 DSH 的 `session-query`，也不用开 FTS，装完就能用。
- **零依赖、无构建**：5 个 JS 文件，`dsh plugin add` 直接装，不跑构建脚本，不需要 `allowBuilds`。
- **建库不卡页面**：首次安装后台用子进程回填（每批 12MB、最多 2 个 worker），父进程内存不涨，边建边能搜。
- **改动可逆**：只往 `~/.dsh/cache/` 写一份侧车索引，卸载后删掉目录即可。

### 同机实测（DSH 0.2.1-rc.4，137–141 个会话 / 192MB 日志，同一台机器）

| | **本插件** | [Victue/dsh-session-search](https://github.com/Victue/dsh-session-search) 0.3.2 | [YeqingTang/dsh-session-flow](https://github.com/YeqingTang/dsh-session-flow) 1.5.0 | [Ziminli/dsh-session-search](https://github.com/Ziminli/dsh-session-search) 0.1.1 |
| --- | --- | --- | --- | --- |
| 入口 | 侧栏「工作区」标题行图标 + 内联结果 | 侧栏面板 | 侧栏「会话流」工作台 + 顶部搜索框 | 侧栏面板 + `Ctrl+F` |
| 搜什么 | 你输入的内容（可加搜回答） | 全部正文（用户、助手、工具） | 用户 + 助手 + thinking + 工具，**只扫最近 20 个会话** | 只搜每条会话最后一条已完成回答 |
| 单次搜索（5 次中位） | **0.7ms**（0.4–2.8ms） | 22–36ms | 33–38ms | **12.6s** |
| 首次可用 | 后台建库，约 2s 出首批结果、4.7s 建完 | 建索引 5.7s（141 会话、8.1 万条） | 首查 2.9–3.8s；全量索引 7.2s | 首次成功 14.5s |
| 中文连写 | 子串扫描 + 两字切块兜底 | 子串 | 子串 | 依赖引擎分词 |

口径说明：Victue 自己维护全库索引，之后按索引搜；dsh-session-flow 每次只扫最近 20 个会话（5 秒预算），大库会漏旧会话；Ziminli 每条会话只索引最后一条已完成回答，所以搜「部署脚本」这类用户原话是 0 命中。命中数量口径不同，延迟才可直接比较。竞品在功能广度上更全（模糊匹配、错字容忍、时间范围），本插件只做「快速找回自己说过的话」这一件事。

## 安装

装完刷新页面（或重启 `dsh web`）。侧栏「插件」页的已安装列表里能看到「查找历史」，可以随时停用。

**1) 从 GitHub 源码安装**

```bash
dsh plugin --profile web add github:OWNER/dsh-find-history
```

**2) 让 AI 助手帮你装**

把这句话发给任意能执行命令的 agent：

> 根据 `OWNER/dsh-find-history` 仓库里的 INSTALL_GUIDE.md 安装并验证这个插件。

`dsh plugin add` 把包名直接转给 pnpm 装进 profile，并把 bundle 加进 `dsh.profile.bundles`。本插件是纯 JS、没有构建步骤，git 安装不需要额外授权 `allowBuilds`。


## 为什么这么快

### 一次搜索发生了什么

![从敲下关键词到打开会话的 8 个步骤](docs/sequence.png)

### 数据怎么流

![日志 → 侧车索引 → 内存匹配 → 侧栏面板](docs/flow.png)

DSH 把每个会话写成 `~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`——**多帧 zstd**拼接。本插件不去解压整份日志，而是：

1. **扫描 zstd 帧头**（`0x28 0xb5 0x2f 0xfd`）得到帧边界；
2. 逐帧解压后**只解析命中标记的行**（`"type":"user/message"` / `"assistant/message"` / `"session/title"`），其余行整行跳过；
3. 每个会话存一个**侧车文件**（`~/.dsh/cache/find-history/`），记录读到的字节数、帧数、标题和提取出的消息；
4. 日志变大时**只从上次的字节位置续读**（增量尾部解压），不是重扫；
5. 首次安装时把回填任务丢给**子进程分批做**（每批约 12MB、最多 2 个 worker），父进程内存不涨；
6. 搜索就是**内存里扫 700 多条消息**——一次 0.1ms 量级。

实测（134 个会话 / 193MB 压缩日志 / 818MB 解压后）：

| 项目 | 结果 |
| --- | --- |
| 冷建（首次安装） | 137 个会话 / 192MB 约 4.7 秒建完；Host 启动 0.3 秒后自动开始，边建边可搜，页面第一次出结果约 2.4 秒 |
| 再次启动（有侧车） | 不重建，读侧车约 3ms |
| 某会话日志变大 | 只解新增帧，约 4ms |
| 单次搜索（含标题、工作区） | 0.4–13ms，5 次中位 0.7ms |
| 内存语料扫描 | 751 条约 0.13ms；10 万条约 46ms |
| 磁盘占用 | 侧车索引约 2.5MB（不复制日志正文） |

每个会话的侧车文件长这样（只存自己提取出的文本和读到的位置，不存日志原文）：

```json
{
  "sessionId": "session-1f3c…",
  "cwd": "/home/you/projects/alpha",
  "title": "优化 v4 炒股交易界面设计",
  "size": 918273,
  "mtimeMs": 1761700000000,
  "readBytes": 918273,
  "messages": [{ "seq": 12, "time": 1761700000000, "text": "帮我优化一下部署脚本" }],
  "outputs": [{ "seq": 40, "time": 1761700300000, "text": "已完成，用时 3 分 12 秒。…" }]
}
```

## 目录结构

```
dsh-find-history/
├── index.mjs        Host half：HTTP 路由、语料、匹配、回填调度
├── scan.mjs         多帧 zstd 读取、行预筛、标题/消息提取
├── store.mjs        侧车索引读写、增量续读、旧缓存迁移
├── backfill.mjs     回填子进程（每次约 12MB，最多 2 个并发）
├── client.js        Client half：侧栏图标、内联面板、结果渲染
├── cordis.patch.yml bundle 声明
├── icon.svg         插件列表图标
├── locale/          zh / en 文案
└── docs/            README 里的截图与示意图
```

## 隐私

- 只读本机 `~/.dsh/sessions/` 下的会话日志，只写 `~/.dsh/cache/find-history/`。
- 不发任何网络请求。
- 会话日志本身不会被修改；卸载插件后把 cache 目录删掉即可。

## 兼容性

- 需要 DSH 0.2.1-rc.x，`engines.dsh` 声明为 `>=0.2.1-rc.1 <0.3.0`。
- 只对 Web profile 有界面；Host 半边在别的 profile 里也能加载，但没有侧栏图标。
- 侧栏「工作区」标题行是 DSH 自带组件渲染的，没有公开插槽，所以入口图标是**portal 注入**到该行的 DOM 里（只动我们自己的节点，卸载即移除）。

## 已知限制

- 归档会话不参与搜索。
- 输出池只收每轮最后的回答，过程消息和工具调用不入库。
- 侧栏「工作区」标题行没有公开插槽，入口图标是注入 DOM 实现的；DSH 大改版时这里可能要跟着改。

## License

[MIT](LICENSE)
