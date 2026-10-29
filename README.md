# dsh-find-history · 查找历史

给 DSH Web 侧栏加一个检索入口：在「工作区」标题行点击图标，即可跨所有工作区搜索**你自己输入过的内容**，定位忘记的会话并继续对话。

单次搜索 0.4–13ms、中文子串匹配、零依赖、无需部署索引服务。

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/DSH-0.2.1--rc.x-7c3aed" alt="DSH">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="dependencies">
</p>

<p align="center">
  <img src="docs/preview-hover.png" alt="在侧栏搜索并悬停查看命中原文" width="360">
</p>

## 优点

- **毫秒级返回**：同机同数据单次 0.4–13ms，5 次中位 0.7ms；同类插件在 22–38ms 至 12s 区间。
- **开箱即用**：不依赖 FTS，也不需要额外的索引服务。首次安装后台回填 137 个会话 / 192MB 约 4.7s，边建边搜（约 2s 出首批结果），父进程内存不随索引增长。
- **只索引真实输入**：默认只收录你输入的内容，技能目录、运行时上下文等 Harness 注入不会混入结果；需要检索回答时勾选「输出」。
- **中文无需分词**：`炒股界面` 可直接命中「优化炒股界面与 K线缩放」；长串无命中时自动按两字切块兜底。
- **侧栏内联交互**：结果直接铺在侧栏内，关键词高亮，悬停预览命中原文，点击跳转到对应消息并定位高亮，不弹独立窗口。
- **零依赖、无构建**：5 个 JS 文件，`dsh plugin add` 直接安装，无需 `allowBuilds`，卸载后删除缓存目录即可。

## 使用

1. 点击侧栏「工作区」标题行的图标（放大镜内含时钟，排在自带搜索图标左侧）。
2. 输入关键词。默认检索你的输入，勾选「输出」后同时检索每轮最终回答。
3. 搜索框右侧三个开关：`Aa` 区分大小写、`ab` 整词匹配、`.*` 正则。第二行图标依次为工作区筛选（多选）、按会话分组、排序（时间 / 相关性）。
4. 悬停结果行预览命中原文；点击打开会话，并滚动高亮到命中的那条消息。
5. 归档会话不参与搜索；命中归档会话时，打开前会自动解除归档。

## 性能对比

同一台机器、同一份数据（137–141 个会话 / 192MB 日志），各取 5 次中位：

| | **本插件** | [Victue](https://github.com/Victue/dsh-session-search) 0.3.2 | [session-flow](https://github.com/YeqingTang/dsh-session-flow) 1.5.0 | [Ziminli](https://github.com/Ziminli/dsh-session-search) 0.1.1 |
| --- | --- | --- | --- | --- |
| 单次搜索 | **0.7ms**（0.4–2.8ms） | 22–36ms | 33–38ms | 12.6s |
| 首次可用 | 后台建库，约 2s 出结果、4.7s 建完 | 建索引 5.7s | 首查 2.9–3.8s | 首次成功 14.5s |
| 检索范围 | 用户输入（可选回答） | 全库正文 | 最近 20 个会话 | 每会话最后一条回答 |

说明：Victue 维护全量索引后按索引检索；session-flow 每次仅扫描最近 20 个会话（5 秒预算），较早的会话不会命中；Ziminli 只索引每会话最后一条已完成回答，检索用户原话（如「部署脚本」）为 0 命中。三者检索范围不同，命中数不可直接比较，延迟可横向比较。

## 安装

安装后刷新页面，侧栏「插件」页会出现「查找历史」，可随时停用。

**从 GitHub 源码安装**

```bash
dsh plugin --profile web add github:OWNER/dsh-find-history
```

**交由 AI 助手安装**

> 根据 `OWNER/dsh-find-history` 仓库中的 INSTALL_GUIDE.md 安装并验证该插件。

包为纯 JS、无构建步骤，git 安装无需授权 `allowBuilds`。

## 兼容性与限制

- 适用于 DSH `0.2.1-rc.x` 的 web profile，要求 Node ≥ 22（使用内置 zstd 逐帧解压，不依赖 `zstd` 命令）。
- 只读取 `~/.dsh/sessions/`，只写入 `~/.dsh/cache/find-history/`，不发起网络请求。
- 输出池仅收录每轮最终回答，过程消息与工具调用不入库。
- 侧栏标题行没有公开插槽，入口图标通过注入 DOM 实现，DSH 侧栏结构大改时可能需要适配。

<details>
<summary><b>实现原理</b></summary>

<img src="docs/flow.png" alt="日志 → 侧车索引 → 内存匹配 → 侧栏面板" width="680">

DSH 将会话写入 `~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`，为多帧 zstd 拼接格式，无法直接检索。插件的处理流程：

1. 扫描 zstd 帧头（`0x28 0xb5 0x2f 0xfd`）获取帧边界；
2. 逐帧解压后仅解析目标类型的行（`user/message`、`assistant/message`、`session/title`），其余行跳过；
3. 每个会话生成一个侧车文件，记录已读取字节数、帧数、标题与提取出的文本；
4. 日志增长时从上次字节位置续读，仅解压尾部新增帧；
5. 首次安装由子进程分批回填（每批约 12MB，最多 2 个并发 worker）；
6. 检索阶段在内存中扫描全部提取文本，量级为亚毫秒。

<img src="docs/sequence.png" alt="一次搜索的 8 个步骤" width="380">

| 实测项（134 会话 / 193MB 压缩 / 818MB 解压） | 结果 |
| --- | --- |
| 冷建（首次安装） | 137 个会话 / 192MB 约 4.7s；Host 启动 0.3s 后自动开始 |
| 再次启动 | 不重建，读取侧车约 3ms |
| 会话日志增长 | 仅解压新增帧，约 4ms |
| 单次搜索（含标题、工作区） | 0.4–13ms，5 次中位 0.7ms |
| 磁盘占用 | 侧车索引约 2.5MB（不复制日志正文） |

文件结构：

```
index.mjs      Host：HTTP 路由、语料、匹配、回填调度
scan.mjs       多帧 zstd 读取、行预筛、标题/消息提取
store.mjs      侧车读写、增量续读、旧缓存迁移
backfill.mjs   回填子进程（每批约 12MB，最多 2 并发）
client.js      Client：侧栏入口、内联面板、结果渲染
cordis.patch.yml / icon.svg / locale/
```

修改示意图后执行 `python3 docs/src/gen.py` 重新生成 PNG。

</details>

## License

[MIT](LICENSE)
