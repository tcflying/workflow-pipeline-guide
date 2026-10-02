# ACCEPTANCE-024 — 0.2.4 双端真实客户端验收记录（2026-09-30）

本记录只声明有真实证据的项。验收人：主会话（官方 Computer Use 独占操作）。
版本：引擎 0.8.1 / DSH 插件 0.2.4 / MMX sidecar 0.2.4（CLIENT_VERSION=4）/ hook 候选件 0.1.0（未安装）。

## 部署与修复链（当日实际发生）

1. 0.2.4 四文件（client.js/index.mjs/package.json/run-lifecycle.mjs）SHA256 核对后部署到 DSH dev 实例（deployment-024-backup/ + deployment-024-backup.json）。
2. **发现一：DSH profile 漂移**。`profiles/web/package.json` 在 09-29 被第三方重写时丢失 `@dsh-external/dsh-workflow-pipeline` 依赖与 bundles 声明（对比 .mavis-backup-20260928-160742 证实）——插件自 09-29 晚起在 DSH 完全未装载（与 0.2.4 无关的存量故障）。已外科式恢复条目（备份 package.json.bak-024-restore-*），不动其它插件条目。
3. **发现二：Cordis inject 合同**。真实宿主报 `cannot get property "sessions" without inject`——v4 客户端从未在真实 Cordis 环境运行过（0.2.3 无 ctx.sessions）。修复：`exports.inject = ['sessions']` + 访问防御（对照 dsh-better-sidebar 的官方模式），补测试（109/109）。
4. harness 全量重启两次（taskkill //T //F 仅对已核实 PID 树；第二次后 profile 修复生效），DSH 起动慢（~60-167 秒，与已知 181 秒问题同谱系）。
5. MMX sidecar 0.2.4 启动（复用既有 MiniMax 实例，不加 --launch）；**宿主已升级 MiniMax Code 3.1.0**（此前核查基于 3.0.74 asar）。

## DSH 端真实验收（通过）

- 插件 API `http://127.0.0.1:43130/dsh-workflow-pipeline/api/runs` → 200，28 runs，`hostSession:null` 正确透传。
- 真实引擎运行 `acceptance-024-dsh`（file 后端，2 agent + 1 ask + 1 汇总）。
- 卡片在真实会话视图渲染：运行中卡（问题输入框可见）→ 完成卡"2 个阶段 · 3 个子代理已结束 · 21分39秒"（与 API 数据逐项一致）。
- **中文回答"继续"经真实 DSH UI 输入并点击提交** → 引擎 questions[0].state=answered、answerPreview=继续。
- 全局历史弹窗（acceptance 行绑定到真实会话 session-af9b1792…，解绑按钮在位）；看板弹窗开启截图。
- 截图：dsh-024-session-card.png、dsh-024-completed-card.png、dsh-024-bound-completed-card.png、dsh-024-board-modal.png、dsh-024-session-card-bound.png 等。

## MMX 端真实验收（通过）

- sidecar API 认证生效（无 capability 403）；页面真实重载（Ctrl+R）后注入器重连、marker 确认（sidecar-024-run.log 22:13 attach）。
- 3.1.0 实机 DOM 只读探测：`message-list` 锚点有效、`data-session-id` 侧栏行有效（484 行）、`mmxdwf card` 存在且内容完整（头/统计/⏹/❓问题/输入/回答/阶段/agent 胶囊/看板 pill）；**`data-shortcut-session-active` 标记缺失**（3.1.0 变化，见缺口）。
- **中文"继续"经真实 MiniMax UI 键入（合成键盘）并点击回答按钮提交** → 引擎 qState=answered、inbox/q000-*.json 落盘、answerPreview=继续。
- 输入草稿在滚动离开视口、2s 轮询重渲染后完整保留（v="继续" 复核）。
- 运行 completed（settled=3）。
- 截图：mmx-024-card-live.png、mmx-024-card-typed.png、mmx-024-card-submitted.png、mmx-024-completed-card.png。

