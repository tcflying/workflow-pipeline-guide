# mmx-workflow-pipeline 开发文档

> 更新：2026-09-29，生命周期修复版 **0.2.3**；MiniMax 注入版本 **3**；配合引擎 **0.8.0**。本文记录当前实现，不把目标“1:1”当作已验收事实。
>
> API/UI 的共同合同见 [workflow-ui-v2-SPEC.md](../workflow-ui-v2-SPEC.md)，实际通过项见[验收报告](../workflow-ui-evidence-20260929/ACCEPTANCE-023.md)。原 D1–D6 文档已原样保留为 [2026-09-28 历史记录](docs/DEVELOPMENT-20260928-HISTORICAL.md)；其中“无插件机制”“100%复刻”“新卡顶掉旧卡”等旧结论不再是当前合同，树杀/CDP 手工验收命令也不是当前默认操作指南。

## 0. 背景与选型边界

用户要求只做插件/外挂，不改 DSH 或 `G:\MiniMax\` 源码，零第三方依赖，端口固定。DSH 使用原生 Cordis Host + client-module；本项目使用独立 Node sidecar + renderer CDP 注入。

早期对包内 `ModuleLoader`、VS Code extension host 等的搜索，只能说明没有发现那些具体接口，不能推出 MiniMax 没有任何插件机制。当前真实界面已有“插件”入口和“动态工作流”市场条目。本工程没有验证该市场是否支持同等 renderer 扩展，也没有迁移、卸载或重装该条目。

因此，**sidecar 是本工程已实现并验收的方案，不是“唯一合法方案”的结论**。本轮只修自有插件及测试，没有改引擎、宿主、app.asar、第三方配置或 provider。

实测环境：MiniMax Code 3.0.74 / Electron 42.8.0，renderer `app://./archon`，本机 Node 24.18.0。此处是本机观察，不是最新版声明。

## 1. 架构与文件

```text
MiniMax renderer (app://./archon)
  client-inject.js
    ├─ 卡片、侧栏、四种详情、中文回答/恢复状态
    ├─ 2s 轮询 GET /runs
    └─ fetch 127.0.0.1:4231
                │
sidecar.mjs     ├─ Host API：/runs /script /result /stop /resume /answer
                ├─ CDP 9331：发现 target、注入、5s 重连、10s target 检查
                └─ run-lifecycle.mjs：进程身份与恢复确认
                            │
<root>/.qoder/workflow-runs/<runId>/
  progress.json / state.json / journal.jsonl / out.json / pending* / inbox / CANCEL
```

- `sidecar.mjs`：独立 HTTP server，mtime 缓存，两层根扫描，按 runId 惰性定位；读取侧可覆盖失效进程状态，但不写回历史进度。
- `client-inject.js`：自执行 bundle；`__mmxDwfInstalled` 与 `__mmxDwfVersion` 共同门控。
- `run-lifecycle.mjs`：与 DSH 项目保持同内容独立副本，不能依赖跨项目 import 才能安装运行。
- `test/client-lifecycle.test.mjs`：在 fake DOM 中执行两端真实 bundle，包含可控时钟、异步 POST 和跨 document storage。
- `test/host-lifecycle.test.mjs`：两端真实 HTTP handler、真实独立进程创建时间、真实本机引擎恢复。
- `test/sidecar.test.mjs`：API、CORS、注入、参数及端口冲突。
- `launch-mmcode.mjs` / `docs/launch-cdp.mjs`：旧启动器，部分路径会树杀宿主；不默认使用。只读复核还发现前者帮助中的`--no-launch`未被共用parseArgs解析、`--kill-on-exit`未接入退出处理；不能把这些选项当已实现的安全保证。安全复用走不加`--launch`的sidecar。
- `install-skills.mjs`：仍锁定引擎 0.7.1 的旧安装器；当前 0.8.0 不适用。本次没有运行或修订该工具。

## 2. 硬契约

| 项 | 当前值 |
|---|---|
| 生产 HTTP API | `127.0.0.1:4231` |
| MiniMax CDP | `127.0.0.1:9331` |
| Node | `>= 22`，原生 WebSocket、零第三方依赖 |
| 默认扫描根 | `G:/qoder-intl-project/else`；可重复 `--root` |
| 引擎路径 | `G:/qoder-intl-project/else/plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs` |
| MiniMax exe | `G:\MiniMax\MiniMax Code\MiniMax Code.exe` |
| DSH 当前对照版本 | `@dsh-external/dsh-workflow-pipeline@0.2.3` |

