# Nimbus Sync — Obsidian 实时同步插件

专为自托管 **Nimbus Server** 定制的 Obsidian 双向实时同步插件。

## 功能特性
- ⚡ **WebSocket 极速双向同步**：秒级同步笔记的新建、修改、重命名与删除。
- 📦 **二进制与图片附件支持**：完整支持 Markdown 文档及图片等附件文件。
- 🔀 **智能并发冲突保护**：并发编辑时自动生成冲突副本保护笔记不被覆盖。
- 🔁 **重命名保留云端历史**：本地重命名/移动优先走服务端 `move`，不再拆成“先删后传”。
- 🔌 **离线变更可靠补发**：断网期间的编辑与删除进入补推/补删队列，重连后自动补发，不再静默丢失或被“复活”。
- 🚫 **云端忽略规则实时生效**：服务端 `syncRules.ignorePatterns` 变更即时下发（`rules_updated`），命中文件本地保留但不参与同步。
- 📊 **多 Vault 切换与即时创建**：直接在插件设置面板中选择或新建远程 Vault。
- 💓 **自动重连与心跳保活**：断网自动尝试重连，保持多设备在线状态。

## 安装方法

### 方式一：通过 BRAT 一键安装（推荐 · 支持桌面端与移动端）

1. 在 Obsidian 社区插件市场中搜索并安装 **BRAT** 插件。
2. 打开 BRAT 设置，点击 **Add Beta plugin**。
3. 粘贴仓库地址：`https://github.com/lengedliu/nimbus-vault-sync`，点击确认。
4. BRAT 将自动完成下载安装并启用 **Nimbus Sync**。

### 方式二：手动安装

1. 打开 Obsidian 笔记库，进入 `.obsidian/plugins/` 目录。
2. 新建名为 `nimbus-sync` 的文件夹。
3. 将本目录下的 `manifest.json`、`main.js`、`styles.css` 复制到该文件夹中。
4. 打开 Obsidian -> 设置 -> 第三方插件 -> 刷新已安装列表 -> 开启 **Nimbus Sync**。

## 配置与连接

- **一键导入（推荐）**：在 Nimbus Web 管理控制台点击 **「⚡ Obsidian 连接指引」** ➔ **「下载 data.json」**，保存至 `.obsidian/plugins/nimbus-sync/data.json` 即可免配置启动。
- **手动设置**：在 Obsidian 插件设置中填入 Server URL、Vault ID 及专属 Token 即可开始全双工实时同步。

---

