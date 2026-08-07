# LeetCode 复习插件 AI 交接文档

最后更新：2026-08-04（M4 阶段八、九个人本地 MVP 验收完成；版本 0.2.0）

## 1. 项目目标

开发一个 Chromium 浏览器扩展，读取用户在力扣中国站的已通过题目，建立本地个人题库，并根据复习反馈安排后续复习。用户始终拥有是否复习某道题的最终决定权。

当前项目不是公开发布版本，只允许继续开发个人本地 MVP。

## 2. 当前进度

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| 阶段一：范围与可行性 | 已完成，有条件通过 | 技术上可做本地原型；公开发布仍受平台授权约束 |
| 阶段二：产品规则与交互设计 | 已完成 | 已定义状态机、优先级、FSRS 边界、容量和页面流程 |
| 阶段三：账号连接与记录同步 | 已完成 | 实现、自动化测试和最小真实账号人工验收通过 |
| 阶段四：个人题库与自定义管理 | 已完成 | 实现、自动化测试和最小真实账号人工验收通过 |
| 阶段五：复习计划与重新排期 | 已完成 | 实现、自动化测试和最小真实账号人工验收通过 |
| 阶段六：每日复习闭环 | 已完成 | 实现、自动化测试和假数据 Chromium 端到端验证通过 |
| 阶段七：日历、统计与提醒 | 已完成 | 实现、自动化测试和假数据 Chromium 端到端验证通过；系统通知外观待真实浏览器确认 |
| 阶段八：隐私、数据与可靠性 | 已完成 | 隐私同意、导出、删除、访问锁、备份恢复、错误重试和安全复核通过 |
| 阶段九：测试与发布准备 | 已完成（本地 MVP） | 59 项自动化测试、隔离 Edge 视口验收和发布文档完成；公开发布仍受平台授权限制 |

任务清单实际共 97 项，当前完成 97 项。旧版交接中的“共 104 项”是统计错误。唯一任务状态来源是：

- `doc/LeetCode复习插件任务清单.md`

每完成一项任务必须立即更新该清单。完成整个阶段且需要说明文档时，新增独立 Markdown 文件，并在任务清单的完成记录中链接该文档。

## 3. 不可违背的决策

### 3.1 平台与范围

- 首版是 Chromium Manifest V3 桌面扩展。
- 支持 Chrome 和 Edge 发布时最新两个稳定大版本。
- 首版只支持 `leetcode.cn`，不支持 `leetcode.com`。
- 首版只支持单个当前账号。
- 只同步已通过题目，不同步仅失败的提交、提交代码或运行结果。
- 不实现在线判题、完整题解生成、社区、排行榜或多平台同步。

### 3.2 合规边界

- 力扣当前 GraphQL 是网站内部接口，不是具有版本承诺的第三方公开 API。
- 个人本地原型为有条件 GO。
- 未获得力扣书面许可或切换到明确允许的数据源前，公开商店发布和商业化均为 NO-GO。
- 不得把“端点可访问”描述成“已经获得使用授权”。

### 3.3 隐私与安全

- 不提供账号密码输入框。
- 不读取、导出或保存 LeetCode 密码、Session Cookie、CSRF 值和访问令牌。
- 不保存用户提交代码。
- 数据默认只存当前浏览器本地，不发送到开发者服务器或第三方分析服务。
- 用户手动设置的复习状态、重点、笔记和历史不得被平台同步覆盖。

### 3.4 时间数据

- 近期通过接口只能补充有限记录，不能获得完整历史首次通过时间。
- 实际近期通过时间来源标记为 `recent_accepted_submission`。
- 旧题缺少实际时间时使用首次同步时间作为内部计划基准。
- 首次同步时间不能在界面中冒充真实完成日期，必须显示“历史完成时间未获取”。

### 3.5 多设备边界

- 当前不做插件数据的云端多设备同步。
- 已实现的冲突处理只覆盖用户在其他设备改变 LeetCode 来源数据后，当前设备再次同步的场景。
- 不得未经重新评审就启用 `chrome.storage.sync`。

详细决策见：

- `doc/阶段一-范围与可行性决策.md`
- `doc/阶段二-产品规则与交互设计.md`
- `doc/阶段三-账号连接与记录同步.md`
- `doc/阶段四-个人题库与自定义管理.md`
- `doc/阶段五-复习计划与重新排期.md`
- `doc/真实账号最小人工验收记录-2026-08-01.md`
- `doc/M3代理验收记录-2026-08-04.md`

