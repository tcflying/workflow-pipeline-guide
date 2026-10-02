# Workflow Pipeline Guide — 双端工作流实时 UI 使用说明

在 **DSH Desktop**（官方桌面版 2.0.13+ / 社区企业版）与 **MiniMax Code**（3.1.0+）中，把 dynamic-workflow 引擎的工作流运行实时渲染成 ZCode 风格的进度卡片与侧栏进度线。

> 组件三件套：
> - **引擎** `dynamic-workflow`（wf.mjs）— 工作流运行时：agent 编排 / ask 问答 / journal 重放 / 断点恢复
> - **DSH 客户端插件** `@dsh-external/dsh-workflow-pipeline` — cordis 插件，随宿主自启
> - **MMX sidecar** `mmx-workflow-pipeline` — 宿主 API + CDP 注入器（MiniMax 无插件机制，走注入）

---

## 1. 功能总览

| 功能 | DSH | MMX |
|---|---|---|
| 会话内实时运行卡片（阶段列 / 子代理胶囊 / 脚本 / 日志） | ✅ | ✅ |
| 卡片内问答（ask）：输入框 + 回答按钮，答案写回引擎 | ✅ | ✅ |
| 停止（⏹）/ 恢复（↻）/ 展开（⤢）/ 手动关闭（×） | ✅ | ✅ |
| 发现看板（按严重度分组 findings）/ 结果 / 历史弹窗 | ✅ | ✅ |
| 侧栏会话行下进度线（⑂ + 阶段点 + 当前阶段名） | ✅ 绑定驱动 | ✅ 绑定驱动 |
| 新建对话页（home 路由）永不显示卡片 | ✅（无 home 路由概念） | ✅ 三态机识别 |
| 多工作流并发，卡片互不串扰（runKey 隔离） | ✅ | ✅ |
| 卡片常驻规则 | 运行中自动显示；已结束的卡**无 TTL**，只能手动 × 关闭；曾被看到（观看集）的卡跨刷新保留 | 同左 |
| 产物（artifacts）经认证 API 下载，Blob 链接自动回收 | ✅ | ✅ |

### 归属规则（防串会话，不猜）

一个运行卡片/侧栏线只出现在**它归属的会话**里。归属来源按优先级：

1. **原生来源**（`hostSession`）：引擎在 run 启动时记录的宿主会话 id。DSH 由宿主环境变量提供（native-shell）；MMX 由 PreToolUse hook 中继追加（native-hook）。
2. **手动绑定**：卡片上的「🔗 绑定当前会话」按钮，或历史弹窗里的绑定/解绑。
3. **都无** → 未绑定：运行中的卡仍显示在当前视图（供绑定）；已结束且从未被观看的卡只进全局历史弹窗，不自动出现。

## 2. 端口与布局

| 宿主 | webServer | 组件端口 | CDP（调试/验收用） |
|---|---|---|---|
| DSH 官方桌面版 2.0.13 | 43120 | —（同源 API） | 9224（启动时加 `--remote-debugging-port=9224`） |
| DSH 社区企业版（dev） | 43130 | —（同源 API） | 9223 |
| MiniMax Code 3.1.0 | — | sidecar API 4231 / CDP 9331 | 9331（sidecar 注入用） |
| wf UI 看板（可选） | — | 4230 | — |

固定端口，被占报错退出、不漂移。

## 3. 安装

### 3.1 DSH 官方桌面版

前提：官方版 2.0.13+，profile 位于 `~/.dsh/profiles/desktop`。

```bash
cd ~/.dsh/profiles/desktop
cp package.json package.json.bak-$(date +%Y%m%d-%H%M%S)   # 先备份

# 1) package.json: dependencies 加本地包 + dsh.profile.bundles 加包名
#    dependencies["@dsh-external/dsh-workflow-pipeline"] = "file:<仓库>/dsh-workflow-pipeline"
#    dsh.profile.bundles += "@dsh-external/dsh-workflow-pipeline"

# 2) 安装依赖
pnpm install --prefer-offline

# 3) 重要：pnpm 对 file: 依赖不自动刷新内容，手动覆盖一次
cp <仓库>/dsh-workflow-pipeline/{client.js,package.json,index.mjs,run-lifecycle.mjs} \
   node_modules/@dsh-external/dsh-workflow-pipeline/

# 4) 重启 DSH Desktop
```

**警告**：绝不在 DSH 运行中执行 pnpm install / 覆盖 node_modules——官方版会触发渲染器崩溃循环（watchdog 反复恢复失败）。先退出再操作。

### 3.2 DSH 社区企业版（dev 实例）

```bash
DST="$APPDATA/dsh-desktop-dev/harness/profiles/web/node_modules/@dsh-external/dsh-workflow-pipeline"
cp <仓库>/dsh-workflow-pipeline/{client.js,package.json,index.mjs,run-lifecycle.mjs} "$DST/"
# 校验哈希一致后重启企业版
```

