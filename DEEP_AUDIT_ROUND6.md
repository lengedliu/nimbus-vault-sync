# 深审索赔分析（游标竞态 / glob / git 冲突 / MCP 乐观锁 / 轻量批）

> 分析基线：main `8100185`（PR #7 合入，verify 171/171）。
> 本文档为逐项复核记录（不动代码），供后续修复批次决策。行号以此为基线。

## 项 3 — 广播/ack 带全局最新游标，客户端据此推进（**确认，中高危**）

### 3.1 服务端事实（静态证实）
所有广播与 ack 的 `cursor` 一律取 `deltaSync.getLatestCursor(vaultId)`（当时的全局最新游标），**从不携带该变更自己的 arrived 游标**：
- `src/wsHub.js:944` / `:965` / `:983`（broadcastFileChange 三种负载：pullRequired / inline）
- `src/wsHub.js:1018`（broadcastBatchFileChange 大批量汇总）
- `src/wsHub.js:1037`（broadcastFileDelete）
- `src/wsHub.js:417` / `:444` / `:482` / `:505` / `:585` / `:661` / `:716` / `:742` / `:781`（各路 push/delete/rename/conflict ack 与 completed）
- `src/routes/fileRoutes.js:383`（批量删除响应 cursor）

### 3.2 客户端事实（静态证实）
- `obsidian-plugin/main.js:383-389` `_advanceCursorIfSafe`：只要 `cursor > 本地游标` 且未被「失败冻结门」阻断，就**直接把本地游标推到该值**。冻结门（`:391`）只覆盖「本条广播应用失败」这一种已发现场景，覆盖不了**消息丢失**。
- `case 'change'` `:909-910`：应用成功 → 推进到 `msg.cursor`（全局最新）。

### 3.3 竞态推演（成立）
路径 A（消息丢失）：设备 A、B、C 并发写。某设备的 `change(A)[cursor=N]` 广播在传输中丢失（瞬断/断线重连），`change(B)[cursor=N+1]` 到达并被应用 → 本地游标 = N+1 → 下次 init 判 `localCursor === serverCursor` → 「秒级对齐完成」（`main.js:865-869`）→ A 的变更永久不再被增量重放，直到手动全量对账。
路径 B（握手窗口）：`wsHub._onConnection` 在 `:331` 就把 client 加入房间，而 init 在两个 await（`:346 initVault`、`:369 getManifestAsync`）之后才发出（`:373-379`）。窗口内任何广播先于 init 到达并应用 → 游标被推到最新 → init 判定对齐。
- 新设备（clientCursor<=0）首连时 init **必带清单**（`needManifest = clientCursor <= 0` `/ :368`），3-Way 仍会用清单兜底 → 新设备风险被清单缓解；
- **重连老设备**（clientCursor>0、canDeltaSync → init 不带清单，`:366-368`）风险最实：离线期间漏掉的变更被一条先行广播的 cursor 对齐假象跳过。

### 3.4 定级
中高危（概率不高 × 静默丢数据）。修复方向（批次候选）：
1. 广播/ack携带**该变更自身的游标**（写路径 result 里 cursor 值可得：recordChange 返回值 / pendingChange 记录），或
2. 客户端把 `_advanceCursorIfSafe` 的推进条件收紧为「本条应用后其 path 的落地 hash == msg.hash 且 cursor==msg.cursor 是本条变更自身游标」，或
3. 握手窗口：init 发出前不广播给该 client（挂起缓冲），或客户端在收到 init 前忽略广播游标只应用内容。

## 项 4 — 忽略规则 glob 转换缺陷（**确认，已实测双端**）

用真实 `syncRules` 模块实测（vault 级 ignorePatterns）+ 独立管线探针（`C:\Users\liuyc\AppData\Local\Temp\opencode\probe-glob*.js`）：

