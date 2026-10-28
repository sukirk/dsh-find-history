# dsh-session-history-search · 会话历史搜索

在 DSH Web 侧栏「工作区」标题行加一个搜索图标。点开后输入关键词，就能在所有工作区里搜出**你自己说过的内容**，找回忘记的那个会话并继续聊。

中文友好、毫秒级、零依赖、不需要部署任何全文索引服务。

![预览](docs/preview.png)

## 优点

- **就在侧栏里搜**：入口是「工作区」标题行的一个图标，结果直接铺在侧栏，不弹独立浮窗，也不打断当前对话。
- **只找你说过的话**：默认只搜你自己输入的内容；需要翻回答时勾一下「输出」，不会把 Harness 注入的上下文、技能目录当成你的话搜出来。
- **中文连写能搜到**：`炒股界面` 能命中「炒股界面与K线缩放」，长串搜不到时按两字切块兜底。
- **毫秒级**：同一台机器、同一份数据，单次搜索 0.4–13ms（5 次中位 0.7ms）。
- **不需要索引服务**：不依赖 DSH 的 `session-query`，也不用开 FTS，装完就能用。
- **零依赖、无构建**：5 个 JS 文件，`dsh plugin add` 直接装，不跑构建脚本，不需要 `allowBuilds`。
- **建库不卡页面**：首次安装后台用子进程回填（每批 12MB、最多 2 个 worker），父进程内存不涨，边建边能搜。
- **改动可逆**：只往 `~/.dsh/cache/` 写一份侧车索引，卸载后删掉目录即可。

### 同机实测（DSH 0.2.1-rc.4，137 个会话 / 192MB 日志）

| | **本插件** | [dsh-session-search](https://github.com/Ziminli/dsh-session-search) 0.1.1 | [dsh-companion](https://github.com/beijingwahw/dsh-companion) 0.4.0 | [dsh-session-search-pro](https://github.com/LeslieWylie/dsh-session-search-pro) 0.2.0 |
| --- | --- | --- | --- | --- |
| 入口 | 侧栏标题行图标 + 内联面板 | 侧栏面板 + `Ctrl+F` | 套件里的历史搜索框、对话内查找 | 无界面，3 个 agent 工具 |
| 搜什么 | 你输入的内容（可加搜回答） | 只搜每条会话最后一条已完成回答 | 依赖 DSH 内置全文索引 | 由模型调工具 |
| 单次搜索（5 次中位） | **0.7ms**（0.4–13ms） | 12.6 秒 | 装上后检索报错，无结果 | — |
| 首次可用 | 后台自动建库，约 4.7 秒建完 | 首次成功 14.5 秒 | — | — |
| 中文连写 | 子串扫描 + 两字切块兜底 | 依赖引擎分词 | 依赖引擎分词 | 依赖引擎分词 |
| 依赖 | 零依赖、无构建 | — | 需先手动启用内置 FTS，rc.4 下仍不兼容 | 安装被版本门禁拒绝 |

计数口径不同（本插件默认只搜用户输入，dsh-session-search 只搜助手最终回答），延迟可比，命中数不可直接横比。竞品在功能广度上更全（模糊匹配、错字容忍、时间范围），本插件刻意只做「快速找回自己说过的话」这一件事。

## 安装

装完刷新页面（或重启 `dsh web`）。侧栏「插件」页的已安装列表里能看到「会话历史搜索」，可以随时停用。

**1) 从 GitHub 源码安装**

```bash
dsh plugin --profile web add github:OWNER/dsh-session-history-search
```

**2) 让 AI 助手帮你装**

把这句话发给任意能执行命令的 agent：

> 根据 `OWNER/dsh-session-history-search` 仓库里的 INSTALL_GUIDE.md 安装并验证这个插件。

`dsh plugin add` 把包名直接转给 pnpm 装进 profile，并把 bundle 加进 `dsh.profile.bundles`。本插件是纯 JS、没有构建步骤，git 安装不需要额外授权 `allowBuilds`。

## 怎么用

- **点侧栏「工作区」标题行第一个图标**（放大镜里带钟针，和右侧自带的标题搜索区分开）打开搜索框。
- 输入即搜（260ms 防抖），多关键词默认要求**同一段消息里全部出现**才命中；中文长串搜不到时自动按两字切块兜底。
- 输入框内三个开关：`Aa` 区分大小写、`ab` 整词、`.*` 正则。
- 第二行「搜索：☐ 输入 ☐ 输出」控制搜哪一池；右侧三个图标：工作区多选（文件夹）、按会话分组（列表）、排序（时间 / 相关性）。
- 鼠标停在结果行上会弹出命中消息的预览（命中处前 100 字 + 命中段 + 后 100 字，关键词高亮）。

![悬停预览](docs/preview-hover.png)
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
| 冷建（首次安装） | 137 个会话 / 192MB 约 4.7 秒建完；Host 启动 0.3 秒后自动开始，边建边可搜，页面第一次出结果约 2.4 秒 |
| 再次启动（有侧车） | 不重建，读侧车约 3ms |
| 某会话日志变大 | 只解新增帧，约 4ms |
| 单次搜索（含标题、工作区） | 0.4–13ms，5 次中位 0.7ms |
| 内存语料扫描 | 751 条约 0.13ms；10 万条约 46ms |
| 磁盘占用 | 侧车索引约 2.5MB（不复制日志正文） |

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

## 发布（维护者用）

仓库已就绪，推送前把 README 里的 `OWNER` 换成你的 GitHub 账号：

```bash
gh repo create OWNER/dsh-session-history-search --public --source=. --push \
  --description "DSH 侧栏内联的会话历史搜索：按你输入过的内容找回忘记的会话（中文友好、毫秒级、零依赖）"
gh repo edit --add-topic dsh-plugin --add-topic dsh --add-topic session-search --add-topic conversation-history
```

`package.json` 里的 `engines.dsh` 已经写好，插件列表的名称和描述来自 `locale/*.json` 的 `meta`。

## License

MIT
