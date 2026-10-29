# Contributing / 开发说明

## 文件结构

```
index.mjs          Host：HTTP 路由、语料、检索、回填调度
scan.mjs           多帧 zstd 读取、行预筛、标题/消息提取
store.mjs          侧车读写、增量续读、旧缓存迁移
backfill.mjs       回填子进程（每批约 12MB，最多 2 并发）
client.js          Client：侧栏入口、内联面板、结果渲染
cordis.patch.yml   bundle 声明
icon.svg           插件列表图标
locale/            zh / en 文案
docs/              README 截图与示意图（含生成脚本）
```

## 本地开发

```bash
# 直接把本地目录装进 profile；改动 Host 代码后需要重装才生效
dsh plugin --profile web add /path/to/dsh-find-history
```

Host half 改动：`dsh plugin --profile web remove dsh-find-history` 再 `add` 一次，然后刷新页面。
Client half 改动：重装后刷新页面即可。

## 重新生成示意图

两张示意图是手写 SVG，经 headless Chrome 2 倍分辨率截图得到 PNG。

```bash
python3 docs/src/gen.py
```

依赖：`google-chrome`（或改脚本里的浏览器命令）、Noto Sans CJK 字体。脚本会重写 `docs/flow.png` 与 `docs/sequence.png`。

## 测量方法

表中数字均为本机实测，同一份会话日志（142 个会话 / 196MB 压缩）上取 5 次中位，计时口径为 HTTP 路由的端到端耗时，不含前端防抖与渲染。对比插件按各自文档提供的 HTTP 接口或 UI 路径测得，版本号见 README 表格。