| 规则 | 路径 | 服务端 | 客户端 |
|---|---|---|---|
| `notes.*` | `notes.md` | false（regex `^notes\.*$`） | false（同坏） |
| `notes.*` | `notes` | true（误伤：无扩展名文件） | true（同坏） |
| `a/**/b.md` | `a/x/y/b.md` | false（regex `^a/(.:.*/).b\.md$`——`(?:.*/)?` 被 `\?→.` 替换毁掉） | **true**（占位符修复生效，`main.js:440-453`） |
| `Archive/**/drafts/*` | `Archive/2024/drafts/n1.md` | false | **true** |
| `**/drafts/*` | `a/b/drafts/n.md` | true（仅头部 `**/` 被前缀处理救了） | true |
| `notes?.md` | `notes/.md` | **true**（`:132` `\?→.` 可匹配 `/`） | false（客户端 `[^/]`，`main.js:451`） |

定位：
- 服务端 `src/syncRules.js:125-133`：`:129` 直接把 `**` → `(?:.*/)?` **插值后再被 `:132 .replace(/\?/g,'.')` 改写**（`?` 架空）→ 中段 `**/` 全灭。客户端已用占位符（STAR_SLASH）保护并注释原因（`main.js:440-441`），服务端漏改。
- `notes.*` 双端同坏：`(?<!\.)\*` 的 lookbehind（服务端 `:131`、客户端 `:450`）让「转义点号后的 `*`」不走 `[^/]*` 分支，留下裸 `*` 作量词 → `^notes\.*$`。
- 服务端 `?` → `.`（可跨 `/`），客户端 → `[^/]`。

后果：面板加的这类自定义规则**客户端生效、服务端不拦**（REST PUT / WS push / MCP / git pull 路径照单全收）→ 双端忽略域不对称。默认规则（`.obsidian/cache/**` 等以 `**/` 开头）不受影响（前缀分支生效）。
修复方向：服务端照抄客户端占位符方案；`notes.*` 需把 `(?)` lookbehind 改为「先保护 `**`/`**/`，再对剩余裸 `*` 无条件替换」并对「前段已转义点号」的写法（`*.ext` 或 `目录.*`）单独处理（或直接按目录段拼接）；统一双端 `?` 语义为 `[^/]`。**双端同一套共用语义 + 一致性测试用例**（可加 `test/syncRulesGlob.test.js` 对拍双端——客户端逻辑可从 plugin main.js 抽转到 shared 文件或复制比对）。

## 项 5 — git 同步缺合并冲突处理 + 绕过文件锁（**确认，结构性证实**）

- `gitSync.initRepo` `:206` 设置 `pull.rebase=true`（仅初始化时写入；**旧仓库不会补写** → 它们 `pull()` 走默认 merge）→ 「混用两种策略」对旧仓库成立。
- `gitSync.pull` `:546` 失败只 `return {ok:false,error}`（`:547-549`），**没有任何 `merge --abort` / `rebase --quit` 清场** → 冲突残留：`MERGE_HEAD` / `rebase-merge` 目录 + `<<<<<<<` 标记写进 `files/`。
- `commitAndPush` `:354` 无条件 `git add -A` → `:357` status 计数 → `:370 commit`。若仓库停在 **merge 冲突态**，add -A 会把冲突标记 stage，`git commit` 会提交合并（带标记）并推送 `:389`——污染面扩大到所有客户端。rebase 中间态则 commit/push 行为形变，仓库 wedged，后续 pull 全挂。
- `gitSync` 全文**无 withFileLock**：pull/checkout/commit 直接改 `files/` 工作树，与 REST/WS 写（持锁）互不感知——半写入状态被 commit 进快照或文件内容被 git 覆盖。
- 未即便如此：本项**未运行时复现**（测试无法用 file:// 远端，gitUrlGuard 拒绝）；三幕实验（PR #7 记录）只证明 ORIG_HEAD 语义。冲突路径为结构性推演 + git 标准行为佐证。
修复方向：pull 失败时识别 `CONFLICT` → `git merge --abort`（或 rebase 对应 abort）→ 工作树回原点 + 明确错误信息（建议触发 3-Way 或主分支重置策略）；commitAndPush 前检查 `git status --porcelain` 中的 `UU/AA/MERGING` 状态守卫；git 操作与文件锁互斥（或至少 commitAndPush 前做一致性检查）；给旧仓库补写 `pull.rebase` 配置（initRepo 之外的 ensureGitConfig）。

