# dsh-find-history · 查找历史

在 DSH Web 侧栏「工作区」标题行注入一个检索图标：点击后在侧栏内跨所有工作区搜索**你输入过的内容**，定位并打开那个忘记的会话。

单次搜索中位 0.7ms · 无外部索引服务 · 中文子串匹配 · 零依赖、无构建

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/DSH-0.2.1--rc.x-7c3aed" alt="DSH">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="dependencies">
</p>

<p align="center">
  <img src="docs/panel.png" alt="侧栏内联搜索结果：关键词高亮，每行显示会话标题、命中片段、工作区与时间" width="360">
</p>
<p align="center"><sub>结果直接铺在侧栏内，关键词高亮；悬停可预览命中原文。</sub></p>

## 与自带搜索的分工

DSH 侧栏已有一个搜索图标，它按会话标题匹配；本插件检索的是消息正文。

| | 侧栏自带搜索 | 本插件 |
| --- | --- | --- |
| 检索对象 | 会话标题 | 消息正文：你输入的内容，可选每轮回答 |
| 适用场景 | 记得会话叫什么 | 记得某句话，但忘了它在哪个会话 |

## 优点

- **毫秒级返回**：同一台机器、同一份数据，单次检索中位 0.7ms（p95 2.8ms，最差 13ms）；同类插件在 22–38ms 到 12s 区间。
- **安装后即可用**：不依赖 FTS，也没有外部索引服务。首次启动在后台构建约 3MB 的侧车索引，约 2s 出首批结果、4.7s 建完；回填在子进程中完成，Host 常驻内存峰值约 70MB。
- **只索引真实输入**：默认只收录你输入的内容，技能目录、运行时上下文这类 Harness 注入不会混进结果；需要检索回答时勾选「输出」。
- **中文无需分词**：`炒股界面` 能直接命中「优化炒股界面与 K线缩放」；长关键词无命中时自动退化为按二字切块匹配。
- **侧栏内联交互**：结果铺在侧栏内、关键词高亮，悬停预览命中原文；点击打开会话并滚动到首个关键词处高亮（命中消息尚未加载时停在会话顶部）。
- **零依赖、无构建**：5 个 JS 文件，`dsh plugin add` 直接安装，无需 `allowBuilds`，没有需要运行的构建脚本。

## 安装

安装完成后刷新页面，侧栏「插件」页会出现「查找历史」，可随时停用。把下面命令里的 `OWNER` 换成仓库实际所有者。

**从 GitHub 源码安装**

```bash
dsh plugin --profile web add github:OWNER/dsh-find-history
```

**交由 AI 助手安装**

> 根据 `OWNER/dsh-find-history` 仓库中的 INSTALL_GUIDE.md 安装并验证该插件。

包为纯 JS、无构建步骤，git 安装无需授权 `allowBuilds`。

## 用法

点击「工作区」标题行的图标（放大镜内含时钟，排在自带搜索图标左侧），输入关键词即可。

| 操作 | 说明 |
| --- | --- |
| 检索范围 | 默认只搜你的输入；勾选「输出」后同时搜每轮最终回答 |
| 多关键词 | 空格分隔；同一条消息内全部命中优先，不足时用部分命中补足 |
| `Aa` | 区分大小写 |
| `ab` | 整词匹配 |
| `.*` | 正则，输入不合法时面板会提示 |
| 文件夹图标 | 按工作区筛选，可多选 |
| 列表图标 | 按会话分组，显示每会话的命中位置 |
| 排序图标 | 按时间（默认）或按相关度 |
| 键盘 | `↑` `↓` 选择，`Enter` 打开，`Esc` 关闭 |
| 点击结果 | 打开会话并高亮首个关键词；归档会话会先自动解除归档 |
| 分页 | 每页 24 条，底部「加载更多」 |

<p align="center">
  <img src="docs/preview-hover.png" alt="悬停结果行时预览命中原文，关键词高亮" width="300">
</p>
<p align="center"><sub>悬停结果行可预览命中原文，命中处高亮。</sub></p>

## 性能对比