包的 `package.json` 必须带（官方版收集器严格，缺一不加载；企业版宽松但保持一致）：

```json
{
  "dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-runtime"], "immediately": true, "platform": "web" } },
  "exports": { ".": "./index.mjs", "./client": "./client.js", "./package.json": "./package.json" }
}
```

### 3.3 MiniMax Code（sidecar 注入）

```bash
cd <仓库>/mmx-workflow-pipeline
node sidecar.mjs --root <工作区根>          # 常驻；--root 可重复
# 可选: --launch 自动拉起 MiniMax；--no-launch 要求 CDP 已开；--kill-on-exit
```

- MiniMax 需带调试口启动：`MiniMax Code.exe --remote-debugging-port=9331`
- sidecar 每次启动生成随机 capability 注入客户端（不出现在 URL/存储/日志），重启即轮换
- 注入是幂等的：MiniMax 重启/新开页面会自动重注入（版本门控，旧实例自动被新版本替换）

### 3.4 引擎部署（给 agent 用的 skill）

```bash
node <仓库>/mmx-workflow-pipeline/install-skills.mjs --force   # 引擎版本不符时（0.8.1）
```

装到 `~/.minimax/skills/dynamic-workflow`（MiniMax 侧唯一生效的 skill 根）。`--force` 会保留一份带时间戳的旧版备份。校验：

```bash
grep -o "ENGINE_VERSION = '[^']*'" ~/.minimax/skills/dynamic-workflow/runtime/wf.mjs
```

## 4. 使用

### 4.0 MiniMax 完整使用顺序（三步）

```bash
# ① 启动 MiniMax（带调试口；已开着就跳过）
"C:\Program Files\...\MiniMax Code.exe" --remote-debugging-port=9331
#    或直接 node sidecar.mjs --launch 让 sidecar 代拉

# ② 启动 sidecar（常驻；看到 "workflow renderer attached" 即注入成功）
cd mmx-workflow-pipeline && node sidecar.mjs --root <工作区根>

# ③ 跑工作流（用装到 MiniMax 的引擎，与 DSH 侧同一引擎）
node ~/.minimax/skills/dynamic-workflow/runtime/wf.mjs run <script.mjs> --backend file
```

跑起来后：切到**会话页**（不是新建对话页）→ 顶部出现实时卡片 → 点「🔗 选择会话…」选一个会话 → **左侧栏该会话行下立即出现进度线**（⑂ + 阶段点 + 阶段名），并随阶段实时更新。

### 4.1 跑一个工作流

让 agent（或在终端）执行：

```bash
node wf.mjs run <script.mjs> --backend file        # file 后端支持 ask 卡片问答
node wf.mjs run <script.mjs> --backend file --name 自定义名
```

脚本三件套：`agent()`（子代理）、`ask()`（向用户提问，出现在卡片上）、`phase()`（阶段）。详见引擎 SKILL.md。

### 4.2 卡片上的操作

- **❓ 提问**：引擎 `ask()` 停靠时，卡片出现输入框 + 「回答」按钮；提交后按钮变「已提交」，答案经 sidecar 写回引擎 inbox。
- **⏹ 停止**：发送停止请求，按钮变 `…`（已发送），引擎确认后卡片翻转为已取消。
- **↻ 恢复**：失败/取消/中断的运行可恢复（同 runId 断点续跑；已答的问题按调用位置缓存重放）。
- **× 关闭**：唯一移除卡片的方式（无 TTL 自动消失）。关闭记录持久化，刷新不复活。
- **⤢ 展开**：卡片全屏查看长结果。
- **📋 发现看板 / 📄 结果 / 🗂 历史**：弹窗视图；长文本自动截断并提供完整下载。

### 4.3 侧栏进度线

侧栏会话行下的 `⑂ 阶段点 阶段名` 是**绑定驱动**的：

- **选会话绑定（MMX 3.1.0 唯一可用路径）**：该构建的 DOM 里没有活动会话标记，所以一键"绑定当前会话"不会渲染；卡片提供「🔗 选择会话…」，列出侧栏全部会话（带 `data-session-id` 的行），点一个即绑定——显式用户操作，不是猜。会话行可以很多（实测 3.1.0 侧栏 517+ 个），弹窗顶部有筛选框，按标题或会话 ID 实时过滤，标题上方显示「命中 / 总数」计数；重新打开弹窗筛选自动清空。**历史弹窗的每一行同样提供「🔗 选择会话…」**——已结束的运行也能归属（v8 之前历史行只有一个永远禁用的死按钮）。绑定后卡片保留在当前视图，直到手动关闭。
- 一键绑定：宿主暴露活动会话标记时，卡片显示「🔗 绑定当前会话」（DSH 走 `ctx.sessions`，正常可用）。
- 自动绑定：agent 通过原生来源跑工作流（DSH 宿主变量 / MMX hook）→ 无需操作。**MMX 需先激活原生 hook 插件，见第 6 节已知限制**。
- 多个运行绑到同一会话时，侧栏显示最新启动的一个；卡片仍全部显示。
- 换绑/解绑：🗂 历史 弹窗里对任意运行操作。