## 项 6 — MCP write_note 乐观锁被兜底架空（**确认，静态证实**）

- `src/mcp.js:506`：`actualBaseHash = baseHash || manifest[cleanPath]?.hash` —— 调用方不传 baseHash 时，取**服务端当下哈希**传给 `writeFileAsync` → `:1314` 的 `baseHash && existingHash !== baseHash` 永远为假 → 冲突检测被架空，直接 LWW 覆盖（仅留 snapshot）。
- 工具描述（`:494`）宣称「for optimistic locking & conflict prevention」——兜底使可选参数变成了摆设；MCP 客户端（LLM）通常不会传 baseHash。
- `:505` `storage.getManifest(id)` **同步调用在锁内**：缓存冷时整库同步扫描阻塞事件循环（storage.getManifest 同步全扫；与 wsHub C-3 整读盘同型，但此处在锁内）。
- WS push 路径（`wsHub:543`）`baseHash: msg.baseHash` 未带时同样自然跳过（设计如此，主要是 MCP 的兜底误导性最强）。
修复方向：`baseHash` 附录兜底改为：**文件已存在**时若未传 baseHash → 返回明确的「需要先 read 再写或显式 force:true」；或新增可选 force 参数并改工具描述。`:505` 改用 `storage.getManifestEntry`（O(1) 内存条目）或 `getManifestAsync`（锁内可用 async）。

## 轻量项（逐条复核）

**L1 空父目录** — 确认：`storage.deleteFile` 同步版有目录剪枝（`:1517-1527`），`deleteFileAsync`（`:1549-1593`）无 → WS/REST/MCP 全走 Async 版，服务端遗留空目录。PR #7 新增的 missing-分支补录也无剪枝（一致）。修复：把剪枝循环提为内部 helper，两版共用。

**L2 overwrite_latest = LWW；merge-both 冲突标记进正文** — 确认：`storage.js:1319/1347` fall-through 注释即语义（不比较新旧、无条件覆盖，snapshot 留档）；`conflicts.js:141-146` merge-both 把 `<<<<<<<` 块写进 base 正文并广播同步全设备。均为设计取舍，建议仅更新文案/文档警示（或给 LWW 版本留副本/通知）。

**L3 /changes compact 边界** — 确认（条件苛刻）：SQL 路径 `:505` `queryLimit = max(maxLimit+1, MAX_CHANGES_RETENTION)` → 原始记录恰为 5000 时 `rawExhausted=false`；若压缩后 ≤ maxLimit → `hasMore = false`（`:529` `|| (!rawExhausted && !shouldCompact)` 在 compact 下被排除）且 `nextCursor` 停在中间游标 → 本轮不再追。**自愈性**：客户端下次 init 会从旧游标续跑（`main.js:858`），只是延迟再探。影响可忽略~低。修复：`hasMore` 在 compact 下加上 `!rawExhausted`（与逐条路径一致）。

**L4 error 消息不清 rename 等待** — 确认：插件 `main.js:1043-1046` `case 'error'` 只 resolve `push:` / `delete:` 两种 key → `sendWsMessageAndWait`（`:2240` key=`${type}:${path}`，默认 15s）的 `rename:` 永不早退（服务端 rename 失败若发 error，回退分支 `:997-1001` 只处理 `rename_fallback`）。修复：error case 补 `rename:` 一行。

**L5 WS 监听器注册时序** — 确认：`wsHub._onConnection` `:331` 入房 → `:346/:369` 两个 await → `:381-386` 才注册 message/close/error。窗口内：客户端消息无人读（丢失）；连接若断开则房间清理延后（僵尸 client 占位 till 窗口结束）。修复：把 message/close/error 注册挪到 `:331` 入房之前（handler 内部处理「init 未就绪」态，如缓冲/拒绝）。

**L6 首同步清单重复传输** — 确认：新设备 clientCursor=0 时 WS init **带全量清单**（`wsHub:369/368`）→ 客户端 `case 'init'` `:858` 走 `syncDeltaChanges(0)` → HTTP `/changes?since=0` → 服务端路由 `vaultRoutes.js:65-75` **再附上全量清单**（full:true+manifest）→ 客户端用它执行 3-Way 后 `break`（`:863`）——WS init 的清单载荷已下载未被使用。两份全量清单一包套一包。修复：`/changes` 在 `since<=0` 时不附清单（客户端反正会走 fetchManifestHttp 兜底），或客户端在 init 已带清单时不再调 `/changes?since=0`（直接用 msg.manifest 进 3-Way）。

