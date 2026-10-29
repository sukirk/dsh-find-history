# dsh-find-history · 查找历史

在 DSH Web 侧栏「工作区」标题行加一个图标。点开输入关键词，就能在所有工作区里搜出**你自己说过的内容**，找回忘记的会话继续聊。

毫秒级、中文友好、零依赖、不部署任何索引服务。

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/DSH-0.2.1--rc.x-7c3aed" alt="DSH">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="dependencies">
</p>

<p align="center">
  <img src="docs/preview-hover.png" alt="侧栏里搜索，悬停看命中原文" width="380">
</p>

## 好在哪

- **毫秒级**：同机同数据，单次 0.4–13ms，5 次中位 0.7ms。同类插件是 22–38ms 到 12s。
- **装完就能搜**：不需要 FTS、不需要建索引服务。首次后台回填 137 个会话 / 192MB 只要 4.7s，边建边出结果（约 2s），父进程内存不涨。
- **只搜你说过的话**：默认输入池，不会把技能目录、运行时上下文这类 Harness 注入当成你的话；要翻结论时勾「输出」。
- **中文不用分词**：`炒股界面` 能直接命中「优化炒股界面与 K线缩放」，长串搜不到时自动按两字切块兜底。
- **就在侧栏里**：结果铺在「工作区」下面，关键词高亮，悬停看命中原文，点一下跳到那条消息并高亮——不弹独立面板、不打断当前对话。
- **零依赖、无构建**：5 个 JS 文件，`dsh plugin add` 直接装，不需要 `allowBuilds`，卸载删目录即净。

## 和同类比

同一台机器、同一份真实数据（137–141 个会话 / 192MB 日志），5 次中位：

| | **本插件** | [Victue](https://github.com/Victue/dsh-session-search) 0.3.2 | [session-flow](https://github.com/YeqingTang/dsh-session-flow) 1.5.0 | [Ziminli](https://github.com/Ziminli/dsh-session-search) 0.1.1 |
| --- | --- | --- | --- | --- |
| 单次搜索 | **0.7ms**（0.4–2.8ms） | 22–36ms | 33–38ms | 12.6s |
| 首次可用 | 后台建库，~2s 出结果、4.7s 建完 | 建索引 5.7s | 首查 2.9–3.8s | 首次成功 14.5s |
| 搜的范围 | 你的输入（可加回答） | 全库正文 | 只扫最近 20 个会话 | 每条会话最后一条回答 |

口径：Victue 自己维护全量索引，之后按索引搜；session-flow 每次只扫最近 20 个会话（5 秒预算），旧会话会漏；Ziminli 只索引每会话最后一条已完成回答，搜用户原话（如「部署脚本」）是 0 命中。命中数口径不同，延迟可直接比。

## 安装

装完刷新页面即可，侧栏「插件」页能看到「查找历史」，可随时停用。

**从 GitHub 装**

```bash
dsh plugin --profile web add github:OWNER/dsh-find-history
```

**让 AI 助手装**

> 根据 `OWNER/dsh-find-history` 仓库里的 INSTALL_GUIDE.md 安装并验证这个插件。

纯 JS、无构建步骤，git 安装不需要授权 `allowBuilds`。

## 边界

- 兼容 DSH `0.2.1-rc.x` 的 web profile，Node ≥ 22（用内置 zstd 逐帧解压，不依赖 `zstd` 命令）。
- 只读 `~/.dsh/sessions/`，只写 `~/.dsh/cache/find-history/`，不发网络请求。归档会话不参与搜索。
- 输出池只收每轮最终回答，过程消息和工具调用不入库。
- 侧栏标题行没有公开插槽，入口图标是注入 DOM 实现的，DSH 大改版时这里可能要跟着改。

<details>
<summary><b>实现细节：为什么是毫秒级</b></summary>

<img src="docs/flow.png" alt="日志 → 侧车索引 → 内存匹配 → 侧栏面板" width="700">

<img src="docs/sequence.png" alt="一次搜索的 8 个步骤" width="400">

DSH 把每个会话写成 `~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`，是**多帧 zstd** 拼接，不是明文，不能直接 grep。本插件的做法：

1. 扫帧头（`0x28 0xb5 0x2f 0xfd`）拿到帧边界；
2. 逐帧解压后**只解析命中的行**（`"type":"user/message"`、`"assistant/message"`、`"session/title"`），其余整行跳过；
3. 每个会话写一个**侧车文件**，记录读到的字节数、帧数、标题和提取出的文本；
4. 日志变大时**只从上次字节位置续读**（尾部增量），不重扫；
5. 首次安装把回填丢给**子进程分批做**（每批 12MB、最多 2 个 worker）；
6. 搜索就是**内存里扫 700 多条消息**，0.1ms 量级。

侧车文件（只存提取出的文本和读到的位置，不存日志原文）：

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

| 实测项（134 会话 / 193MB 压缩 / 818MB 解压） | 结果 |
| --- | --- |
| 冷建（首次安装） | 137 个会话 / 192MB 约 4.7s；Host 启动 0.3s 后自动开始 |
| 再次启动（有侧车） | 不重建，读侧车约 3ms |
| 某会话日志变大 | 只解新增帧，约 4ms |
| 单次搜索（含标题、工作区） | 0.4–13ms，5 次中位 0.7ms |
| 磁盘占用 | 侧车索引约 2.5MB（不复制日志正文） |

目录：

```
index.mjs      Host：HTTP 路由、语料、匹配、回填调度
scan.mjs       多帧 zstd 读取、行预筛、标题/消息提取
store.mjs      侧车读写、增量续读、旧缓存迁移
backfill.mjs   回填子进程（每批约 12MB，最多 2 并发）
client.js      Client：侧栏入口、内联面板、结果渲染
cordis.patch.yml / icon.svg / locale/
```

改图或改文案后重跑 `python3 docs/src/gen.py` 会重新出图。

</details>

## License

[MIT](LICENSE)
