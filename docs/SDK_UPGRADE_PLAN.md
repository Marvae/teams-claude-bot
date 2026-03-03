# SDK 升级计划

> 基于 Claude Agent SDK 0.2.63 官方文档的功能评估
> 创建日期：2026-03-03
> 参考文档：`~/.openclaw/workspace/memory/research/2026-03-03-sdk-official-docs-complete.md`

## 背景

我们从 SDK 0.1.x 升级到 0.2.63，发现很多原生功能没用上，手动实现了很多 SDK 已经提供的功能。

## 任务列表

### Phase 1: Handoff 重构 🔄 进行中

- [ ] **用 `forkSession` 替代手动 hack**
  - Fork 模式：`options.resume = sessionId; options.forkSession = true;`
  - Continue 模式：`options.resume = sessionId;`（需要 Terminal `/exit`）
- [ ] **删除手动解析代码**
  - 删除 `findSessionFile()`
  - 删除 `findSessionCwd()`
  - 删除 `getSessionSummary()`
- [ ] **用 SDK 原生函数**
  - `listSessions()` — 列出 sessions
  - `getSessionMessages()` — 获取消息历史
- [ ] 更新 handoff 相关 UT
- [ ] 测试 Quick Pickup 和 Resume 两种模式

### Phase 2: 工具进度原生化

- [ ] **用 `tool_progress` 消息替代手动解析**
  - 当前：从 `assistant` 消息手动解析 `tool_use` blocks
  - 目标：直接监听 `message.type === 'tool_progress'`
- [ ] **启用 `includePartialMessages`**
  - 实现真正的文字流式输出
  - 配合 Teams `updateActivity` 做节流
- [ ] 更新 progress 相关 UT

### Phase 3: 费用追踪

- [ ] **读取 `total_cost_usd`**
  - 从 result 消息中提取
  - `/status` 命令显示累计费用
- [ ] **实现 `maxBudgetUsd`**
  - 添加 `/budget` 命令设置上限
  - 超限时拒绝执行并通知用户
- [ ] 添加费用相关 UT

### Phase 4: 权限系统

- [ ] **`/permission` 命令**
  - `default` — 危险操作会问（推荐）
  - `accept` — 自动允许文件编辑
  - `bypass` — 全部自动通过（现在默认）
  - `strict` — 未预批准就拒绝
- [ ] **`canUseTool` 回调 + Adaptive Card 审批**
  - 危险操作检测（rm -rf, sudo, curl|sh, .env, .key 等）
  - 发 Adaptive Card 给用户审批
  - 支持"始终允许"选项
- [ ] 添加权限相关 UT

### Phase 5: 其他优化（可选）

- [ ] **`thinking` 选项** — 替代已弃用的 `maxThinkingTokens`
- [ ] **Hooks 审计** — `PreToolUse` / `PostToolUse` 记录日志
- [ ] **MCP 集成** — `createSdkMcpServer()` 自定义工具
- [ ] **结构化输出** — `/analyze` 命令返回 JSON

## 不需要的功能

| 功能 | 原因 |
|-----|------|
| `persistSession: false` | 需要 handoff，必须保存 session |
| Sandbox 配置 | Teams bot 本身就是隔离的 |
| Agent/Subagent 系统 | 太复杂，当前不需要 |
| Worktree hooks | 不涉及 git worktree |

## 相关文档

- [SDK 官方文档](https://platform.claude.com/docs/en/agent-sdk/)
- [SDK 功能完整笔记](../../memory/research/2026-03-03-sdk-official-docs-complete.md)
- [SDK 0.2.63 功能发现](../../memory/research/2026-03-03-sdk-0.2.63-features.md)

## 进度跟踪

| Phase | 状态 | 负责人 | 预计完成 |
|-------|-----|-------|---------|
| 1. Handoff 重构 | 🔄 进行中 | Claude Code | 2026-03-04 |
| 2. 工具进度原生化 | ⏳ 待开始 | - | - |
| 3. 费用追踪 | ⏳ 待开始 | - | - |
| 4. 权限系统 | ⏳ 待开始 | - | - |
| 5. 其他优化 | ⏳ 待开始 | - | - |