**L7 批量删除不隔离 durable 失败** — 确认（准确定义）：当前实现**按条 try-isolated**（`fileRoutes.js:337-361` 每条独立 withFileLock+结果收集），被删文件广播也在循环后统一发出 `:363-369`。但每条的 `deleteFileAsync` 是 durable 语义（W-1/PR #7：delta 记录持久化失败**上抛**）→ 循环中第 k 条失败直接把整个 route 打成 5xx（asyncHandler），**已成功的前 k-1 条广播没发出**（broadcast 在循环之后）。即「日志（delta 记录）写失败 → 整体 5xx + 已删文件不广播」成立，并非逐条失败的时序。修复：循环内 catch 单条失败（记 failure 项继续），或把广播挪进 finally；响应区分 success/partial。

## 修复批次建议（供批复）

以上全部为「确认」。建议优先级：
- **批次 A（语义正确性，中高危）**：项 3（游标竞态，含广播带自身游标/握手窗口）、项 4（glob 双端对齐+测试）、项 5（git 冲突清场+状态守卫+锁互斥）。
- **批次 B（接口契约，中危）**：项 6（MCP 兜底契约修复 + 锁内 getManifest 换 O(1)/async）。
- **批次 C（轻量顺手）**：L4（error 清 rename）、L5（监听器前移）、L6（首同步免重复清单）、L1（Async 剪枝）、L3（compact hasMore）、L7（批量删除隔离/广播 finally）、L2（文案/文档警示级）。

---

## 修复执行记录（PR #8 批次 A 落地 + e97d966 整合说明）

### 基线上移与整合
分支拉取前 main 前进 1 个提交：`e97d966 fix: improve sync reliability and conflict handling`（用户侧直接推 main，非本流水线产物）。逐块审查结论——**与本批项 3/项 4 无重复实现**，且主题互补：
- e97d966 已修 **L3**（`deltaSync.js` compact 边界 `hasMore = sourceItems.length > maxLimit || !rawExhausted`，与本报告 L3 修复方向一致）→ 轻量批 C 中 L3 划出范围。
- e97d966 的插件侧游标推进加「单调守卫」（`syncDeltaChanges` 收尾 `nextCursor > current` 才推进；3-Way 收尾 `max(current, remoteCursor, ackSeen)`）——与项 3 的保守方向一致，是**互补层**，保留。
- 其余为另一主题：rename 冲突安全（conflictSafe move + 副本广播）、Web 会话密码吊销（heartbeat 校验 + disconnectWebSessions）、admin/settings/dashboard 路由加固、`test/pluginSyncGuards.test.js`（+403 行）。
- 整合方式：stash → ff-only 到 `e97d966` → pop（自动合并无冲突）→ 对 e97 新增 rename 冲突分支的 ack 游标同化为 per-change 语义（冲突副本走 `getLatestCursorForPath(conflictPath)`，纯 serverWin 回退全局游标并注释说明）。

### 项 3 实现形态（与 3.4 修复方向 1+3 对应）
1. **per-change 游标**（修复方向 1）：`deltaSync.getLatestCursorForPath(vaultId, relPath)`——ring 回溯查该路径自身最近一条 durable 记录；ring 窗口外/未记录返回 null（调用方省略 cursor 字段，客户端只应用内容不推进——保守方向）。ring 只含 durable 记录（push 在 `_persistChange` 成功之后），语义上 ack/广播必然对应已持久化历史。
   应用面：wsHub 广播（fileChange/deleted/batch per-item）+ ack（push/delete/rename/conflict/pull/file 各路）+ HTTP PUT/DELETE 响应 + 插件 batch 分支按 per-item 最后一条游标推进（旧服务端回退 msg.cursor）。
   **保留全局游标的 4 处兼容位**（注释固化）：握手 init（客户端全量扫描收尾）、get_manifest 全量快照响应、serverWin ack（无记录，3-Way 基线语义）、广播批量汇总 >10（pullRequired 全量同步流程收尾）。