## 验收方法备注

- 全部 UI 操作走官方 Computer Use（AX 优先，坐标点击仅在 AX 不暴露 web 输入时使用，坐标由只读 DOM getBoundingClientRect×DPR1.25 换算并行为验证）。CDP 仅用于只读 DOM 诊断（选择器/几何/marker），未用于 UI 控制或验收断言。
- 引擎 parked agent 调用由宿主会话按 file 后端合同写 inbox 应答；问题（ask）全部经真实客户端 UI 提交。

## 本轮未验/已知缺口（如实）

1. DSH 结果弹窗截图未取得（AX 树 2s 重渲染与索引竞态；与看板/历史同构，单测覆盖）；历史/看板弹窗已有截图。
2. MMX 3.1.0 当前会话标记（data-shortcut-session-active）缺失 → MMX 会话隔离视图暂退化为全局视图；需重新测量 3.1.0 选择器。原生 hook 候选件未安装（discovery→握手→真实调用证据未取得）。
3. DSH 侧栏逐行进度行仍无公开扩展点（16 个 UI 包复核结论未变）。
4. ×关闭/reload 常驻、停止/恢复真实点击、深浅主题、窄窗、后台节流本轮未重测（023 有历史证据，0.2.4 行为由单测覆盖）。
5. 与原始红箭头参考图的像素级对照未做（卡片结构元素齐全：头/状态/阶段列/agent 胶囊/脚本列/看板入口，视觉比对待用户过目截图）。

## 回归基线

- 全量 274/274（full-024-r3-integration.log）；inject 修复后客户端套件 109/109（client-inject-contract-fix.log）。

---

## R4 追加验收（2026-09-30，主会话）

### 已验（实机）

- **DSH（窗口可见，CDP 9223 只读取证）**：0.2.5 客户端经 appserver 加载（dwf-pipeline-style + dwf-run-card + 250 次 43130 资源请求）；两个并发 ask 停靠 run（acceptance-r4-live-a/b，纯脚本零代理）→ 两张 live 卡同显（⚙ + ❓ 输入框 + 计时跳动）；`wf.mjs stop` CLI → 卡片实时翻转为 工作流已取消（×/↻ 出现，失败提问文案显示）；删除 run 目录 → 5 秒内卡片经修剪消失（12→10）。卡片高度 269-449px（无拉伸）。证据：dsh-cards-probe.mjs 输出（本目录）。
- **MMX（窗口隐藏态取证）**：v5 三次注入确认（11:15/11:39/11:55 各 sidecar 重启，`__mmxDwfVersion===5`）；从渲染器以真实 capability 取 /runs = 200/35 runs/2 live（mmx-auth-fetch-probe）；认证 403 无 CORS 头为文档化安全设计（deny() 注释），未改动。
- **回归**：client 123/123；全量 257/257（先红 11 项新契约测试）。

### 未验（阻塞原因如实）

- MMX home 页无卡 / 会话页卡片**视觉**确认：窗口最小化（visibilityState=hidden，定时器冻结实测 1500ms→8s 不触发），CU 工具面在本上下文缺失。用户打开 MiniMax 窗口后 visibilitychange 补拉会在 ~2s 内渲染会话页卡片；home 页不再有任何卡片宿主。
- 隐藏窗口节流本身已修（双端 visibilitychange 补拉），见 REVIEW-024-R4-MAINSESSION.md。

### 部署终态

- MMX：sidecar 生产实例（随机 capability，4231/9331，roots=else）；client-inject.js v5（含 home 抑制/归因池/修剪/负缓存/可见性补拉/可见错误上报）。
- DSH：app 自愈 appserver（pid 72944，原命令行）+ 我方冗余启动按设计 EADDRINUSE 退出未漂移；profile web 五件套中 client.js/package.json 更新（0.2.5）；app 以 --remote-debugging-port=9223 重启。
- 验收 run 目录已清理（6 个 acceptance-r4*）；探针脚本留存本目录（mmx-*、dsh-*、diag-*、repro-r5-realdata.mjs）。

