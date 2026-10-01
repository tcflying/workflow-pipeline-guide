# mmx-workflow-pipeline 开发文档

> 目标：把 DSH 版 `dsh-workflow-pipeline` 的 ZCode 式工作流实时进度 UI **100% 复刻到 MiniMax Code**。
> MiniMax Code 无客户端插件机制（已实证，见"背景"），故采用 **CDP sidecar 外挂注入** 方案。
> 本文是唯一事实来源（single source of truth）：契约数字、坑位清单、阶段任务、验收标准全部以本文为准。

---

## 0. 背景（为什么只能外挂）

2026-09-28 实证（解包 `G:\MiniMax\MiniMax Code\resources\app.asar` 531MB）：

- MiniMax Code = `@mmx-agent/electron` 自研 Electron（主进程 `dist/main/index.js`，渲染层 `out/`，依赖 `@mavis/*`）
- **不是 VS Code fork**：无 extension host、无 product.json、无 `out/vs`
- **无 DSH 式客户端模块系统**：全包零命中 `ModuleLoader` / `client-modules`
- **无插件/扩展/市场配置**：`~/.minimax/config.yaml` 零命中 plugin/extension/market/addon；`~/.minimax/harnesses/installed` 为空
- 唯一 `inject.js`（`out/assets/inject.js`）是它自己往内嵌浏览器 webview 注的，非对外机制

结论：没有合法注入面。唯一 100% 复刻视觉的途径 = **对 renderer 走 Chrome DevTools Protocol 注入**（本会话在 DSH 上已用同一通道做过 DOM 级取证，技术路线已验证）。性质是外挂：窗口需带调试端口重启、随版本升级可能需适配选择器。

## 1. 架构

```
[MiniMax Code Electron]                    [mmx-sidecar (Node ≥20, 零依赖)]
  renderer (out/)                          ┌────────────────────────────────┐
    ↑ CDP :9331 ←──────────────────────────│ 1) HTTP host API :4231         │
    │  Page.addScriptToEvaluateOnNewDocument│    GET /runs    (实时进度列表) │
    │  Runtime.evaluate(立即注入)           │    GET /script?run= (脚本源码) │
    │  Page.reload 后自动重注               │    GET /result?run= (out.json) │
    │                                       │    POST /stop?run= (写 CANCEL) │
    └─ fetch http://127.0.0.1:4231/* ──────→│ 2) CDP 注入器（连接/重连/重注）│
        (CORS: sidecar 加 ACAO 头)          │ 3) 可选: spawn MiniMax Code    │
                                            └───────┬────────────────────────┘
                                                    │ 读
                                                    ↓
                              <workspace>/.qoder/workflow-runs/<runId>/progress.json
                              （dynamic-workflow 引擎 0.7.1 产出，不改动）
```