2. **握手窗口防伪对齐**（修复方向 3，服务端收口）：client 对象 `ready:false`，init 发出后置 `ready=true`；8 处房内广播循环 `if (client.ready === false) continue`。连带修复 **L5**：message/close/error/pong 监听前移至任何 await 之前（另有回归测试断言监听同步注册）。
3. 竞态定型修正（实现期论证）：单条 WS 连接内消息**有序可靠**，批量/单条广播不会乱序丢失；真实丢包窗口只剩「两次广播之间 socket 断开」与「重连握手窗口」——per-change 游标使断线缺口留在游标之下由下次 init 增量重放补齐，握手窗口由 ready 门关死。

### 项 4 实现形态
服务端 `syncRules.matchPattern` 与插件端 `matchIgnorePattern` 统一为同一占位符管线：`**/` 占位保护 → `**` 占位 → 裸 `*`→`[^/]*` → `?`→`[^/]`（不跨分隔符，双端一致）→ 还原占位。移除 `(?<!\.)` lookbehind 修 `notes.*`（正则转义后裸 `*` 无条件按 `[^/]*` 展开）。回归 `test/syncRulesGlob.test.js`（中段 globstar、`notes.*`、`?` 语义、默认规则、尾部 `**`）。
注意：把 `**/` 写进 `/** … */` 块注释会因 `*/` 序列提前闭合注释 → 语法错误，文档/测试注释一律用行注释表述 glob 语义。

### e97d966 自带缺陷的修复（并入本 PR）
全量跑 verify 时 `test/pluginSyncGuards.test.js` 挂死 + OOM（e97 原样即可复现，隔离运行通过 → 跨测试顺序依赖）。插桩定位根因：
- 循环链：`pushLocalFile` 遇 HTTP 响应 `serverWin/conflict`（`main.js:2321`）→ 受保护拉取 `pullRemoteFileViaHttp` → `applyRemoteBinaryChange` 的 R-1 覆盖防护把本地未同步内容备份为 `.conflict-offline-*` 副本并**立即推送副本**（`main.js:1911`，与 `applyRemoteDelete:2060` 同语义）→ 备份副本的 PUT 再次命中 serverWin 分支 → 再受保护拉取、再生成一层备份副本递归推送——路径名逐层追加，实测刷爆进程（1GB+ 输出）。
- 触发条件：Round 7 自死锁测试的 fetch mock 对**所有** PUT 路径（含备份副本）都回 serverWin；真实服务端对备份副本（新路径、baseHash 为空）必回 written:true，生产可达性低——但「无界递归备份」是真实防护缺失（服务端异常对账态/路径碰撞可触发）。
- 修复（双层）：① 插件 `pushLocalFile` 的 serverWin/conflict 分支加路径护栏——备份副本（`.conflict-offline-<ISO时间戳>` 叶子）挂起重试、不再触发受保护拉取（等价临时失败语义，3-Way 兜底）。该护栏同时覆盖 `applyRemoteDelete`（删除防护）与 `applyRemoteBinaryChange`（覆盖防护）两条备份推送链的递归入口；② 测试 mock 收窄为真实服务端语义（主路径 serverWin，副本 PUT written:true）。
- 同文件第二处 e97 测试 bug 顺带修复：`Round 7 WS serverWin` 用例断言 `plugin._conflictRestorePaths && has(...) === false`——该集合惰性初始化（serverWin 不创建），短路结果为 undefined ≠ false 必挂；改写为等价的组合断言。

### 测试
- `test/broadcastCursor.test.js`：per-change 游标单测（ring 回溯、未知路径 null、删除记录游标）；ready 门（未握手不广播）；`_onConnection` 监听器同步注册 + init 后 ready 置位。
- `test/syncRulesGlob.test.js`：6 组语义用例。
- 既有夹具（broadcastMeta/wsDeleteAck 等）经形态核对：client 对象无 `ready` 字段 → 门不拦截（`=== false` 精确判定），完全兼容。