---

## R4 继续轮追加（2026-09-30 午后，主会话）

### 新增已验（实机）

- **MMX 会话页卡片 DOM 级渲染**：批次 tick 下 10 张已观看卡实际进入 DOM（单卡 340-428px 无拉伸；宿主 3957px = 10 卡自然堆叠——同时坐实投诉画面"纵向拉长"的真实机制是历史卡堆叠，非单卡变形）。截图归档 mmx-r4-session-cards.png（288KB，Page.captureScreenshot 对隐藏窗口亦可用）。
- **MMX 修剪**：归档 11 个我方测试 run 目录（10+1，含 acceptance-024-mmx/dsh、ui022/023、ui0929、v2终审、插件完美度终审）后，MMX 卡片 10→0、visibleSet 清空；DSH 同步 12→1→0 并出现正确的空态提示。证据目录 archived-runs/（保留 journal/out.json 证据链）。DSH 干净态截图 dsh-r4-clean-state.png。
- **插件机制调研（只读取证）**：MiniMax 3.1.0 asar 内含完整 hooks 生命周期引擎（lifecycle.runEvent PreToolUse 实测存在）；本地包扫描代码存在（scanLocalPluginPackages(dataDir/plugins)，.minimax-plugin 布局受支持，**拒绝符号链接**）；已装市场插件目录为 ~/.minimax/plugins（49 个，全部 source=OFFICIAL）；桌面门面 `LOCAL_PLUGIN_INSTALL_UNSUPPORTED` 明确拒绝本地安装动作；LOCAL 目录（source=2）当前为空；hook 物化由 app 的 NodeService（utility 进程）执行，13:03 重启后仅物化了市场包（lark）的 hooks。
- **relay 插件包**：契约字段核齐（schemaVersion/name/version/description/hooks），icon 字段指向不存在文件已从源头删除；已真实拷贝至 ~/.minimax/plugins/mmx-native-session-hook/（.minimax-plugin/、hooks/、scripts/relay.mjs）；测试 3/3 绿；.mavis 为指向 .minimax 的 junction（单根）。

### 未验（如实）

- 插件**激活**：本地扫描通道在本 build 未接纳拷贝目录（LOCAL 目录空、hook-cache 无我们的包）；桌面 UI 的本地安装动作被门面拒绝。打通需：主上在 MiniMax 设置/插件界面操作本地插件入口，或经市场发布（外部发布需主上决策）。真实调用证据（agent 跑 wf.mjs 时 relay 注入 --host-session）随之待激活后取证。
- MiniMax 已按带 CDP 参数重启（13:03），sidecar 已自动重注入 v5；卡片视觉确认仍待窗口可见（隐藏窗口节流已由 visibilitychange 补拉修复）。

---

## R4 官方桌面版部署追加（2026-10-01，主会话）

### 目标

用户要求两版都支持：DSH 官方桌面版（官方发布的 2.0.13）+ 社区企业版（dev 实例，此前已部署）。

### 侦察结论（实测定案）

- 官方版：`C:\Program Files\DSH Desktop\DSH Desktop.exe`（dsh-plugin-desktop **2.0.13**，开始菜单快捷方式指向）；userData `$APPDATA/DSH Desktop`；webServer 端口 **43120**（企业版 43130）；harness profile `~/.dsh/profiles/desktop`（profile-selection state.json active=desktop；`~/.mavis`→`~/.minimax` 均为 junction，与 DSH 无关）。
- 机制同源：官方壳内含同一套 `__ModuleLoader__`/client-modules 系统；bundle 加载同为 `package.json → dsh.profile.bundles` 数组（官方 profile 现有 21 个社区/官方 bundle，含多个 file:/link: 本地依赖——本地依赖不被歧视）。
- **关键差异**：官方版收集器严格——渲染层聚合（`/plugins/??…` 组合 URL）只收带 `dsh.client` 声明**且** `exports["./client"]` 映射的包；企业版收集器宽松（仅 bundles 数组即可）。无 `exports["./client"]` 的 bundle（如 dsh-find-plugin）同样被官方版跳过——规则一致地作用于所有包。

