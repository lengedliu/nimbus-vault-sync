# 深审遗留项复核与处置记录（2026-10）

前四轮深审的报告只交付在历史会话中，未存入仓库；评审后修复已按 PR #3 / #4 / #5 分批合入。本文档对「当时标记但未列入修复批次」的遗留编号做一次对照现状的复核存档，并给出处置结论。复核基准：`main = 3eea81e`（159/159 全绿）。

## 复核方法

以长期不变量为判定基准（cursor 只在 durable 后推进；ack 即终态；ignored 文件不参与删除判定本地保留；覆盖前必须备份本地未同步修改；`_conflictRestorePaths` 一次性消费）。对 `src/wsHub.js`、`src/conflicts.js`、`src/mcp.js`、`src/routes/*`、`src/gitSync.js`、`obsidian-plugin/main.js` 的关键流程重新通读。

> 说明：W-6 / C-2 / C-4 / C-5 / C-6 / C-7 / C-8 / D-3 的原文编号无法完整恢复（报告未存档），本轮复核以当前代码实况为准重新给出编号 **E-1 ~ E-4**（E = 复核 batch）。若发现与历史记录对不上，以本文档为准。

## 复核结论

### 修复批次（本文档随批次 6 分支落地）

- **E-1（中危）git pull 删除路径从不广播**：`recordPulledChanges` 的 diff 解析中 `D`/`R/C` 旧路径只进 delta 记录，`changedPaths` 只含 UPSERT，pull 后的广播链路因此从不发送被删文件的通知。在线客户端的游标会经由任何后续广播推进到已包含该 DELETE 的最新游标，却从未收到/应用这个删除——被 git pull 删除的文件在其他设备**永久滞留**（`serverCursor === clientCursor` 判定「已对齐」，连 init 都不再触发增量重放），只能靠手动全量对账。
  处置：`recordPulledChanges` 返回 `deletePaths`；新增 `broadcastPulledChanges`（UPSERT 走批量 change，删除逐个走 `'deleted'`）；`pull()` best-effort 段调用。回归：`test/gitPullDurability.test.js`。

- **E-2（低危）删除/恢复/写回通道缺 ignore 黑名单检查**：WS delete 有黑名单检查，但 HTTP DELETE、batch delete、MCP delete_note、`restoreBatchTrash`、git pull 变更过滤均无——被忽略规则排除的路径可借删除通道把其他设备「本地保留」的副本真实删掉，也可借恢复/git-pull 通道绕过黑名单回流同步域。插件端 `applyRemoteDelete` 同时补齐端侧防线（纵深防御）。
  处置：服务端四处检查（拒绝/跳过，不产生变更记录、不广播）+ 插件端统一防护；回归：`test/gitPullDurability.test.js`、`test/deleteDurability.test.js`、`test/pluginSyncGuards.test.js`。

- **E-3（低危）0 字节远端文件被 WS file 通道判失败**：`applyRemoteChange` 用 `!base64Content` 拒绝空串——0 字节文件的 base64 是 `''`（合法内容）。空文件在 WS 'file' 通道永不落地且游标被 `_blockCursorOnFailure` 冻结到下次 init（HTTP 通道因 ArrayBuffer 恒 truthy 而无此洞）。
  处置：改为只拒绝 `null/undefined`；回归：`test/pluginSyncGuards.test.js`。

- **E-4（观感）serverWin 冲突通知文案误报**：`case 'conflict'` 文案固定输出 `副本: ${msg.conflictPath}`，serverWin 分支没有 conflictPath，用户看到 `undefined`。行为本身正确。
  处置：文案按 `msg.serverWin` 区分；回归：`test/pluginSyncGuards.test.js`。

### 已消除（复核验证通过，无需动作）

D-2 serverWin 终态 ack；conflict-copy 终态 ack（带 cursor）；C-1 WS delete 单终态 ack；写/删/移动全链路 cursor-durable；REST PUT ignored/conflict 伪基线（D-1/W-9/A2）；R-B 期待集消费点位；W-7 restore 持久化契约（先 record 后清理，失败上抛）；W-8 git pull durable 段上抛 + 广播降级段独立；C-3 广播链路同步整读盘（result→manifest→statFile）；WS push/delete/rename 的 ignored 分支一致性；游标安全门（advance/block）全事件覆盖；initSync 拉取失败绝不空 manifest 执行 3-Way；queuePendingLocalPush/补推 flush 时序；conflicts.js 事务时序与副本广播；MCP 写/删/移动 durable 先于广播。

### 备注项（不影响正确性，暂不处理）

- `src/wsHub.js` 约 1046-1100：`_scheduleDebouncedBatchNotification`/`_flushPendingBatch` 已无调用方（BATCH_DEBOUNCE_MS 合并广播机制闲置），属死代码，可择期清理。
- conflicts.js 的冲突落盘未做黑名单检查——冲突双方均为真实同步痕迹（主路径/副本），在冲突场景引入「静默丢弃落盘」反而制造新的对不齐状态；黑名单生效边界依赖上游写入过滤（git pull/REST PUT/恢复通道的 E-2 检查已覆盖），维持现状。
- 两轮全量 verify 曾各出现一次未复现失败（复跑同环境即绿），疑似既有时序 flake；如再现需按 TAP 输出定位。
