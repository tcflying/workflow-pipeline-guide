# MiniMax Code DOM 探测报告（D1 产物）

- 探测时间：2026-09-28
- 目标：`app://./archon`（title `MiniMax Code`）
- 客户端版本：`MiniMax/3.0.74 Chrome/148.0.7778.280 Electron/42.8.0`
- CDP：`127.0.0.1:9331`（带 `--remote-debugging-port=9331` 重启后）
- 探测脚本：`docs/probe.mjs`（可复用，升级后重测流程见文末）；重启脚本 `docs/launch-cdp.mjs`
- 原始 dump：`docs/probe-raw.json`；证据截图：`docs/evidence-d1.png`

## 结论速览（D3 使用的常量）

| 用途 | 选择器 | 备注 |
|---|---|---|
| 侧栏会话行 | `[data-session-id]` | 行容器 div，438 行命中；`data-session-id="mvs_..."` |
| 行标题元素 | `[data-session-id] span.w-0.flex-1.text-sm.truncate` | 标题 span；行内唯一，可直接 `.textContent` 取标题 |
| 分组/工作区行 | `[data-testid="sidebar-session-group"]` | 属性 `data-workspace-dir` 携带工作区绝对路径；`data-project-key="workspace:<dir>"` |
| 分组标题元素 | `[data-testid="sidebar-session-group-title"]` | 组名文本（= `basename(workspace-dir)`） |
| 分组头行 | `[data-project-header]` | 组内可点击头（等同 DSH projectRow），`data-project-header="workspace:<dir>"` |
| 对话滚动容器 | `[data-testid="message-list"]` | 主对话消息滚动区，`overflow-y-scroll`，宽 661×高 808，scrollHeight 3343 |

> MiniMax Code 渲染层是 **Tailwind 应用**：所有 `class` 都是工具类（`items-center`、`group/nav`…），没有 DSH 那种哈希类名（`sessionRow_xxx`）。因此选择器全部键在 **`data-testid` / `data-*` 属性** 上，比类名稳定。

---

## 1. 侧栏会话行

- 行容器选择器：`[data-session-id]`
- 数量：438
- 行容器上的 data-* 属性：仅 `data-session-id`
- 标题元素选择器：`span.w-0.flex-1.text-sm.truncate`（行内唯一）
- 当前选中行额外带 `data-shortcut-session-active="true"`

真实 outerHTML 样本（截断 900 字符）：

```html
<div data-session-id="mvs_faa161fe5b9b4f268df128a8a682c21c">
  <div class="mavis-dropdown undefined" data-sidebar-keep-open="true">
    <div class="ant-dropdown-trigger group relative rounded-lg">
      <button type="button"
              data-shortcut-session-target="mvs_faa161fe5b9b4f268df128a8a682c21c"
              data-session-rename-trigger="mvs_faa161fe5b9b4f268df128a8a682c21c"
              data-sidebar-dismiss="true"
              class="w-full flex items-center gap-2 pl-2 pr-0.5 h-[30px] text-left transition-colors rounded-lg bg-bg_interaction_tertiary_hover text-text_default_primary"
              data-shortcut-session-active="true">
        <div class="min-w-0 flex-1 transition-all mr-2 group-hover:mr-[60px] group-focus-within:mr-[60px]">
          <div class="flex items-center gap-2">
            <span role="button" data-pinned-no-drag="true" data-sidebar-keep-open="true" class="flex-shrink-0 items-center justify-center cursor-pointer flex">…svg…</span>
            <span class="w-0 flex-1 text-sm truncate ">对比多个 codex 集成 ChatGPT 的项目</span>
          </div>
        </div>
      </button>
      …
```

标题 span 样本：

```html
<span class="w-0 flex-1 text-sm truncate ">对比多个 codex 集成 ChatGPT 的项目</span>
```

**行容器布局注意**：行容器 `display:block`（非 flex）。D3 追加进度行时需给容器/包装元素加 `flex-wrap` 之类样式，或把进度行插为独立块级子元素。

## 2. 会话列表与分组/工作区行

- 列表容器：`[data-testid="sidebar-session-list"]`，`data-view-mode="projects"`，class `pt-px space-y-px`
- 分组行选择器：`[data-testid="sidebar-session-group"]`
- 分组携带工作区路径的属性：`data-workspace-dir="G:\zcode-project\open Codex"`（反斜杠绝对路径），另有 `data-project-key="workspace:G:\zcode-project\open Codex"`
- 分组标题元素：`[data-testid="sidebar-session-group-title"]`（文本 = `basename(workspace-dir)`）
- 分组头行：`[data-project-header="workspace:<dir>"]`，`aria-label="<组名>, <workspace-dir>"`
- 438 行中 **432 行**位于某个分组内；其余为「置顶」（`data-pinned-section`）下的行，无 `sidebar-session-group` 祖先。