## 4. 当前代码结构

```text
manifest.json
package.json
src/
  background.js
  content-script.js
  core/
    account.js
    errors.js
    library.js
    privacy.js
    scheduler.js
    state.js
    sync-engine.js
    sync-service.js
  popup/
    index.html
    index.js
    styles.css
  app/
    index.html
    index.js
    styles.css
  storage/
    chrome-storage.js
test/
  account.test.js
  boundaries.test.js
  full-flow.test.js
  library.test.js
  privacy.test.js
  release-readiness.test.js
  scheduler.test.js
  storage.test.js
  sync-engine.test.js
  sync-service.test.js
scripts/
  browser-smoke.mjs
doc/
  LeetCode复习插件预期效果.md
  LeetCode复习插件任务清单.md
  LeetCode复习插件验收清单.md
  阶段一-范围与可行性决策.md
  阶段二-产品规则与交互设计.md
  阶段三-账号连接与记录同步.md
  阶段四-个人题库与自定义管理.md
  阶段五-复习计划与重新排期.md
  里程碑M3-使用闭环.md
  真实账号最小人工验收记录-2026-08-01.md
  隐私说明.md
  使用说明.md
  异常处理说明.md
  版本发布说明-0.2.0.md
  M4验收记录-2026-08-04.md
img/
  image1.png ... image5.png
  icon.svg
  icon-128.png
  m3-today-desktop.png
  m3-progress-desktop.png
  m3-calendar-detail.png
  m3-calendar-detail-mobile.png
  m3-today-mobile.png
```

项目没有构建依赖，根目录可直接作为“已解压的扩展”加载。

## 5. 关键实现入口

### `manifest.json`

- Manifest V3 入口。
- 后台服务工作线程为 `src/background.js`。
- 弹窗为 `src/popup/index.html`。
- 内容脚本匹配 `https://leetcode.cn/*`。
- 权限：`alarms`、`notifications`、`scripting`、`storage`、`tabs` 和力扣中国站 host permission。
- 没有申请 `cookies` 权限。

### `src/background.js`

负责：

- 查找已打开的力扣标签页；
- 必要时向安装前已打开的标签页补充注入内容脚本；
- 处理弹窗消息；
- 连接账号、手动同步和解绑；
- 配置 6、12 或 24 小时自动同步；
- 使用 `syncInFlight` 防止自动与手动同步重复发起；
- 使用单一 `operationQueue` 串行化同步、题库和计划写入；
- 只向弹窗返回摘要，不返回完整题库。

当前消息类型：

- `GET_STATE`
- `CHECK_ACCOUNT`
- `CONNECT_ACCOUNT`
- `SYNC_NOW`
- `UNLINK_ACCOUNT`
- `UPDATE_AUTO_SYNC`
- `OPEN_LEETCODE`
- `GET_LIBRARY`
- `UPDATE_QUESTIONS`
- `UPDATE_REVIEW_SETTINGS`
- `GET_PLAN`
- `GET_PROGRESS`
- `GET_QUESTION_DETAILS`
- `UPDATE_QUESTION_NOTE`
- `SUBMIT_REVIEW_FEEDBACK`
- `DEFER_TODAY_TASK`
- `SKIP_TODAY_TASK`
- `PAUSE_REVIEW_PLAN`
- `RESUME_REVIEW_PLAN`
- `OPEN_APP`
- `OPEN_QUESTION`

### `src/content-script.js`

这是经典内容脚本，不是 ES module，不要直接添加 `import`。

负责在力扣页面上下文中执行只读请求：

- `globalData.userStatus`：当前登录状态和最小账号信息；
- `problemsetQuestionListV2`：分页读取题目；
- `recentACSubmissions`：补充近期通过时间。

保护规则：

- 单页 100 条；
- 页间等待 120 毫秒；
- 最多 60 页；
- 单请求超时 20 秒；
- 只接受 `SOLVED` 和 `PAST_SOLVED`；
- 分页字段缺失或总数不一致时拒绝生成完整快照；
- 近期通过时间读取失败只产生 warning，不阻断题目同步。

注意：匿名环境下服务端可能忽略完成状态过滤，因此内容脚本仍会在本地过滤状态并在必要时读取完整分页。

### `src/core/sync-engine.js`

同步合并的核心纯函数。主要规则：