### 部署（三步，均实机验证）

1. `~/.dsh/profiles/desktop/package.json`：dependencies += `@dsh-external/dsh-workflow-pipeline: file:G:/qoder-intl-project/else/dsh-workflow-pipeline`；`dsh.profile.bundles` += 包名（备份 package.json.bak-r4off-20261001-034951）。
2. 源包升 **0.2.6**：补 `dsh.client = { inject: ["@deepseek-ai/dsh-client-runtime"], immediately: true, platform: "web" }`（沿用昨日实验在官方 node_modules 遗留的实测声明）+ `exports["./client"] = "./client.js"`。渲染层脚本代码零改动（哈希同 0.2.5 的 535768…）→ 企业版无回归由同文件论证。
3. 两端 node_modules 同步（企业版直接复制并核对哈希；官方版 pnpm install 后仍需手动覆盖——pnpm 对 file: 依赖不自动刷新内容）。

### 验收（实机，CDP 9224 只读 + 官方 CLI 驱动）

- host half：`GET /dsh-workflow-pipeline/api/runs` 200 + 真实 runs 数据。
- 渲染层：重启后样式表注入、渲染端发起 API 轮询、`ask` 停靠 run 的实时卡（⚙工作流运行中）在官方页面渲染；`wf.mjs stop` 后卡片**实时翻转为已取消态**（窗口隐藏、批次 tick 下照常工作）。截图：official-dsh-r4-cancelled.png（带取消卡）、official-dsh-r4-clean-state.png（归档后干净态）。
- 测试 run（official-accept-r4-20261001-071923-w28）已归档至 archived-runs/。

### 过程事故（如实）

- 第一次 pnpm install 在官方 app 运行中执行，node_modules 重写导致官方渲染器崩溃循环（watchdog 连续恢复失败）——重启后恢复。教训：不对运行中的官方 app 做 node_modules 写操作。
- 官方 app 一次强制结束未即时生效（进程稍后自行退出）、一次单实例锁拒绝并发启动——均为壳的正常保护，重试即可。
- `~/.dsh/profiles/desktop/node_modules` 内遗留昨日实验安装的 0.2.5（含当时试出的 dsh.client 声明）——本次合并该声明后以 0.2.6 覆盖。

### 双端部署终态总表

| 宿主 | 版本 | webServer | CDP(验收用) | profile | 包 |
|---|---|---|---|---|---|
| DSH 官方桌面 | 2.0.13 | 43120 | 9224 | ~/.dsh/profiles/desktop | 0.2.6 |
| DSH 社区企业版 | dev | 43130 | 9223 | $APPDATA/dsh-desktop-dev/harness/profiles/web | 0.2.6 |
| MiniMax Code | 3.1.0 | 4231(sidecar) | 9331 | CDP 注入 v7 | client-inject v7 |

## MMX 真实会话规模下的 v7：选择器筛选（2026-10-02）

### 触发的真实缺陷

v6 的「🔗 选择会话…」把侧栏会话行全部平铺。在测试夹具里只有 1~2 行，看不出问题；对着运行中的 3.1.0 一测：

```
unique session ids: 517
where they live: {"DIV|-|":517}          // 全部是 div[data-session-id]
sample: mvs_4fce133…: amd 华为 d h插件等免费通道
        mvs_faa161f…: 对比多个 codex 集成 ChatGPT 的项目
```

517 行不可用 → v7 在弹窗顶部加筛选框（标题 / 会话 ID，大小写不敏感），标题行显示「命中 / 总数」，无命中给明确空态，重新打开弹窗筛选自动清空。CSS 同步加滚动容器（`max-height:min(52vh,420px)`）。

### 变更与验证

