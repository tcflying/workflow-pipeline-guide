# dsh-workflow-pipeline

DSH 团队版的原生插件：通过 Cordis Host API 和 `window.__ModuleLoader__.load` 客户端模块，显示 ZCode 风格的工作流侧栏进度与对话区运行卡片。不修改 dsh-desktop 源码或 app.asar，零第三方依赖。

**当前版本：`@dsh-external/dsh-workflow-pipeline@0.2.4` 候选（2026-09-30，未部署）。** 配合引擎 0.8.1。0.2.4 新增：生命周期最后 await 窗口闭合（写盘前同步重读 progress+state，state 以 `sameStateIdentity` 逐字段核身份）、resume 双快照、**原生会话归因**（引擎读 DSH 原生 shell 内置 `DSH_SESSION_ID` 写入 `hostSession`；客户端将 native origin 视为精确绑定，跨宿主同名 session 不认领，手动绑定仅对 legacy 无归属运行生效）。候选全套隔离回归 **274/274，0 fail，0 skip**（[full-024-r3-integration.log](../workflow-ui-evidence-20260929/full-024-r3-integration.log)）。**未部署、未做真实客户端验收**；下文 0.2.3 的实机验证记录是历史。DSH 原生侧栏仍无逐行公开扩展点（已只读核实 16 个客户端 UI 包），"session 标题下进度行"在本版仍未达成。

## 原生装载与文件

| 文件 | 作用 |
|---|---|
| `package.json` | exports及`dsh.client`/`dsh.bundle.patch`发现声明 |
| `cordis.patch.yml` | 原生Host注册，注入webServer及扫描根 |
| `index.mjs` | `/dsh-workflow-pipeline/api`前缀API |
| `run-lifecycle.mjs` | 进程身份、保留后端的恢复握手 |
| `client.js` | 原生客户端模块、卡片、侧栏与交互 |

当前dev实例安装目录：

```text
C:/Users/datoo/AppData/Roaming/dsh-desktop-dev/harness/profiles/web/node_modules/@dsh-external/dsh-workflow-pipeline/
```

当前Cordis补丁扫描根：`G:/qoder-intl-project/else`、`G:/qoder-intl-project/dsh团队版`、`G:/zcode-project`，每根扫描自身及下一层项目。

这份目录是已验收安装实例，不是对所有DSH版本的通用安装路径承诺。应走对应客户端原生插件发现机制，不另写宿主源码、workspace hook或第三方patch。

## 安全更新

1. 检查目标确为本插件；先对照现有部署清单核验，发现外部改动就停止覆盖。
2. 备份这五个文件，再从自有源同步；源与安装副本逐件核对SHA256。
3. **Host逻辑更新需要原生“重启 Harness”**；只拷文件不能证明旧Host已退出。
4. 仅UI更新时，使用原生应用菜单“重新加载 Ctrl+R”，然后检查真实卡片。

0.2.3的Host/helper/patch与0.2.2相同，实际更新client.js和包版本；本轮已做页面重载并确认正确统计与持久化。五文件哈希见 [deployment-023.json](../workflow-ui-evidence-20260929/deployment-023.json)，只读复核见 [evidence-audit-023.json](../workflow-ui-evidence-20260929/evidence-audit-023.json)。不要照抄历史PID、删除SingletonLock或杀其它DSH实例。

## API

本机dev实例appserver为43130，正确只读地址：

```text
http://127.0.0.1:43130/dsh-workflow-pipeline/api/runs
```

`/api/dwf-pipeline/runs`不是本插件路由。端口属于该DSH实例，插件本身不另起HTTP监听。

相对于`/dsh-workflow-pipeline/api`：