测量条件：2026-10-28，DSH `0.2.1-rc.4`，Linux，142 个会话 / 196MB 压缩日志（解压 818MB），同一台机器，各取 5 次中位。

| | **本插件** | [Victue](https://github.com/Victue/dsh-session-search) 0.3.2 | [session-flow](https://github.com/YeqingTang/dsh-session-flow) 1.5.0 | [Ziminli](https://github.com/Ziminli/dsh-session-search) 0.1.1 |
| --- | --- | --- | --- | --- |
| 单次检索 | **0.7ms**（p95 2.8ms） | 22–36ms | 33–38ms | 12.6s |
| 首次可用 | 后台建索引，约 2s 出结果、4.7s 建完 | 建索引 5.7s | 首查 2.9–3.8s | 首次成功 14.5s |
| 检索范围 | 用户输入（可选回答） | 全库正文 | 最近 20 个会话 | 每会话最后一条回答 |

说明：三者检索范围不同，因此只比较端到端耗时，不比较召回覆盖率。Ziminli 每次查询都重读会话日志，12.6s 是这种实现方式的固有成本；session-flow 每次仅扫描最近 20 个会话（5 秒预算），较早的会话不会命中；Victue 与本插件都维护本地索引，差别在索引成本与查询路径。

## 隐私与数据

- 只读取 `~/.dsh/sessions/` 下的会话日志，只写入 `~/.dsh/cache/find-history/`。
- 侧车索引包含你输入过的文本和每轮回答的纯文本（约 3MB），不含日志原文；删除该目录即清空。
- 不访问外部网络。检索请求走本地同源路由 `/dsh-find-history/search`。
- 归档会话不进索引。

彻底卸载：

```bash
dsh plugin --profile web remove dsh-find-history && rm -rf ~/.dsh/cache/find-history
```

## 兼容性与已知限制

- 适用于 DSH `0.2.1-rc.x` 的 web profile，需要 Node ≥ 22（用内置 zstd 逐帧解压，不依赖 `zstd` 命令）；目前只在 Linux 上实测。
- 侧栏标题行没有公开插槽，入口图标通过注入 DOM 实现。若图标未出现：先刷新页面，再确认侧栏「插件」页里「查找历史」处于启用状态。DSH 侧栏结构变更时这里需要适配。
- 高亮依赖浏览器的 CSS Custom Highlight API（Chromium 105+）；不支持时只滚动定位、不高亮。
- 输出池仅收录每轮最终回答，过程消息与工具调用不入库。
- 索引构建时间随会话数线性增长；检索是内存扫描，10 万条消息约 46ms，会话规模增大时检索仍是毫秒级。

<details>
<summary><b>实现原理：为什么是毫秒级</b></summary>

<img src="docs/flow.png" alt="数据流：会话日志 → 侧车索引 → 内存匹配 → 侧栏面板" width="680">

DSH 将会话写入 `~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`，为多帧 zstd 拼接格式，无法直接检索。处理流程：

1. 扫描 zstd 帧头（`0x28 0xb5 0x2f 0xfd`）获取帧边界；
2. 逐帧解压后仅解析目标类型的行（`user/message`、`assistant/message`、`session/title`），其余行跳过；
3. 每个会话生成一个侧车文件，记录已读取字节数、帧数、标题与提取出的文本；
4. 日志增长时从上次字节位置续读，仅解压尾部新增帧；
5. 首次安装由子进程分批回填（每批约 12MB，最多 2 个并发 worker）；
6. 检索阶段在内存中扫描全部提取文本。

| 实测项 | 结果 |
| --- | --- |
| 冷建（首次安装） | 142 个会话 / 196MB 约 4.7s；Host 启动 0.3s 后自动开始 |
| 再次启动 | 不重建，读取侧车约 3ms |
| 会话日志增长 | 仅解压新增帧，约 4ms |
| 单次检索（含标题、工作区） | 中位 0.7ms，p95 2.8ms |
| 磁盘占用 | 侧车索引约 3MB（不复制日志正文） |

示意图与开发说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

</details>

## License

[MIT](LICENSE)