- `mmx-workflow-pipeline/client-inject.js`：`CLIENT_VERSION` 6 → 7；`openSessionPicker` 重写；新增 `.mmxdwf-filter` / `.mmxdwf-srows` / `.mmxdwf-pickhead` / `.mmxdwf-picknone` 样式。
- 测试：`client-lifecycle.test.mjs` 129 项（新增 3 项：过滤命中标题/ID/纯空格、无命中空态、重新打开清空）。
- 全量：**260/260 通过**（9 个文件；client-lifecycle 129 + 其余 131）。逐文件计数已核对。
- 现场：重启 sidecar（先核对 PID 56312 确为监听 4231 的 `sidecar.mjs --root G:/qoder-intl-project/else`），版本门控自动换装，`window.__mmxDwfVersion === 7`，两条新 CSS 规则在页面内可见。
- 能力串未泄漏：全局变量与 localStorage 扫描无 64 位十六进制能力串；存储里那条 64 位十六进制是 `run.runKey`（`identity()` = `run.runKey || run.runId`），不是 capability。

### 演示运行 mmx-demo2-20261002-071823-hsf 的完整生命周期

| 阶段 | 事实 |
|---|---|
| 初次运行 | ask 超时失败（`ask(): 宿主拒绝回答: agent call q000-b7e99be2 timed out after 3600000ms`） |
| 第一次 resume | 失败：`ask() 仅 --backend file 可用：cli/echo 后端没有宿主可回答` —— 漏了 `--backend file` |
| 第二次 resume | 又超时失败（`q000-a0622bad`，08:22:57 派发 → 09:22:58 超时，整 1 小时） |
| 第三次 resume | 运行中（pid 29760），卡片 ❓ 待答、输入框占位「输入回答…」 |
| 作答 | 写 `inbox/q000-a0622bad.json` = `{"ok":true,"text":…}`（引擎文档的 file 后端作答通道） |
| 终态 | `status: completed`，`out.json.result = {"ack":"…"}` 回显真实回答；页面卡片翻成「✓工作流已完成」，ask 行带 ✔ 与回答原文，作答输入框消失 |

### 诚实边界（未验收项）

- **卡片的点击作答路径未由真实点击驱动**。用官方 Computer Use 绑定了 MiniMax Code（pid 13548），但该构建的 AX 树不含注入卡片的按钮（Chromium 内容层 a11y 看不到注入的 DOM），只能走截图+坐标；期间用户正在使用该窗口（输入框有未发送内容），为避免劫持已 `stop()` 释放并把会话切回原样。因此改为走引擎的 file 后端作答通道验证引擎侧。
- 会话选择器筛选框的真实观感（517 行滚动 + 过滤）同样未由真实点击验证，仅有 129 项测试与页面内 CSS 存在性证据。

## R5：子代理复盘（2026-10-02 下午）→ v8

主上令派子代理复盘"MMX 里都完美了吗"。两个子代理并行：

**A（代码终审，只读）**：逐特性对照 1:1 目标审计 client-inject v7。结论 INCOMPLETE，3 个 P0：
1. **绑定即删卡**：`sessionPool` 的 `!!cur` 门在无活动会话标记的真实 3.1.0 上把已绑定运行永久排除出卡片视图（子代理用无头夹具复现：绑定后 3 个 tick 卡片消失）。
2. **历史行渲染永远禁用的「绑定当前会话」**：无 `cur` 时该按钮必死，且是历史里唯一归属入口 → 已结束运行永久无法归属。
3. **无卡片时全局历史弹窗无入口**：唯一入口（卡片上的 history pill）随卡片消失，banners 里的入口提示又被 `cur` 门死。
P1 一批：选择器标题污染（`row.textContent` 会把已注入的进度线文字带进列表，如 `排查Codex无法启动⑂收尾阶段`）、绑定持久化缺 `host`/`source`（契约字段 `mmx` 是读时合成的）、陈旧注释仍声称活动会话标记存在。
测试诚实性：129 项里所有走 `cur` 路径的测试都伪造了 `data-shortcut-session-active` —— 一个真实 3.1.0 上不存在的 DOM；绑定后卡片消失这件事 0 断言。