### 4.4 新建对话页（MMX）

MiniMax 的新建对话页（mavis-home-content）**不承载任何卡片**——包括运行中的。这是设计行为（024-R4）：会话卡片只出现在会话视图。要找运行：切回会话页，或开 🗂 历史。

## 5. 排障

| 症状 | 原因与处理 |
|---|---|
| MMX 页面没有任何卡片/样式 | sidecar 没活：`netstat -ano | findstr 4231` 查监听；重启 sidecar 看日志出现 `workflow renderer attached` |
| 卡片长时间不更新 | 窗口最小化时 Chromium 冻结定时器（实测 1500ms→8s 不触发）。已内置 visibilitychange 补拉：把窗口调回前台约 2s 内刷新 |
| MMX 侧栏无线 | ① 该构建无活动会话标记 → 用卡片「🔗 选择会话…」显式绑定；② 已绑定仍无线：确认绑定的是侧栏可见会话（`data-session-id`），并清 localStorage `mmxdwf-session-bindings` 后重绑 |
| MMX 跑出来的是旧引擎行为 | `grep -o "ENGINE_VERSION = '[^']*'" ~/.minimax/skills/dynamic-workflow/runtime/wf.mjs` 应为 0.8.1，否则 `install-skills.mjs --force` |
| DSH 页面没加载插件（官方版） | 检查包 package.json 是否带 `dsh.client` + `exports["./client"]`（见 3.1）；node_modules 是否刷新（pnpm 不覆盖 file: 内容） |
| `EADDRINUSE 127.0.0.1:43130` | 企业版 appserver 已有实例在跑（app 自愈机制）。不要重复拉起 |
| 渲染器崩溃循环（官方版） | 近期在 app 运行中动过 node_modules。退出 app → 重新部署 → 再启动 |
| /runs 返回 403 | capability 失配（sidecar 重启后旧页面 capability 过期）。刷新页面即重新注入新 capability |

## 6. 已知限制

- **MMX 原生 hook 自动归属未激活**：MiniMax 3.1.0 的本地插件安装通道关闭（`LOCAL_PLUGIN_INSTALL_UNSUPPORTED`；本地包拷入 `~/.minimax/plugins/` 不被扫描接纳，仅市场包激活——对照：lark 的市场包 hook 正常物化，本地包全部 0 激活）。hook 插件包已就绪（`plugins/mmx-native-session-hook/`，PreToolUse 中继，观察型 fail-open），激活路径 = 市场发布或官方开放本地安装。**当前用卡片「🔗 选择会话…」手动绑定代替**，功能等价（归属仍可验证），代价是每个运行多一次点击。
- **MMX 3.1.0 不暴露活动会话标记**：`[data-shortcut-session-active][data-shortcut-session-target]` 在当前构建的 DOM 中不存在，故一键绑定不可用；已用「选择会话…」补齐。宿主若将来恢复该标记，一键绑定会自动重新出现（两者并存不冲突）。
- DSH 侧栏逐行展开点为宿主限制，未提供。
- 引擎 `ask()` 无应答 1 小时超时（引擎设计），超时后运行失败属正确行为。

## 7. 目录结构

```
dsh-workflow-pipeline/     # DSH cordis 插件（client.js 渲染层 + index.mjs 宿主 API）
mmx-workflow-pipeline/     # MMX sidecar（宿主 API + CDP 注入器 + client-inject.js）
plugins/dynamic-workflow/  # 引擎 skill（runtime/wf.mjs）+ 测试
plugins/mmx-native-session-hook/  # MMX 原生 hook 插件包（待激活）
workflow-ui-evidence-20260929/    # 验收证据/截图/探针脚本（开发存档）
```

## 8. 安全设计要点

- 渲染层→sidecar 的每个请求带随机 capability（闭包内单字面量，注入时替换），URL/存储/日志零泄露；未知 origin 无 CORS 授权
- 产物下载走认证 API + Blob（真实路径永不成为链接）；外链仅 http(s) 白名单
- 运行寻址用 runKey（真实目录 SHA-256），裸 runId 跨工作区歧义时 409 拒绝
- 全部变更类请求带 startedAt 生命周期校验，过期 409 STALE_LIFECYCLE

---

*端口、路径以「固定端口、被占报错退出」为纪律；本说明对应包版本：dsh-workflow-pipeline 0.2.6 / client-inject v8（含选择器筛选、绑定后卡片保留、历史行选择会话、无卡片时历史入口） / 引擎 0.8.1。*