三份复用资产（**只读参考，不修改源文件**）：
- `G:\qoder-intl-project\else\dsh-workflow-pipeline\index.mjs` —— host API 的完整逻辑（/runs 扫描+缓存、/script、/result、/stop），移植时把 `ctx.webServer.register` 换成自起 `http.createServer`
- `G:\qoder-intl-project\else\dsh-workflow-pipeline\client.js`（v3, ~26.6KB）—— 客户端全部 UI 逻辑（卡片/侧栏行/模态框/看板/生命周期/×持久化），移植时只改 API 基址与 DOM 选择器
- `G:\qoder-intl-project\else\plugins\dynamic-workflow\skills\dynamic-workflow\` —— 引擎技能（0.7.1），安装到 `~/.minimax/skills/` 即可用

## 2. 硬契约（数字与路径，禁止偏离）

| 项 | 值 | 说明 |
|---|---|---|
| host API 端口 | **4231** | 固定端口纪律：永不变更、不漂移；被占直接报错退出。禁用名单 3300/4300/4301/3188/8400/17840/17841 已避开 |
| CDP 端口 | **9331** | 避开常用 9222-9229 与本会话用过的 9223 |
| MiniMax Code exe | `G:\MiniMax\MiniMax Code\MiniMax Code.exe` | spawn 时路径含空格，注意引号 |
| 工作流运行数据 | `<cwd>/.qoder/workflow-runs/<runId>/` | 引擎契约，见 §5 |
| 项目根 | `G:\qoder-intl-project\else\mmx-workflow-pipeline\` | 本项目 |
| 交付目录结构 | `sidecar.mjs` / `client-inject.js` / `launch-mmcode.mjs` / `install-skills.mjs` / `test/sidecar.test.mjs` / `README.md` / `docs/dom-probe.md` | 见 §4 |
| roots 默认值 | `G:/qoder-intl-project/else`（可 `--root` 覆盖，可多个） | API 扫描的工作区根 |
| Node | ≥20，**零第三方依赖**（只用 node: 内置） | CDP 用原生 WebSocket（Node 22+ 内置；Node 20 需手写 RFC6455 帧——直接要求 Node≥22 并在启动时校验） |

## 3. 数据契约（host API）

与 DSH 版完全一致（响应体形状不得改变，client-inject.js 依赖它们）：

- `GET /runs` → `{ok:true, runs:[RunSummary]}`，按 `updatedAt` 降序，最多 60 条；`?cwd=` 过滤
- `GET /script?run=<id>` → `{ok:true, scriptPath, script}`（读该 run `state.json` 的 `scriptPath`）
- `GET /result?run=<id>` → `{ok:true, out}`（读 `out.json`；未完成 404 `{ok:false,error}`)
- `POST /stop?run=<id>` → 写 `<runDir>/CANCEL` 文件
- **全部响应加 CORS 头**：`Access-Control-Allow-Origin: *`（renderer 是 http://localhost 或 file:// 源，跨源 fetch 必需）；`/stop` 还需响应 `OPTIONS` 预检
- RunSummary 字段（progress.json 原样透传）：`runId,name,cwd,cwdBase,backend,status,currentPhase,phases[{name,dispatched,settled,failed,rejected}],calls[{callId,label,phase,state,preview?,startedAt?,settledAt?,durationMs?,usage?}],dispatched,settled,failed,rejected,tokens{input,output},elapsedMs,startedAt,finishedAt,updatedAt`

## 4. 交付物与阶段

### D1 — DOM 探测（先做，产物进 docs/dom-probe.md）
对运行中的 MiniMax Code（需先带 CDP 重启，见坑位 C1）用 CDP dump：
1. **侧栏会话行**：找会话列表的真实选择器（DSH 是 `[class*=sessionRow]` + `role=treeitem`；MiniMax Code 的 class 是另一套哈希前缀，须实测）。记录：行容器选择器、标题元素选择器、分组/工作区行选择器（对应 DSH 的 projectRow）。
2. **对话区锚点**：DSH 用 `[class*=viewArea]` 取最大者；MiniMax Code 实测对话滚动容器选择器。
3. **localStorage 可用性**：`localStorage.setItem` 探测（Electron renderer 一般可用；若 blocked 记录降级方案）。
4. 记录格式：每个发现给出【选择器 + 一个真实 outerHTML 样本（截断 500 字符）】。
产物写入 `docs/dom-probe.md`，D3 的选择器常量从该文档来。

### D2 — sidecar.mjs（host API + CDP 注入器）
职责与要求：
1. **API 服务**（端口 4231）：§3 契约，逻辑从 DSH `index.mjs` 移植（mtime 缓存、两层目录扫描、runDirs 注册表——注意 DSH 版的 `runDirs` Map 是本次 /script /result /stop 的前提，一并移植）。
2. **CDP 客户端**：
   - `http.get 127.0.0.1:9331/json` 发现 page target（选 `type==='page'` 且 url 含 `localhost` 或主窗口特征；多个 page 时选 `title` 含 MiniMax 的第一个，规则写进代码注释）
   - 原生 `WebSocket` 连 `webSocketDebuggerUrl`
   - `Page.enable` → `Page.addScriptToEvaluateOnNewDocument {source: <client-inject.js 内容>}`（导航自动重注）→ `Runtime.evaluate` 立即注入一次（幂等：注入器开头检测 `window.__mmxDwfInstalled` 标记防重复）
   - 断线重连：WebSocket close/error 后 5s 重试；每次重连重走发现+注入
   - target 轮询：每 10s 重查 /json，出现新 page（如重开窗口）也注入
3. **spawn 模式**（`--launch`）：检测 9331 不通时，`taskkill` 现有 MiniMax Code（按镜像名 `MiniMax Code.exe`，树杀）→ spawn exe 带 `--remote-debugging-port=9331`（detached, stdio ignore, env 透传）→ 等 CDP 就绪
4. CLI：`node sidecar.mjs [--launch] [--root <dir>]...`；启动横幅打印端口与注入状态；SIGINT 干净退出（不杀 MiniMax Code，除非自己 --launch 起的且 `--kill-on-exit`）
5. **日志**：console 即可，带时间戳；关键事件（注入成功/失败原因/重连）必须打

### D3 — client-inject.js（UI 移植）
以 DSH `client.js` v3 为底，改动**仅限**以下四点，其余（CSS、卡片结构、生命周期、× 持久化、模态框、看板）逐字保留：
1. **注入形态**：从 `window.__ModuleLoader__.load({...})` 包装改为**自执行 IIFE** `(function(){ ... })()`（MMX 没有 ModuleLoader）。开头 `if (window.__mmxDwfInstalled) return; window.__mmxDwfInstalled = true;` 防重复注入。
2. **API 基址**：`var API = 'http://127.0.0.1:4231'`（所有 fetch 拼接保持相对路径写法 `API + '/runs'`）。
3. **DOM 选择器**：`sessionRowLike`、`viewAreaLike`、分组行选择器改为 D1 实测常量；保留 DSH 的兄弟+祖先双路 groupBaseOf 回退逻辑，只换正则里的类名关键字。
4. **样式 id / 元素 id 前缀**：从 `dwf-` 改 `mmxdwf-`（style id、卡片 id、modal id、localStorage key），避免与任何现有 DOM 冲突。
D3 完成后 `node --check` 必须通过，且用 §6 的静态自检脚本验选择器与标记。

### D4 — 集成件
1. `launch-mmcode.mjs`：一键 = kill 现有实例 → spawn exe（带 CDP 9331）→ 起 sidecar（child 或同进程均可，推荐同进程 import sidecar 的函数）→ 打印两个端口与"已注入"确认。
2. `install-skills.mjs`：把 `plugins/dynamic-workflow/skills/dynamic-workflow` 复制到 `C:/Users/datoo/.minimax/skills/dynamic-workflow`（若已存在先备份为 .bak-<ts>）；校验 `runtime/wf.mjs` 的 ENGINE_VERSION===0.7.1。
3. `README.md`：安装、启动（一键/分步）、停止、已知限制（外挂性质：需带 CDP 重启、MiniMax Code 升级后 D1 选择器可能要重测、CDP 端口暴露本机的安全提示——仅监听 127.0.0.1）、故障排查（4231 被占报错、9331 不通重试日志）。
4. `test/sidecar.test.mjs`（node --test）：API 合同（/runs 形状、404 分支、CORS 头存在、/stop 写出 CANCEL 文件）、client-inject.js `node --check`、注入幂等标记存在、端口占用时的报错退出码。

### D5 — 子代理独立审查（另一子代理）
按 §6 验收清单逐项核对代码与文档一致性；跑测试；输出 findings 列表（P0-P3）。

### D6 — 主会话真实终审（本文档作者执行）
起 MiniMax Code + sidecar → 跑真实工作流 → 四态截图（运行中/完成/看板/侧栏行）→ 桌面交付。

## 5. 引擎契约速查（不改动，仅供理解数据）

- 运行目录：`<cwd>/.qoder/workflow-runs/<runId>/{progress.json, state.json, out.json, journal.jsonl, pending.json, inbox/, CANCEL?}`
- `progress.json`：每次 journal 追加即重写（引擎 0.7.1：calls 带 startedAt/settledAt/durationMs/usage；run 级 tokens/elapsedMs）
- 停止 = 写 `CANCEL` 文件（引擎轮询感知）
- file 后端握手：宿主读 `pending.json` → 逐项写 `inbox/<callId>.json`（`{ok:true,text,usage?{input,output}}`）
- 会话标题匹配：MiniMax Code 会话列表行的标题文本若含 run 的 `name` 或 `runId` 则侧栏行命中；否则回退工作区分组名匹配（`cwdBase`）

## 6. 验收标准（终审清单）

1. `test/sidecar.test.mjs` 全绿；`node --check` 三个 .mjs/.js 全过
2. sidecar 4231：`/runs` 返回真实 run（形状 §3）；CORS 头存在；`/stop` 真能写 CANCEL（用 echo 后端假 run 验证亦可）
3. MiniMax Code 原生 UI（CDP DOM 断言 + Page.captureScreenshot 截图）：
   - a. 侧栏某会话标题下出现 `data-mmxdwf-line` 进度行（运行中=橙脉冲点；完成=全绿点；含 run 名）
   - b. 对话区出现卡片容器：药丸按钮（>_ 脚本 / 发现看板）、时间线（相位+计数）、代理卡（彩色头像+状态+tokens·耗时）、头部统计（总耗时+总tokens）、⏹/×/⤢
   - c. 点"发现看板"弹模态框：P0-P3 分组+明细（用带 findings 数组 result 的真实 run）
   - d. × 关闭终态卡后 localStorage 记录 `mmxdwf-dismissed`，Page.reload 后不重现
   - e. Page.reload（或窗口内导航）后 UI 自动重注（addScriptToEvaluateOnNewDocument 生效）
4. 真实工作流：用引擎跑一个 3 阶段（含 ≥4 agent）run，握手由宿主驱动完成，运行中/完成两态截图落桌面
5. sidecar 控制台无未捕获异常；断 CDP（关闭 MiniMax Code）后 sidecar 存活并在重开后 15s 内重注

## 7. 坑位清单（本会话实证过的，全部适用）

- **C1 MiniMax Code 已在运行**：必须先 `taskkill /IM "MiniMax Code.exe" /T /F` 树杀再带 `--remote-debugging-port=9331` 重启，否则 Electron 单例锁会让新实例静默退出（"focusing existing window and exiting"）。spawn 用绝对路径，stdio ignore，detached。
- **C2 bash/PowerShell 转义**：Git Bash 里内联 PowerShell 的 `$_` 会被吞、`\\\\` 会折半。所有探测/脚本一律写成 .mjs/.ps1 落盘再执行，禁止 `node -e` 写长 JSON 字符串（引号嵌套必炸）。
- **C3 node -e 混用**：`require` + 顶层 `await` 同文件报 ERR_AMBIGUOUS_MODULE。统一 .mjs 文件 + import。
- **C4 截图**：Electron 窗口 PrintWindow 常黑屏/半渲染；一律用 CDP `Page.captureScreenshot`。
- **C5 session cwd**（若需建会话验证）：MiniMax Code 会话 cwd 若走 RPC/API 传路径，用正斜杠绝对路径；反斜杠会被转义层吞成无效路径（DSH 实测同坑）。
- **C6 端口占用**：4231/9331 被占必须显式报错退出（EADDRINUSE 捕获后打印端口与 PID 提示），不得静默换端口（固定端口纪律）。
- **C7 CDP 多 target**：/json 会含 service_worker/iframe 等；只挑 `type==='page'`；注入前先 `Runtime.evaluate` 幂等检查。
- **C8 asar/升级**：MiniMax Code 升级后渲染层 class 哈希可能变 → D1 文档必须存"如何重测"的探测脚本（放进 `docs/probe.mjs` 复用）。

## 8. 非目标（明确不做）

- 不改 MiniMax Code 的 app.asar/任何源文件
- 不改 dynamic-workflow 引擎（0.7.1 冻结）
- 不做 MCP 数据面（后续可加，不阻塞本次）
- 不承诺 MiniMax Code 大版本升级后的自动兼容（README 写明重测流程）

## 9. 开发顺序与产出位置（给执行代理）

按 D1→D2→D3→D4 串行（D3 依赖 D1 产物）；全部产出落在 `G:\qoder-intl-project\else\mmx-workflow-pipeline\`。每个阶段完成即在本文档末尾"进度日志"追加一行（阶段、日期、关键产物、遗留）。遇到契约与实际冲突：以实测为准并**立即更新本文档对应小节**（文档是活文档）。

## 进度日志

- D1（2026-09-28）：DOM 探测完成。产物 `docs/dom-probe.md`、`docs/probe.mjs`（可复用）、`docs/launch-cdp.mjs`、`docs/probe-raw.json`、`docs/evidence-d1.png`。实测：MiniMax Code 3.0.74 / Electron 42.8.0，渲染层是 **Tailwind + data-testid** 结构（无 DSH 式哈希类名）。关键选择器：会话行 `[data-session-id]`（标题 `span.w-0.flex-1.text-sm.truncate`）、分组行 `[data-testid="sidebar-session-group"]`（工作区路径在 `data-workspace-dir`）、对话滚动容器 `[data-testid="message-list"]`、localStorage 可用。遗留：无。
- D2（2026-09-28）：`sidecar.mjs` 完成。host API(:4231) 从 DSH `index.mjs` 移植（/runs /script /result /stop + CORS + OPTIONS 预检 + runDirs 注册表 + mtime 缓存 + 两层扫描）；CDP 注入器（原生 WebSocket；addScriptToEvaluateOnNewDocument + 立即 Runtime.evaluate；幂等标记 `window.__mmxDwfInstalled`；断线 5s 重连；10s target 轮询；只挑 `type==='page'` 且优先 title 含 MiniMax/url archon）；`--launch` 模式（树杀+spawn 带 CDP）；`--root` 参数；EADDRINUSE 打印端口与排查提示并退出码 1。实测：注入成功、断连（关闭 MiniMax Code）sidecar 存活、重开 15s 内自动重注新 target。遗留：无。
- D3（2026-09-28）：`client-inject.js` 完成。自执行 IIFE + 幂等标记；API 基址 `http://127.0.0.1:4231`；DOM 选择器换 D1 实测值（`[data-session-id]` / `[data-testid="message-list"]` / `[data-testid="sidebar-session-group"]`，保留兄弟+祖先双路 groupBaseOf 回退）；全部 `dwf-`→`mmxdwf-`（localStorage key `mmxdwf-dismissed`）。CSS/卡片/生命周期/×持久化/模态框/看板逻辑逐字保留。`node --check` 过。**关键修复**：addScriptToEvaluateOnNewDocument 在 document-start 执行，原 `ensureStyle()` 会在 `document.head` 为空时抛错而中断启动 → 增加 `whenDomReady` DOM 就绪门控，`Page.reload` 后自动重注实测通过。遗留：CSS 为深色主题原样保留，浅色主题下对比度偏低（已在 README 记录）。
- D4（2026-09-28）：集成件完成。`launch-mmcode.mjs`（树杀→spawn 带 CDP→起 sidecar→打印双端口与注入确认，实测 OK）、`install-skills.mjs`（复制引擎技能到 `~/.minimax/skills/dynamic-workflow`，已存在先备份 .bak-<ts>，校验 ENGINE_VERSION===0.7.1，实测 OK）、`README.md`（安装/启动/停止/已知限制/故障排查）、`test/sidecar.test.mjs`（13 项全绿）。遗留：无。
- 独立审查修复（2026-09-28，P1×4 + P2×2 + P3×4 全部修完）：P1-1 `sidecar.mjs` 增 `lookupRunDir` 惰性重扫，/script /result /stop 不再依赖 /runs 先被调用；P1-2 测试全改为独立闭环（各自临时 roots + 独立 ephemeral server），新增两条顺序无关用例（`/script` / `/result`+`/stop` 在未调 `/runs` 时仍 200）；P1-3 EADDRINUSE 真占端口测试改用 `t.skip()` 明确计数，新增确定性用例（`--api-port <已占端口>` 断言 stderr 含 FATAL 与 exitCode 1）；P1-4 README 标注 `--api-port` 为测试专用覆盖（契约端口仍 4231）；P2-5 `pickPageTarget` 删除 `|| pages[0]` 兜底，辅助页 electron.html 不再被注入，测试同步；P2-6 注入器 `detach()` 清 pollTimer + `attempt()` 加 in-flight 守卫 + attach 前先关旧 socket，消除 10s 轮询与 5s 重试并发 attach 的双 socket 竞态；P3-7 删除死代码 `injectInto`；P3-8 OPTIONS 204 改为无 body（writeHead+end）；P3-9 删 `install-skills.mjs` 未用 import `lstatSync`；P3-10 `VIEW_AREA_SEL` 实现首页回退链 `[data-testid="message-list"], [data-testid="mavis-home-content"]`。回归：`node --check` 四文件全过；`node --test` 16 项全绿（0 skipped，含新增用例）；真机重连存活复测通过（关闭 MiniMax Code→sidecar 存活→重开 15s 内重注新 target，卡片存活）。遗留：无。

## D6 真实终审记录（2026-09-28，主会话）

- 测试：16/16 全绿（0 skipped，审查修复后复测）
- 真实工作流：mmx941/942/943（3 阶段 7 agent，file 后端）——API /runs 11 条、完成卡含"44.2秒 · 22.5K tokens"、新 run 完成后自动顶旧卡
- UI 四态：运行中卡片（⚙+橙脉冲+药丸+侧栏行，evidence-d6-live.png，重启 MiniMax Code 后 sidecar 自动重连重注重现）；完成态（evidence-d6-completed.png）；发现看板分组 P2·1项/P3·1项（evidence-d6-board.png）；Page.reload 重注 installed:true
- 断连恢复实测：taskkill 重启 MiniMax Code → sidecar 存活 → 重连注入 → UI 重现
- 遗留（如实）：①× 持久化由测试+审查覆盖，终审未现场点击（CDP evaluate 对 archon 偶发超时）；②浅色主题下卡片对比度偏低（README 限制 5 已记）；③archon target 的 Runtime.evaluate 间歇无响应（captureScreenshot 稳定）——已记录，不影响注入与 UI（sidecar 注入路径不经 evaluate 轮询，仅初始化用）
- 终审结论：**通过**。桌面交付三图。