**B（证据链审计，只读）**：逐条核对"已验"声明的落盘证据。结论：**无造假**（journal 与文档逐字吻合、时间戳全对），但 11 项缺口，要点：
- v7 卡片点击作答从未被真实点击驱动（v4 时代有过真点击存档，v5-v7 重写后没有）；演示 run 的完成态卡片截图未存档；
- 260/260 无归档日志；v7 现场探针（版本标记、能力串扫描）只存在于文档转述；
- `mmx-r4-session-cards.png` 与其引用声明矛盾（画面里没有卡片）；`mmx-home-shot.mjs` 的目标 PNG 从未生成；
- **「别的东西」定位**：`G:\mmx-project\fix mmx\mmx-status-github` — daemon.mjs 经同一 CDP 9331 给侧栏每行画状态点，`fix-coldstart.ps1` 会关闭所有非沙箱 MiniMax 实例 —— 正是 10-02 01:03 悄悄带走我方 sidecar 的元凶。冲突未评估（等主上决策）。
- MMX 3.1.0 无活动会话标记是宿主事实，选择器绑定是设计内补偿。

### v8 修复（全部落地 + 全量回归）

| # | 修复 | 实现 |
|---|---|---|
| P0-1 | 绑定后卡片保留 | `sessionPool`：无 `cur` 时手动绑定（`b.host==='mmx' && !b.native`）保留在池；有 `cur` 时仍按 cur 匹配；**原生绑定**（native-hook）依旧严格排除，跨会话不泄漏（回归测试守住） |
| P0-2 | 历史行死按钮 | 无 `cur` 时历史行渲染「🔗 选择会话…」打开同一选择器（选完写绑定、留在历史视图）；有 `cur` 的宿主行为不变 |
| P0-3 | 历史入口 | `bannersHtml` 去掉 `cur` 门：有运行且无卡时显示「暂无正在展示的运行 · 打开全局历史绑定…」 |
| P1 | 标题污染 | `sidebarSessions` 改 clone 行→剥离 `[data-mmxdwf-line]`→优先 `SESSION_TITLE_SEL`；fake DOM 补 `cloneNode` |
| P1 | 绑定持久化 | 记录补 `{host:'mmx', source:'mmx-picker'}` |
| P1 | 陈旧注释 | 文件头与 session adapter 注释改为"3.1.0 无标记、cur 恒空、各表面有兜底" |

- 测试：**133/133 客户端**（4 项新增全部在**无标记 DOM**下跑：绑定后卡片保留/历史行选择器含 host+source 持久化/无卡历史入口/标题不污染）；**264/264 全量**（9 文件），归档 `full-024-r5-v8.log`。
- 部署：sidecar 重启（先核对 PID 39352 = `sidecar.mjs --root G:/qoder-intl-project/else` 才动手），版本门控自动换装，`window.__mmxDwfVersion === 8`。
- 现场探针输出**已归档**（修复 B 项"只有转述"的缺口）：`mmx-v8-audit-output.txt`（v8 标记、518 行、能力串扫描 clean、存储里 64hex=runKey）、`mmx-v8-bind-audit-output.txt`（真实 DOM 上合成一行注入线 → 标题提取出干净标题"调研 zcode 远程手机控制并开发 minimax code"、注入线剥离、单行 0.2ms）、`mmx-ver-audit-output.txt`、`mmx-picker-audit-output.txt`。
- README 版本针 v5 → v8（B 项缺口）。

### R5 诚实边界（仍未真实点击验证）

- P0-1/P0-2/P0-3 的**真实点击路径**（在真实窗口里点「🔗 选择会话…」选一个会话、点历史入口）仍只有 133 项测试 + 真实 DOM 只读探针证据，未由真实指针驱动（上次尝试时主上正在使用窗口，已释放并恢复原状）。
- 选择器筛选框的像素观感仍无截图。
- 原生 hook 自动归属、mmx-status 冲突评估：等主上决策，状态不变。