4231 绑定冲突必须 `EADDRINUSE`、退出码 1，不漂移。9331 是客户端消费的现有调试端点；先核对归属，不能把“能连上任意 CDP”视作目标已验证。`--api-port` 只用于自动化测试临时 listener，不能用于绕过生产冲突。

## 3. Host 数据与生命周期

### 3.1 查询

- `GET /runs[?cwd=...]` 返回 `{ok:true,runs:[...]}`，按 updatedAt 降序；取消旧的 60 条截断。
- 扫描 `<root>` 及下一层项目；`?cwd=` 接受规范路径或 basename 匹配，仍可能把同名目录合并。
- `/script`、`/result`、`/stop`、`/resume`、`/answer` 在第一次 `/runs` 之前也能定位运行。
- `progress.json` 随 journal 事件更新，不是实时计时器；Host 只在响应中把失效 running 进程标为 stale，并转换尚未完成的 call/question，历史文件不变。
- MiniMax API 带 `Access-Control-Allow-Origin: *`，OPTIONS 为无 body 的 204；没有应用层认证。必须视为受信本机调试服务，未完成跨源安全加固。

### 3.2 回答

JSON body 必须含非空字符串 `answer`。运行需有效 running、qId 合法且 question waiting。未知 run/question 404，非法 body/id 400，终态、非 waiting 或重复写入 409。`inbox/<qId>.json` 以 `wx` 创建，不能覆盖第一次提交。

`kind:"question"` pending 不能交给 agent 自动应答器。UI 200 代表答案文件已接受，不等于工作流完成；必须继续观察 answered/结果。

### 3.3 进程身份

- 裸 PID 存活只是一项信号；Windows 用 `Win32_Process.CreationDate`，非 Windows 实现用 `ps -eo pid=,lstart=`。
- 创建时间晚于 state.startedAt 超过 1 秒，视为 PID 复用。快照缓存 5 秒、在途去重，resume 强制刷新。
- 创建时间查不到，或老 state 没有有效 startedAt，则保守回退裸 PID 判断，不凭空判 stale。
- 非 Windows 分支未本轮实测。

### 3.4 恢复

`run-lifecycle.mjs` 保留 backend/concurrency/maxAgentCalls，以参数数组 spawn 引擎 `resume`。输出追加 `pipeline-resume.log`，不替换 journal。

最多等待 8 秒看到 state 的 PID 与新 child 一致，且 PID 或 startedAt 与旧生命周期不同，才返回 `200 {ok:true,spawned:true,accepted:true,status}`。引擎提前退出返回 `409 ENGINE_REJECTED`；8 秒未确认返回 `504 RESUME_UNCONFIRMED`，不杀可能仍启动中的进程。成功接受后 UI 仍以实际 progress 终态为准。

引擎 0.8.0 OWNER 仍用裸 PID；旧 PID 被活进程复用时插件返回 `409 PID_REUSED_ENGINE_GUARD`，不 spawn、不 kill、不改 state。它是安全拒绝，不是“引擎恢复限制已修复”。

## 4. UI 与持久化

### 4.1 显示

顺序：head → 四个入口 → questions → timeline → artifacts → agents → logs → result。

- 统计：阶段数；运行中 calls 的 running 数；终态 settled 数；总 tokens/耗时。
- 运行中耗时为 `max(elapsedMs, Date.now()-startedAt)`，终态使用引擎值冻结；秒总数舍入后拆分钟，避免 `1分60秒`。
- agent 卡最多最近 24 个；日志显示最近 4 条；历史读取 API 全量，但弹窗是打开时快照。
- 结果以 out.result/error 展示，超过 65,536 个 JS 字符截断；提示写“64KB”，实际不是按 UTF-8 字节计量。
- artifacts 的 URL 可链接；本地 path 仅 tooltip。无 agent 的 completed phase 仍可能灰/黑，现有语义未在此版修正。
- 浅/深色通过宿主背景选择；真实本轮验收为浅色，不再要求“深色 CSS 逐字保留”。

### 4.2 状态保持

- `controls` 以 runId/startedAt 隔离，answers 再以 qId 区分 pending/submitted/error；header 替换不复活已禁用按钮。
- `syncSections` 保留未改变的 question DOM，使其它 run 更新和计时刷新不丢输入、焦点或 selection。
- 提交失败保留草稿并显示错误；resume 请求中/冷却期间禁重复操作。
- `mmxdwf-visible-runs` 和 `mmxdwf-dismissed` 保存已显示卡和手动关闭卡，不按时间、200 条阈值淘汰。
- 初始选择所有 live run + 最新未关闭终态；以前已经显示的终态额外保留。运行数据离开扫描根时仍会消失；这不是本地历史数据备份。
- 普通草稿、焦点、请求 pending 不跨 document 持久化，不能把卡片常驻误写成重载后草稿也恢复。
- sidebar 按 startedAt 选择最新匹配项，无 TTL；标题子串/cwd basename 仍是近似关联，非 session ID 绑定。