分组行真实 outerHTML 样本（截断 900 字符）：

```html
<div class="space-y-px" data-testid="sidebar-session-group"
     data-workspace-dir="G:\zcode-project\open Codex"
     data-project-key="workspace:G:\zcode-project\open Codex">
  <div class="mavis-dropdown undefined" data-sidebar-keep-open="true">
    <div role="button" tabindex="0" aria-label="open Codex, G:\zcode-project\open Codex" aria-expanded="false"
         data-project-header="workspace:G:\zcode-project\open Codex"
         class="group/project-header flex h-[30px] cursor-pointer items-center gap-2 rounded-lg pl-2 pr-0.5 text-left transition-colors hover:bg-bg_interaction_tertiary_hover focus:outline-none focus-visible:bg-bg_interaction_tertiary_hover ant-dropdown-trigger">
      <svg …>…</svg>
      <span data-testid="sidebar-session-group-title" class="min-w-0 flex-1 truncate text-sm leading-5 text-text_default_secondary">open Codex</span>
      …
```

> D3 的双路回退（兄弟扫描 + 祖先扫描）在此映射为：
> - **祖先路**：`row.closest('[data-testid="sidebar-session-group"]')` → 读 `data-workspace-dir` → `basename`。
> - **兄弟路**：向前找兄弟 `[data-testid="sidebar-session-group"]`（分组头是行之前的兄弟块）；找不到时回退读 `[data-project-header]` 的 `aria-label` 尾段。

## 3. 对话区滚动容器

- 选择器：`[data-testid="message-list"]`
- class：`message-container-viewport scrollbar-hide relative h-full w-full overflow-y-scroll overflow-x-hidden`
- 尺寸（打开会话时）：clientWidth 661 / clientHeight 808 / scrollHeight 3343
- 祖先链（testid）：`message-list > chat-panel-messages-surface > chat-main-conversation > chat-main-column`
- 同级可达的稳定锚点（备用）：`[data-testid="chat-main-conversation"]`、`[data-testid="chat-panel-messages-surface"]`、`[data-testid="chat-panel-body"]`
- 首页态（未打开会话）：`[data-testid="message-list"]` 不存在；首页是 `[data-testid="mavis-home-content"]`。
  `client-inject.js` 的 `VIEW_AREA_SEL` 已实现回退链：`[data-testid="message-list"], [data-testid="mavis-home-content"]`，
  取其中 `clientHeight` 最大者作卡片锚点——因此会话视图与首页态都能挂载卡片。

对比：侧栏滚动容器 `[data-testid="sidebar-scroll-fade-viewport"]`（388×724，scrollHeight 8809）——**不要**误当成对话区；`message-list` 才是对话消息区，且宽度最大者（661 > 388）。

## 4. localStorage

- **可用**：`localStorage.setItem/getItem/removeItem` 均正常，当前 49 项（renderer 为 `app://./archon` 源）。
- D3 的 `mmxdwf-dismissed` 持久化可直接用 localStorage，无需降级。
- 注意：源是 `app://./archon` 而非 `http://localhost`。CDP `Page.reload` 后同源保留，localStorage 不丢。

## 5. 其他实测要点

- `/json/list` 有 2 个 page：`MiniMax Code`（`app://./archon`，主窗口）与 `Rsbuild App`（`file:///…/react-screenshots/electron.html`，截图辅助窗口）。**注入必须选 title 含 `MiniMax` / url `archon` 的 page**（§7 C7）。
- 新 page 会在窗口重开时出现，sidecar 的 10s target 轮询需要这种发现逻辑。
- 会话行点击：点 `row.querySelector('button')`（`data-shortcut-session-target`）即可切换会话，用于验证。

## 6. 升级后如何重测（§7 C8）

```bash
node docs/launch-cdp.mjs   # 树杀 + 带 --remote-debugging-port=9331 重启 MiniMax Code
node docs/probe.mjs        # dump -> docs/probe-raw.json + stdout 摘要
```

若 `sessionRow.selector` / `messageList.selector` 命中数变为 0，按 `probe-raw.json` 的 `scrollers`/`sessionRow` 字段重定选择器，并同步更新 `client-inject.js` 顶部常量（`SELECTORS`）与本文件。