- 主键：`leetcode.cn:{sourceQuestionId}`；
- 来源 ID 缺失时回退：`leetcode.cn:slug:{titleSlug}`；
- 同 ID 更新，不创建重复题；
- slug 唯一匹配时可以补全主键；
- 不同 ID 但相同 slug 时标记冲突，不自动合并；
- 远端字段更新时保留 `review`、`reviewHistory` 和 `note`；
- 完整快照中消失的题目不删除，标记 `sourceAvailability: missing`；
- 缺失冲突类型为 `NO_LONGER_IN_SOLVED_SNAPSHOT`；
- `dataOwnerUserSlug` 不一致时抛出 `ACCOUNT_MISMATCH`。

### `src/core/sync-service.js`

同步事务边界：

1. 读取当前本地状态；
2. 获取完整远端快照；
3. 在内存中合并；
4. 单次保存合并结果和成功日志；
5. 失败时只保存错误状态，不修改 `questions`。

同步历史最多保留 50 条。

### `src/core/account.js`

账号与自动同步的纯状态规则：

- 连接相同账号；
- 阻止不同账号静默覆盖；
- 解绑并保留；
- 解绑并删除；
- 校验自动同步间隔；
- 计算下次自动同步时间。

### `src/storage/chrome-storage.js`

- 所有状态当前保存在 `chrome.storage.local` 的单个 `leetcodeReviewState` 键下。
- 使用单键保存，并由后台 `operationQueue` 串行化同步、题库和计划写入，避免并发丢更新。
- 读取旧状态时补齐版本 3 字段并立即持久化迁移结果。
- 数据量扩大后需要评估迁移到 IndexedDB，不能无评估直接拆散为多个非原子键。

### `src/core/state.js`

- 当前持久化版本为 `4`；
- 定义每日容量、新题规则、复习目标、面试冲刺、提醒和计划状态默认值；
- 迁移旧题目时只补齐缺失字段，不覆盖已有状态、笔记或历史。

### `src/core/library.js`

- 题库搜索、组合筛选、稳定排序和分页纯函数；
- 五种复习状态转换、暂停剩余间隔和恢复规则；
- 单题与全成或全不成的批量操作；
- 新同步题进入待确认或自动加入复习的设置。

### `src/core/scheduler.js`

- 固定参数 `fsrs-4.5-compatible-v1` 调度内核；
- 到期与首次复习两级队列及确定性优先级；
- 题数和预计时间容量、稍后、跳过、跨日积压与未来预测；
- 全局计划暂停恢复、薄弱优先和面试冲刺；
- 反馈幂等、进度统计、提醒判定、计划变更审计和最多 90 天计划历史。

### `src/app/`

扩展全页工作台，包含“今日复习”“复习进度”“我的题库”和“计划设置”。今日页支持详情、历史、笔记、反馈、稍后、跳过和状态调整；进度页支持完成率、可点击日期明细的日历、预测和薄弱分布。弹窗通过“打开复习工作台”进入该页面。

### `src/popup/`

当前弹窗负责阶段三同步摘要和工作台入口：

- 连接状态；
- 题目数量；
- 立即同步；
- 新增、更新、未变化和失败数量；
- 自动同步设置；
- 账号冲突提示；
- 解绑并保留或删除。

弹窗静态尺寸按 `368 x 520` 验证过，题库和计划功能已放入独立扩展全页应用。

## 6. 本地状态概要

根状态主要字段：

```text
schemaVersion
device
dataOwnerUserSlug
connection
questions
settings
sync
plan
```

`connection.status` 当前可能值：

- `disconnected`
- `connected`
- `needs_login`
- `conflict`

当前 `schemaVersion` 为 `4`，旧版本会在读取时迁移并持久化。新同步题目的 `review.status` 由设置决定，默认是 `pending`。支持：

- `pending`
- `reviewing`
- `paused`
- `graduated`
- `ignored`

每道题的 `review` 还保存：

- `isFocus`、`mastery`；
- `dueAt`、`lastReviewedAt`；
- `consecutiveMissedDays`、`remainingDaysOnPause`、`resumedAt`；
- 固定调度版本的 `fsrs` 卡片状态；
- `updatedAt` 和 `updatedByDeviceId`。

`settings` 当前包含：

- 新题进入 `pending` 或 `reviewing`；
- 题数或预计时间容量；
- 日常巩固、薄弱优先或面试冲刺目标；
- 每日提醒开关和本地提醒时间；
- 自动同步开关和间隔。

`plan` 保存全局暂停时间、今日任务、最多 90 天历史和最多 100 条变更审计。复习历史记录包含任务 ID、反馈、有效用时、前后到期时间、间隔和调度版本。