### 4.3 MiniMax 注入升级

`CLIENT_VERSION=3`。已安装且 version >=3 时直接返回；旧版本先 teardown，再移除自有 modal/style，设置新版本并启动。回归覆盖“旧2升级到3、teardown一次、同版再执行不重复初始化”。

已有 target 的10秒检查不会重读 bundle。更改文件后需重新 attach，例如只重启核对过身份的自有 sidecar。`Page.addScript...` 注册 identifier 尚未回收，旧注册可能积累；高版本门控避免旧 bundle 覆盖新版，但不等于注册资源已清理。

## 5. 验收方法与安全纪律

主会话独占官方 Computer Use，优先无障碍控件；只有不存在语义控件才用键盘或当前截图坐标。不以 raw CDP 替代 UI 操作。产品自身 CDP 注入与验收者的 UI 自动化路径是两回事。

本轮完整插件测试：41 客户端生命周期 + 22 Host 生命周期 + 19 sidecar + 4 DSH API = **86/86，0 skip**。详见[测试原始日志](../workflow-ui-evidence-20260929/plugin-023-tests.log)。fake DOM 不代替真实宿主；Host 恢复测试真的启动本机引擎。

实机6条run：普通并行/问答2条、停止恢复2条、计时草稿2条。全部 `completed/file`。两个 agent 的回执是明确标识的本机fixture，320 tokens仅用于验证显示；不是外部模型审查或计费。

证据包含原生按钮操作后的 PNG/AX、真实 out/journal、部署五文件 SHA256、双端 API健康。DSH 0.2.3只改UI/manifest，Host/helper与0.2.2同内容；前次原生Harness重启已加载Host，本次原生页面重载加载UI。

重要操作守则：

- 只停核对完整命令行和端口归属后的自有 sidecar，不硬编码历史 PID。
- 不改失败历史、不写假 progress/state、不杀 PID 复用后的无关进程。
- 不运行旧部署脚本反复覆盖；它们含旧哈希、`wx` 日志或旧 PID。
- 后台 DSH 截图/AX 曾延迟；前台观察后确认，不重复未知结果的 stop/answer。
- 子代理验证码超时不是审查通过；主会话接管，不修改模型/provider/凭据绕过。

## 6. 当前限制

除上面已经说明的近似session、路径tooltip、phase颜色、截断、旧安装器和CDP注册外：

- localStorage失败静默；stop没有即时pending/错误反馈；Host未禁止终态写CANCEL。
- DSH普通teardown仍可能留下modal/style；MMX新版升级入口清理两者，但一般teardown未全面重构。
- 同runId跨root冲突、既有卡片DOM排序未修。
- URL新窗、非Windows进程识别、0.2.3整宿主退出重开、深色实机主题未重测。
- DSH历史181秒启动超时根因未定位；不能以此次健康状态宣称已修。
- 未取得原始参考图做像素级比对，不得宣称“1:1完美”或“全部遗漏清零”。

## 7. 进度记录

- **2026-09-28 D1–D6（历史）**：sidecar原型、DOM探测、16项测试及四态图，完整旧记录在历史文档。旧终审“通过”仅指当时范围，不覆盖后续生命周期问题。
- **2026-09-29 0.2.2**：回答/恢复状态机、跨重载visible/dismissed、按run日志状态、主题和结果更新、PID复用检测、恢复握手与backend保持。79项完整插件测试通过；旧Host驻留导致过一次恢复丢backend，失败记录保留。
- **2026-09-29 0.2.3**：实机发现完成卡代理数0、运行计时不动和1分60秒；6条红测后修复。MMX版本升级增加1条行为红测后修复。Windows恢复fixture等待子进程自然退出后再清理，解决测试cwd EPERM。最终86/86、0 fail、0 skip。
- **2026-09-29 最终实机补证**：双端×后reload不复活、其它多卡常驻、历史仍有被关闭run；DSH计时2分02秒→2分32秒、MMX41.7秒→2分56秒，草稿保持并原生提交完成。六run及部署五文件只读核验通过。新版文档撤回旧插件能力推断和树杀默认建议。

最终交付：[报告](../workflow-ui-evidence-20260929/ACCEPTANCE-023.md)、[索引](../workflow-ui-evidence-20260929/INDEX.md)、[核验JSON](../workflow-ui-evidence-20260929/evidence-audit-023.json)。