- `GET /runs[?cwd=...]`：扫描到的运行列表，不再按60条截断。
- `GET /script?run=<id>`：脚本路径和内容。
- `GET /result?run=<id>`：out.json，未产生时404。
- `POST /stop?run=<id>`：写CANCEL，200仅表示请求写入。
- `POST /resume?run=<id>`：保留backend/concurrency/maxAgentCalls，确认新PID/startedAt生命周期后回200/accepted；引擎拒绝409、8秒未确认504。
- `POST /answer?run=<id>&q=<qId>`：JSON非空字符串answer；仅有效running的waiting问题；独占写inbox，重复/过期409。

完整字段和错误码见 [共同SPEC](../workflow-ui-v2-SPEC.md)。`PID_REUSED_ENGINE_GUARD`是安全拒绝，未杀复用PID的其它进程，也未改历史。

## 卡片与侧栏

- 四入口：脚本、按严重度的发现看板、结果、历史；含阶段时间线、agent状态、总量及单agent tokens/耗时、问题、产物和日志。
- 已经显示过的完成卡没有自动消失计时器；×只隐藏本客户端卡片，不删除运行记录，历史中仍能找到。
- `dwf-pipeline-visible-runs`、`dwf-pipeline-dismissed`持久化已显示/已关闭集合；其它新运行完成不会替换掉旧卡。首次加载仍只额外选择最新未关闭终态，不将所有历史一次性展开。
- 侧栏进度无TTL，按startedAt选择较新的匹配运行；目前标题/cwd basename近似匹配，不是真session ID关联。
- 回答pending/submitted跨普通轮询保持，失败保留草稿和可见错误；整页重载不承诺草稿恢复。
- 运行中时间随客户端时钟推进，不依赖新journal事件；终态冻结。完成统计已修为settled子代理数量。
- 两客户端有独立localStorage；在DSH关闭，不会同步隐藏MiniMax里的同run卡。

## 验证

在`G:/qoder-intl-project/else`运行：

```bash
node --test mmx-workflow-pipeline/test/client-lifecycle.test.mjs mmx-workflow-pipeline/test/host-lifecycle.test.mjs mmx-workflow-pipeline/test/sidecar.test.mjs dsh-workflow-pipeline/test/api.test.mjs
node --check dsh-workflow-pipeline/client.js
node --check dsh-workflow-pipeline/index.mjs
node --check dsh-workflow-pipeline/run-lifecycle.mjs
```

完整套件的4231固定端口测试需要协调暂停核对过身份的自有MiniMax sidecar；运行中直接执行可能skip。86/86、0 skip证据是已完成的完整测试，不用静态标记代替Host/UI行为。

真实计时用例：DSH在2分02秒和2分32秒两时点保持中文草稿，之后从界面提交，out/journal确认completed/file。普通并行展示的320 tokens是本机测试回执，不是模型计费。

[完整报告](../workflow-ui-evidence-20260929/ACCEPTANCE-023.md) · [证据索引](../workflow-ui-evidence-20260929/INDEX.md) · [测试原日志](../workflow-ui-evidence-20260929/plugin-023-tests.log)

## 已知限制

- 不宣称像素级1:1：本轮未重新取得红箭头参考图。无agent的已完成阶段仍可能灰/黑。
- 卡片按扫描根显示，session隔离近似；同runId跨root冲突和既有卡排序未解决。
- 文件artifact仅路径tooltip；URL新窗未本轮实测。卡片仅最近24个calls/4条logs，结果模态框超过65,536个JS字符截断。
- localStorage失败静默；pending只在当前document；stop缺即时失败反馈并允许终态写CANCEL。
- DSH模块teardown未完整移除modal/style；本轮更新通过原生重载，不以热卸载验证代替。
- 创建时间查询失败/缺startedAt时回退裸PID；非Windows路径未实测。引擎OWNER裸PID保护未改。
- 后台窗口可能节流或暂现旧截图；操作后需要前台真实观察再判定，不能重复未知结果的停止/回答动作。
- 历史181秒启动超时根因未定位，0.2.3全宿主退出重开和深色实机主题未重测。