不要重命名已有持久化字段而不增加 schema migration。

## 7. 验证命令

```powershell
npm run check
npm test
npm run smoke
```

截至交接时：

- JavaScript 语法检查通过；
- Manifest JSON 可解析，所有入口文件存在；
- 59 项自动化测试全部通过；
- 除阶段三能力外，覆盖状态迁移、查询筛选排序、原子批量操作、优先级、FSRS 间隔、题数/时间容量、反馈幂等、稍后、跳过、笔记、跨日积压、暂停恢复、冲刺、统计聚合、提醒抑制和未来预测；
- 弹窗已使用 Edge 150 完成静态截图检查；M3 全页工作台已用 Chromium 扩展和假数据执行端到端流程，检查 1440px 和 390px 视口，无横向溢出或控制台错误。
- 用户已使用真实账号完成最小人工验收，首次同步 247 题；真实截图位于 `img/`。
- M4 已使用隔离 Edge 实例验证 1440px、390px 和 368px 页面，截图位于 `img/m4-settings-desktop.png`、`img/m4-settings-mobile.png` 和 `img/m4-popup-privacy.png`。

## 8. 加载扩展

1. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`。
2. 开启开发者模式。
3. 选择“加载已解压的扩展”。
4. 选择项目根目录 `D:\TraeWork\leetcode复习插件`。
5. 打开 `https://leetcode.cn/problemset/` 并登录。
6. 打开扩展，连接当前账号并执行立即同步。
7. 点击“打开复习工作台”进入今日复习、复习进度、我的题库和计划设置。

修改扩展代码后需要在扩展管理页重新加载扩展。

## 9. 真实环境验收状态

用户已于 2026-08-01 在本机真实登录环境完成最小人工验收：

- 账号识别和首次同步成功，共同步 247 题；
- 题量与来源一致，抽查元数据和近期完成时间通过；
- 重复同步、增量同步和用户状态保护通过；
- 真实题库、生成计划、反馈、跳过、暂停恢复和重载持久化通过；
- 退出登录后的错误提示和本地数据保留通过。

证据见 `img/image1.png` 至 `img/image5.png` 和 `doc/真实账号最小人工验收记录-2026-08-01.md`。断网超时、解绑两种模式、自动同步定时执行、连续多日使用和完整发布兼容性仍未逐项留证；不得表述为公开发布验收通过。

## 10. 已知风险与限制

1. GraphQL 接口非公开，字段可能随网站更新变化。
2. 平台授权问题尚未解决，不能公开发布或商业化。
3. 自动同步要求至少打开一个力扣标签页；没有标签页时记录为 `deferred`。
4. 近期通过接口只返回有限记录，无法回填完整历史首次通过时间。
5. 当前使用 `chrome.storage.local`，后续复习历史增长后可能需要 IndexedDB。
6. 数据导出和输入 `DELETE` 的不可逆删除已实现；删除仍不可恢复。
7. 插件已提供 128px 本地图标；其他商店尺寸和品牌资产仍待发布阶段补齐。
8. 当前没有云端复习状态同步，不要把来源冲突处理误认为插件多设备同步。
9. 分钟级短期复习关闭，同一道题同一自然日最多记录一次正式反馈。
10. M3 系统通知在无头 Chromium 中无法检查操作系统通知中心外观；提醒闹钟、发送条件和点击路由已有自动化证据，仍需在真实 Chrome 或 Edge 中做一次人工可见性确认。

## 11. M4 完成状态

任务清单中的 `T-701` 至 `T-811` 已完成并更新。隐私、使用、异常处理和版本发布文档分别位于 `doc/隐私说明.md`、`doc/使用说明.md`、`doc/异常处理说明.md` 和 `doc/版本发布说明-0.2.0.md`。当前仍不得公开发布或商业化，除非取得力扣书面许可或切换到明确允许的数据源。

## 12. 开发约定

- 手工修改文件使用 `apply_patch`。
- 保持代码零构建依赖，除非新依赖能明显减少核心复杂度并经过说明。
- 内容脚本保持经典脚本；需要共享逻辑时优先放在后台或通过消息传递，除非调整 Manifest 架构。
- 核心规则写成不依赖 `chrome` 全局的纯函数，使用 Node 内置测试运行器测试。
- 任何同步失败都必须保留已有题库和用户数据。
- 任何破坏性操作必须明确影响并要求确认。
- 不擅自修改已冻结的阶段一范围。
- 不因完成实现而勾选验收清单；验收必须有实际执行证据。
