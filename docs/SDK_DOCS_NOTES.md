# Claude Agent SDK 官方文档完整笔记

> 文档入口：https://platform.claude.com/docs/en/agent-sdk/
> 阅读日期：2026-03-03

## 目录

### 核心文档
1. [Overview](#1-overview)
2. [Quickstart](#2-quickstart)
3. [TypeScript SDK](#3-typescript-sdk)
4. [TypeScript V2 (Preview)](#4-typescript-v2-preview)
5. [Python SDK](#5-python-sdk)
6. [Migration Guide](#6-migration-guide)

### Guides
7. [Streaming Input](#7-streaming-input)
8. [Stream Responses in Real-time](#8-stream-responses-in-real-time)
9. [Handling Stop Reasons](#9-handling-stop-reasons)
10. [Handling Permissions](#10-handling-permissions)
11. [User Approvals and Input](#11-user-approvals-and-input)
12. [Control Execution with Hooks](#12-control-execution-with-hooks)
13. [Session Management](#13-session-management)
14. [File Checkpointing](#14-file-checkpointing)
15. [Structured Outputs](#15-structured-outputs)
16. [Hosting the Agent SDK](#16-hosting-the-agent-sdk)
17. [Securely Deploying AI Agents](#17-securely-deploying-ai-agents)
18. [Modifying System Prompts](#18-modifying-system-prompts)
19. [MCP in the SDK](#19-mcp-in-the-sdk)
20. [Custom Tools](#20-custom-tools)
21. [Subagents in the SDK](#21-subagents-in-the-sdk)
22. [Slash Commands](#22-slash-commands)
23. [Agent Skills](#23-agent-skills)
24. [Track Cost and Usage](#24-track-cost-and-usage)
25. [Todo Lists](#25-todo-lists)
26. [Plugins](#26-plugins)

---

## 1. Overview

### 核心概念

**Claude Agent SDK** 是一个封装了 Claude Code 所有功能的 API 包，让你能够在自己的应用中构建与 Claude Code 相同能力的 AI 代理。

**核心价值**：
- 与 Claude Code 完全相同的能力（终端集成、文件系统访问、MCP 支持等）
- 可编程控制权限和工具访问
- 会话持久化和恢复支持
- 支持 streaming 和 single-turn 两种模式

**SDK 类型**：
- **TypeScript SDK**: `@anthropic-ai/claude-agent-sdk`（npm 包）
- **Python SDK**: `claude-agent-sdk`（PyPI 包）

### 关键 API

核心函数 `query()`:
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Your prompt here",
  options: {
    // 配置选项
  }
})) {
  // 处理消息
}
```

### 对 teams-claude-bot 的价值

- SDK 提供了完整的 Claude Code 功能封装，比直接用 Messages API 更强大
- 内置会话管理、工具使用、权限控制
- 如果 teams-claude-bot 需要执行代码、操作文件系统等复杂任务，SDK 是更好的选择

---

## 2. Quickstart

### 核心概念

**安装方式**：
```bash
# TypeScript
npm install @anthropic-ai/claude-agent-sdk

# Python
pip install claude-agent-sdk
```

**认证方式**：
- 环境变量 `ANTHROPIC_API_KEY`
- 或在 options 中传入 `apiKey`

### 关键 API

**最简示例（TypeScript）**：
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  for await (const message of query({
    prompt: "Hello, Claude!",
    options: {
      allowedTools: ["Read", "Write", "Bash"],
    }
  })) {
    if (message.type === "assistant") {
      console.log(message.content);
    }
  }
}
```

**最简示例（Python）**：
```python
from claude_agent_sdk import query, ClaudeAgentOptions
import asyncio

async def main():
    options = ClaudeAgentOptions(
        allowed_tools=["Read", "Write", "Bash"],
    )
    async for message in query(prompt="Hello, Claude!", options=options):
        if hasattr(message, "content"):
            print(message.content)

asyncio.run(main())
```

### 对 teams-claude-bot 的价值

- 快速上手，几行代码即可运行
- `allowedTools` 控制 Claude 可用的工具集

---

## 3. TypeScript SDK

### 核心概念

**消息类型**：
- `AssistantMessage`: Claude 的完整响应
- `SystemMessage`: 系统消息（初始化、配置等）
- `ResultMessage`: 最终结果
- `StreamEvent`: 实时流事件（需启用 `includePartialMessages`）
- `PermissionRequest`: 权限请求
- `InputRequest`: 用户输入请求

**ClaudeAgentOptions 重要字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| `allowedTools` | `string[]` | 允许的工具列表 |
| `model` | `string` | 模型选择（opus/sonnet/haiku） |
| `sessionId` | `string` | 会话 ID，用于恢复会话 |
| `cwd` | `string` | 工作目录 |
| `systemPromptParts` | `SystemPromptPart[]` | 自定义系统提示 |
| `includePartialMessages` | `boolean` | 启用流式输出 |
| `permissionMode` | `string` | 权限模式（auto/ask/deny） |
| `mcpServers` | `MCPServerConfig[]` | MCP 服务器配置 |
| `agents` | `Record<string, AgentDefinition>` | Subagent 定义 |
| `hooks` | `Hook[]` | 钩子函数 |
| `settingSources` | `string[]` | 设置源（user/project） |
| `plugins` | `PluginConfig[]` | 插件配置 |

### 关键 API

**AgentDefinition（subagent 定义）**：
```typescript
interface AgentDefinition {
  description: string;  // 何时使用这个 agent
  prompt: string;       // agent 的系统提示
  tools?: string[];     // 限制可用工具
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}
```

**Hook 类型**：
```typescript
interface Hook {
  toolName?: string;        // 匹配的工具名
  pattern?: string;         // 匹配的模式
  before?: (context) => Promise<HookResult>;  // 工具执行前
  after?: (context, result) => Promise<void>; // 工具执行后
  onError?: (context, error) => Promise<void>; // 出错时
}
```

### 代码示例

**完整示例**：
```typescript
import { query, ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";

const options: ClaudeAgentOptions = {
  allowedTools: ["Read", "Write", "Bash", "Task"],
  model: "sonnet",
  cwd: "/path/to/project",
  permissionMode: "auto",
  agents: {
    "code-reviewer": {
      description: "Code review specialist for security and quality",
      prompt: "You are an expert code reviewer...",
      tools: ["Read", "Grep", "Glob"],
      model: "sonnet"
    }
  }
};

for await (const message of query({
  prompt: "Review the auth module",
  options
})) {
  switch (message.type) {
    case "assistant":
      console.log(message.content);
      break;
    case "result":
      console.log("Final result:", message.result);
      break;
  }
}
```

### 对 teams-claude-bot 的价值

- **subagents**: 可以定义专门的 agent 处理特定任务（代码审查、测试执行等）
- **hooks**: 可以在工具执行前后添加自定义逻辑（日志、验证、修改等）
- **permissionMode**: 控制权限请求的处理方式

---

## 4. TypeScript V2 (Preview)

### 核心概念

V2 是 TypeScript SDK 的预览版本，提供了简化的 API 和更好的类型支持。

**主要变化**：
- 更简洁的 API 设计
- 改进的类型推断
- 更好的错误处理

### 关键 API

```typescript
import { Agent } from "@anthropic-ai/claude-agent-sdk/v2";

const agent = new Agent({
  model: "sonnet",
  tools: ["Read", "Write", "Bash"],
});

const result = await agent.chat("Hello!");
console.log(result);
```

### 对 teams-claude-bot 的价值

- 如果项目刚起步，可以考虑直接使用 V2 API
- V2 设计更现代化，代码更简洁
- 但目前是 preview，可能有 breaking changes

---

## 5. Python SDK

### 核心概念

Python SDK 提供与 TypeScript SDK 相同的功能，使用 async/await 模式。

**ClaudeAgentOptions 字段**（Python 使用 snake_case）：
- `allowed_tools` → TypeScript 的 `allowedTools`
- `session_id` → TypeScript 的 `sessionId`
- `system_prompt_parts` → TypeScript 的 `systemPromptParts`
- `include_partial_messages` → TypeScript 的 `includePartialMessages`
- `permission_mode` → TypeScript 的 `permissionMode`
- `mcp_servers` → TypeScript 的 `mcpServers`
- `setting_sources` → TypeScript 的 `settingSources`

### 关键 API

```python
from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition
import asyncio

async def main():
    options = ClaudeAgentOptions(
        allowed_tools=["Read", "Write", "Bash", "Task"],
        model="sonnet",
        cwd="/path/to/project",
        permission_mode="auto",
        agents={
            "code-reviewer": AgentDefinition(
                description="Code review specialist",
                prompt="You are an expert code reviewer...",
                tools=["Read", "Grep", "Glob"],
                model="sonnet"
            )
        }
    )
    
    async for message in query(
        prompt="Review the auth module",
        options=options
    ):
        if hasattr(message, "result"):
            print(message.result)

asyncio.run(main())
```

### 对 teams-claude-bot 的价值

- 如果后端用 Python，可以直接使用 Python SDK
- API 设计与 TypeScript 一致，迁移成本低

---

## 6. Migration Guide

### 核心概念

从旧版 API 迁移到新版 SDK 的指南。

**主要变化**：
- 包名从 `@anthropic-ai/claude-code` 改为 `@anthropic-ai/claude-agent-sdk`
- 函数名从 `createSession` 改为 `query`
- 配置选项重命名和重组

### 对 teams-claude-bot 的价值

- 如果之前用过旧版 API，需要注意这些变化

---

## 7. Streaming Input

### 核心概念

**两种输入模式**：

1. **Single-turn mode**（默认）: 一次性发送完整 prompt
2. **Streaming mode**: 分段发送 prompt，支持中途中断

**何时使用 Streaming mode**：
- 处理大文件或长文本
- 需要实时反馈
- 可能需要中途取消

### 关键 API

```typescript
// Single-turn mode
for await (const message of query({
  prompt: "Complete prompt here"
})) {
  // ...
}

// Streaming mode
const session = await createStreamingSession(options);

// 分段发送
await session.write("First part of prompt...");
await session.write("Second part...");

// 结束输入
await session.end();

// 读取响应
for await (const message of session) {
  // ...
}
```

### 对 teams-claude-bot 的价值

- 如果需要处理长对话或大文件，streaming mode 更合适
- 可以实现打字机效果的用户体验

---

## 8. Stream Responses in Real-time

### 核心概念

通过设置 `includePartialMessages: true`（TypeScript）或 `include_partial_messages=True`（Python），可以接收实时的 token 流。

**StreamEvent 结构**：
```typescript
interface StreamEvent {
  uuid: string;           // 事件唯一 ID
  session_id: string;     // 会话 ID
  event: {                // 原始 Claude API 事件
    type: string;         // 事件类型
    // ...
  };
  parent_tool_use_id?: string;  // 如果来自 subagent
}
```

**常见事件类型**：
| 类型 | 说明 |
|------|------|
| `message_start` | 消息开始 |
| `content_block_start` | 内容块开始（文本或工具） |
| `content_block_delta` | 内容增量更新 |
| `content_block_stop` | 内容块结束 |
| `message_delta` | 消息级更新（stop_reason, usage） |
| `message_stop` | 消息结束 |

### 关键 API

**流式文本输出**：
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Explain databases",
  options: { includePartialMessages: true }
})) {
  if (message.type === "stream_event") {
    const event = message.event;
    if (event.type === "content_block_delta" && 
        event.delta?.type === "text_delta") {
      process.stdout.write(event.delta.text);
    }
  }
}
```

**流式工具调用**：
```typescript
let currentTool = null;
let toolInput = "";

for await (const message of query({
  prompt: "Read README.md",
  options: { 
    includePartialMessages: true,
    allowedTools: ["Read"]
  }
})) {
  if (message.type === "stream_event") {
    const event = message.event;
    
    // 工具开始
    if (event.type === "content_block_start" && 
        event.content_block?.type === "tool_use") {
      currentTool = event.content_block.name;
      toolInput = "";
    }
    
    // 工具输入增量
    if (event.type === "content_block_delta" &&
        event.delta?.type === "input_json_delta") {
      toolInput += event.delta.partial_json;
    }
    
    // 工具结束
    if (event.type === "content_block_stop" && currentTool) {
      console.log(`Tool: ${currentTool}, Input: ${toolInput}`);
      currentTool = null;
    }
  }
}
```

### 对 teams-claude-bot 的价值

🔥 **重要**：这是实现实时响应的关键功能

- Teams 消息可以实时更新，配合 streaming 可以提供更好的用户体验
- 可以显示 Claude 正在调用哪个工具
- 长任务可以分段显示进度

---

## 9. Handling Stop Reasons

### 核心概念

每条 `AssistantMessage` 都有 `stopReason` 字段，表示 Claude 停止生成的原因。

**stop_reason 类型**：
| 值 | 含义 |
|------|------|
| `end_turn` | 正常结束 |
| `max_tokens` | 达到 token 上限 |
| `tool_use` | 需要执行工具 |
| `stop_sequence` | 遇到停止序列 |
| `refusal` | 拒绝请求 |

### 关键 API

```typescript
for await (const message of query({ prompt: "..." })) {
  if (message.type === "assistant") {
    switch (message.stopReason) {
      case "end_turn":
        console.log("Claude finished normally");
        break;
      case "tool_use":
        console.log("Claude wants to use a tool");
        break;
      case "max_tokens":
        console.log("Response truncated");
        break;
    }
  }
}
```

### 对 teams-claude-bot 的价值

- 需要处理不同的停止原因，尤其是 `max_tokens`（可能需要继续请求）
- `refusal` 需要特殊处理，向用户解释为什么被拒绝

---

## 10. Handling Permissions

### 核心概念

SDK 提供了精细的权限控制机制。

**权限模式**：
| 模式 | 说明 |
|------|------|
| `auto` | 自动批准所有工具使用 |
| `ask` | 每次工具使用都询问 |
| `deny` | 拒绝所有工具使用 |
| `bypassPermissions` | 绕过权限检查（危险！） |

**权限请求消息**：
```typescript
interface PermissionRequest {
  type: "permission_request";
  permission: {
    tool: string;      // 工具名
    action: string;    // 操作类型
    path?: string;     // 文件路径（如果适用）
    command?: string;  // 命令（如果是 Bash）
  };
}
```

### 关键 API

**手动处理权限请求**：
```typescript
const session = await createSession(options);

for await (const message of session) {
  if (message.type === "permission_request") {
    // 自定义逻辑判断是否批准
    if (shouldApprove(message.permission)) {
      await session.approve(message.id);
    } else {
      await session.deny(message.id, "Permission denied by policy");
    }
  }
}
```

**使用 permissionTool 回调**：
```typescript
const options = {
  permissionMode: "ask",
  onPermissionRequest: async (request) => {
    // 自定义权限逻辑
    if (request.tool === "Bash" && request.command?.includes("rm")) {
      return { approved: false, reason: "Dangerous command" };
    }
    return { approved: true };
  }
};
```

### 对 teams-claude-bot 的价值

🔥 **重要**：安全关键功能

- 在 Teams 环境中，需要仔细控制 Claude 可以执行的操作
- 可以实现白名单/黑名单策略
- 敏感操作可以转发给用户确认

---

## 11. User Approvals and Input

### 核心概念

除了权限请求，Claude 还可以主动请求用户输入。

**InputRequest 类型**：
```typescript
interface InputRequest {
  type: "input_request";
  inputType: "text" | "choice" | "confirmation";
  prompt: string;
  choices?: string[];  // 如果是 choice 类型
}
```

### 关键 API

```typescript
for await (const message of query({ prompt: "..." })) {
  if (message.type === "input_request") {
    // 获取用户输入
    const userInput = await getUserInput(message.prompt, message.choices);
    
    // 发送输入
    await session.sendInput(userInput);
  }
}
```

### 对 teams-claude-bot 的价值

- 可以实现交互式对话，Claude 主动询问用户
- 支持多选题、确认框等 UI 模式
- 适合复杂任务需要用户确认的场景

---

## 12. Control Execution with Hooks

### 核心概念

Hooks 允许你在工具执行的生命周期中插入自定义逻辑。

**Hook 执行时机**：
1. `before`: 工具执行前，可以修改输入或阻止执行
2. `after`: 工具执行后，可以处理结果
3. `onError`: 工具出错时

**Hook 匹配方式**：
- `toolName`: 精确匹配工具名
- `pattern`: 正则匹配（工具名或参数）

### 关键 API

**Hook 定义**：
```typescript
interface Hook {
  toolName?: string;
  pattern?: string;
  before?: (context: HookContext) => Promise<HookResult>;
  after?: (context: HookContext, result: any) => Promise<void>;
  onError?: (context: HookContext, error: Error) => Promise<void>;
}

interface HookContext {
  tool: string;
  input: any;
  sessionId: string;
}

interface HookResult {
  proceed: boolean;      // 是否继续执行
  modifiedInput?: any;   // 修改后的输入
  skipReason?: string;   // 如果不执行，原因是什么
}
```

### 代码示例

**日志 Hook**：
```typescript
const loggingHook: Hook = {
  pattern: ".*",  // 匹配所有工具
  before: async (context) => {
    console.log(`[LOG] Tool: ${context.tool}, Input: ${JSON.stringify(context.input)}`);
    return { proceed: true };
  },
  after: async (context, result) => {
    console.log(`[LOG] Tool: ${context.tool}, Result: ${JSON.stringify(result)}`);
  }
};
```

**安全 Hook**：
```typescript
const securityHook: Hook = {
  toolName: "Bash",
  before: async (context) => {
    const command = context.input.command;
    if (command.includes("rm -rf") || command.includes("sudo")) {
      return { 
        proceed: false, 
        skipReason: "Dangerous command blocked" 
      };
    }
    return { proceed: true };
  }
};
```

**输入修改 Hook**：
```typescript
const sanitizeHook: Hook = {
  toolName: "Write",
  before: async (context) => {
    // 确保只能写入特定目录
    const path = context.input.path;
    if (!path.startsWith("/allowed/directory/")) {
      return {
        proceed: true,
        modifiedInput: {
          ...context.input,
          path: `/allowed/directory/${path}`
        }
      };
    }
    return { proceed: true };
  }
};
```

### 对 teams-claude-bot 的价值

🔥 **强力功能**

- **日志审计**: 记录所有工具调用
- **安全过滤**: 阻止危险操作
- **输入修改**: 沙箱化文件路径
- **通知**: 某些操作触发通知
- **成本控制**: 限制某些昂贵操作

---

## 13. Session Management

### 核心概念

Session 是 Claude 与用户对话的容器，包含：
- 对话历史
- 工具状态
- 文件变更历史

**Session 持久化**：
- 每个 session 有唯一 `sessionId`
- 可以通过 `sessionId` 恢复之前的会话

**Session 分叉（Forking）**：
- 从某个时间点创建新分支
- 原 session 不受影响
- 用于"假设"分析或并行实验

### 关键 API

**恢复会话**：
```typescript
// 首次对话，获取 sessionId
let sessionId: string;

for await (const message of query({
  prompt: "Start a project",
  options: { allowedTools: ["Read", "Write"] }
})) {
  if (message.type === "system" && message.subtype === "init") {
    sessionId = message.sessionId;
  }
}

// 稍后恢复会话
for await (const message of query({
  prompt: "Continue the project",
  options: {
    sessionId,  // 使用之前的 sessionId
    allowedTools: ["Read", "Write"]
  }
})) {
  // ...
}
```

**分叉会话**：
```typescript
// 从现有 session 创建分叉
for await (const message of query({
  prompt: "Try a different approach",
  options: {
    forkFrom: {
      sessionId: originalSessionId,
      messageId: branchPointMessageId  // 可选，从特定消息分叉
    }
  }
})) {
  // ...
}
```

### 对 teams-claude-bot 的价值

🔥 **核心功能**

- **会话持久化**: 用户可以跨时间继续对话
- **多线程**: Teams 的不同线程可以有不同的 session
- **分叉实验**: 让 Claude 尝试不同方案，选择最佳

---

## 14. File Checkpointing

### 核心概念

File Checkpointing 自动保存 Claude 修改的文件版本，支持回滚。

**工作方式**：
- Claude 每次修改文件，自动创建检查点
- 可以查看文件历史版本
- 可以回滚到任意检查点

### 关键 API

```typescript
// 启用 file checkpointing
const options = {
  fileCheckpointing: true,
  checkpointDir: "./.claude-checkpoints"
};

// 查看检查点历史
const checkpoints = await session.getFileCheckpoints("path/to/file");

// 回滚到特定检查点
await session.restoreCheckpoint(checkpointId);
```

### 对 teams-claude-bot 的价值

- 如果 Claude 修改了文件，用户可以轻松回滚
- 提供安全网，减少错误影响

---

## 15. Structured Outputs

### 核心概念

让 Claude 返回结构化 JSON 输出，方便程序处理。

### 关键 API

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// 定义输出 schema
const TaskSchema = z.object({
  title: z.string(),
  priority: z.enum(["low", "medium", "high"]),
  dueDate: z.string().optional()
});

for await (const message of query({
  prompt: "Extract tasks from this email: ...",
  options: {
    responseFormat: {
      type: "json_schema",
      schema: TaskSchema
    }
  }
})) {
  if (message.type === "result") {
    const task = message.result as z.infer<typeof TaskSchema>;
    console.log(task.title, task.priority);
  }
}
```

### 对 teams-claude-bot 的价值

- 可以让 Claude 返回结构化数据，方便后续处理
- 适合构建需要解析 Claude 输出的工作流

---

## 16. Hosting the Agent SDK

### 核心概念

在服务器环境中运行 Agent SDK 的最佳实践。

**考虑因素**：
- 资源限制（内存、CPU）
- 并发会话管理
- 日志和监控
- 错误处理

### 对 teams-claude-bot 的价值

- 服务端部署需要注意资源管理
- 多用户并发时需要隔离会话

---

## 17. Securely Deploying AI Agents

### 核心概念

安全部署 AI Agent 的最佳实践。

**安全建议**：
1. **最小权限原则**: 只给 Claude 必要的工具
2. **沙箱化**: 限制文件系统访问范围
3. **审计日志**: 记录所有工具调用
4. **输入验证**: 验证 Claude 的工具输入
5. **速率限制**: 防止滥用

### 对 teams-claude-bot 的价值

🔥 **重要安全指南**

- 企业环境必须重视安全
- 需要实现审计日志
- 敏感操作需要人工确认

---

## 18. Modifying System Prompts

### 核心概念

自定义 Claude 的系统提示以改变行为。

**SystemPromptPart 类型**：
```typescript
interface SystemPromptPart {
  type: "prefix" | "suffix" | "replace";
  content: string;
}
```

### 关键 API

```typescript
const options = {
  systemPromptParts: [
    // 在系统提示前添加
    { type: "prefix", content: "You are a helpful assistant for code review." },
    
    // 在系统提示后添加
    { type: "suffix", content: "Always be concise and focus on security issues." }
  ]
};
```

### 对 teams-claude-bot 的价值

- 可以定制 Claude 的人格和行为
- 添加公司特定的指南和限制

---

## 19. MCP in the SDK

### 核心概念

**MCP (Model Context Protocol)** 是标准化的工具协议，让 Claude 可以连接外部服务。

**MCP 服务器类型**：
- **stdio**: 本地进程通信
- **sse**: HTTP Server-Sent Events
- **websocket**: WebSocket 连接

### 关键 API

**配置 MCP 服务器**：
```typescript
const options = {
  mcpServers: [
    // stdio 类型
    {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      name: "filesystem"
    },
    
    // SSE 类型
    {
      type: "sse",
      url: "https://mcp.example.com/sse",
      name: "remote-tools"
    },
    
    // WebSocket 类型
    {
      type: "websocket",
      url: "wss://mcp.example.com/ws",
      name: "websocket-tools"
    }
  ]
};
```

**动态添加 MCP 服务器**：
```typescript
await session.addMcpServer({
  type: "stdio",
  command: "my-mcp-server",
  name: "dynamic-server"
});
```

### 对 teams-claude-bot 的价值

🔥 **扩展能力的关键**

- 可以通过 MCP 连接公司内部服务
- 可以添加数据库查询、API 调用等能力
- 模块化设计，易于扩展

---

## 20. Custom Tools

### 核心概念

除了 MCP，还可以直接定义自定义工具。

**Tool 定义**：
```typescript
interface CustomTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute: (input: any, context: ToolContext) => Promise<ToolResult>;
}
```

### 关键 API

```typescript
const options = {
  customTools: [
    {
      name: "get_weather",
      description: "Get weather for a location",
      inputSchema: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" }
        },
        required: ["location"]
      },
      execute: async (input) => {
        const weather = await fetchWeather(input.location);
        return { result: weather };
      }
    }
  ]
};
```

### 对 teams-claude-bot 的价值

- 可以快速添加自定义功能
- 不需要单独的 MCP 服务器
- 适合简单的功能扩展

---

## 21. Subagents in the SDK

### 核心概念

Subagents 是专门化的子 Agent，用于处理特定任务。

**Subagent 优势**：
1. **Context 隔离**: 子任务不污染主对话
2. **并行执行**: 多个 subagent 可以并行
3. **专业化**: 每个 subagent 有专门的 prompt
4. **工具限制**: 可以限制 subagent 的工具

**创建方式**：
1. **程序化定义**: 在 `agents` 参数中定义（推荐）
2. **文件系统定义**: `.claude/agents/` 目录下的 markdown 文件
3. **内置通用 subagent**: `general-purpose` subagent 自动可用

### 关键 API

**AgentDefinition 结构**：
```typescript
interface AgentDefinition {
  description: string;  // Claude 据此决定何时使用
  prompt: string;       // subagent 的系统提示
  tools?: string[];     // 可用工具（不填则继承所有）
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}
```

### 代码示例

```typescript
const options = {
  allowedTools: ["Read", "Grep", "Glob", "Task"],  // Task 是调用 subagent 的工具
  agents: {
    "code-reviewer": {
      description: "Expert code review specialist. Use for quality, security, and maintainability reviews.",
      prompt: `You are a code review specialist with expertise in security, performance, and best practices.
        When reviewing code:
        - Identify security vulnerabilities
        - Check for performance issues
        - Verify adherence to coding standards
        - Suggest specific improvements
        Be thorough but concise in your feedback.`,
      tools: ["Read", "Grep", "Glob"],  // 只读权限
      model: "sonnet"
    },
    "test-runner": {
      description: "Runs and analyzes test suites. Use for test execution and coverage analysis.",
      prompt: `You are a test execution specialist. Run tests and provide clear analysis of results.
        Focus on:
        - Running test commands
        - Analyzing test output
        - Identifying failing tests
        - Suggesting fixes for failures`,
      tools: ["Bash", "Read", "Grep"]  // 可以执行命令
    }
  }
};
```

**⚠️ 重要限制**：Subagent 不能再派生 subagent，不要在 subagent 的 tools 中包含 `Task`。

### 对 teams-claude-bot 的价值

🔥 **核心功能**

- **专业化分工**: 代码审查、测试、文档等各有专长的 agent
- **并行加速**: 多个 subagent 并行处理，提高效率
- **Context 管理**: 避免主对话被无关信息淹没
- **安全隔离**: 限制特定 subagent 的权限

---

## 22. Slash Commands

### 核心概念

Slash Commands 是用户可以直接调用的快捷命令。

**定义方式**：
- 在 `.claude/commands/` 目录下创建 markdown 文件
- 文件名即命令名
- 文件内容是命令的 prompt

### 关键 API

```typescript
// 启用 slash commands
const options = {
  settingSources: ["user", "project"],  // 加载文件系统设置
  allowedTools: ["SlashCommand", "Read", "Write"]  // 启用 SlashCommand 工具
};

// 用户可以使用 /command-name 调用
```

**命令文件结构**：
```markdown
# .claude/commands/review.md

Review the code in the current directory for security issues.
Focus on:
- Input validation
- Authentication
- Authorization
- SQL injection
- XSS vulnerabilities

Use the code-reviewer subagent if available.
```

### 对 teams-claude-bot 的价值

- 用户可以快速触发常用任务
- 标准化团队工作流

---

## 23. Agent Skills

### 核心概念

**Skills** 是 Claude 自主调用的能力模块，与 Slash Commands 不同：
- Slash Commands: 用户主动调用
- Skills: Claude 根据上下文自动判断是否需要

**Skill 文件结构**：
```markdown
# .claude/skills/pdf-processor/SKILL.md

---
description: Process and extract text from PDF documents
triggers:
  - pdf
  - document
  - extract text
---

When processing PDFs:
1. Use the pdf-tools MCP server
2. Extract text preserving structure
3. Return clean formatted text
```

### 关键 API

```typescript
// 启用 Skills
const options = {
  settingSources: ["user", "project"],  // 加载文件系统设置
  allowedTools: ["Skill", "Read", "Write"]  // 启用 Skill 工具
};
```

### Skill 位置

| 源 | 路径 |
|------|------|
| user | `~/.claude/skills/` |
| project | `{cwd}/.claude/skills/` |

### 对 teams-claude-bot 的价值

- Claude 可以自动使用适合的技能
- 不需要用户记住命令名
- 更智能的任务处理

---

## 24. Track Cost and Usage

### 核心概念

监控 Claude 的 API 使用量和成本。

**可追踪指标**：
- 输入 tokens
- 输出 tokens
- 工具调用次数
- 会话时长
- 模型使用

### 关键 API

```typescript
for await (const message of query({ prompt: "..." })) {
  if (message.type === "result") {
    console.log("Usage:", message.usage);
    // {
    //   inputTokens: 1234,
    //   outputTokens: 567,
    //   totalCost: 0.0234
    // }
  }
}
```

### 对 teams-claude-bot 的价值

- 监控使用量，控制成本
- 可以设置用量告警
- 按用户/团队统计使用情况

---

## 25. Todo Lists

### 核心概念

Claude 可以维护任务列表来跟踪复杂工作流的进度。

**Todo 工具**：
- `TodoAdd`: 添加任务
- `TodoUpdate`: 更新任务状态
- `TodoList`: 列出任务

### 关键 API

```typescript
const options = {
  allowedTools: ["TodoAdd", "TodoUpdate", "TodoList", "Read", "Write"]
};
```

### 对 teams-claude-bot 的价值

- 复杂任务可以分解为子任务
- 用户可以看到进度
- Claude 自己也能跟踪工作

---

## 26. Plugins

### 核心概念

Plugins 是打包的扩展集合，可以包含：
- Commands（命令）
- Agents（subagents）
- Skills（技能）
- Hooks（钩子）
- MCP servers（MCP 服务器）

**Plugin 结构**：
```
my-plugin/
├── .claude-plugin/
│   └── plugin.json
├── commands/
│   └── my-command.md
├── agents/
│   └── my-agent.md
├── skills/
│   └── my-skill/
│       └── SKILL.md
└── hooks/
    └── security-hook.ts
```

### 关键 API

```typescript
const options = {
  plugins: [
    { type: "local", path: "./my-plugin" },
    { type: "local", path: "/absolute/path/to/another-plugin" }
  ]
};
```

### 对 teams-claude-bot 的价值

- 模块化组织功能
- 易于共享和复用
- 版本控制和分发

---

## 总结：对 teams-claude-bot 的关键功能

### 必须实现

1. **Streaming Output** (`includePartialMessages`)
   - 实时显示 Claude 的响应
   - 提升用户体验

2. **Session Management** (`sessionId`)
   - 跨消息持久化会话
   - 支持 Teams 的线程模式

3. **Permissions** (`permissionMode`, hooks)
   - 安全控制 Claude 的操作
   - 敏感操作需要审批

4. **Subagents** (`agents`)
   - 专业化任务处理
   - 并行执行提高效率

### 建议实现

5. **MCP Integration** (`mcpServers`)
   - 连接公司内部服务
   - 扩展 Claude 能力

6. **Hooks**
   - 日志审计
   - 安全过滤
   - 自定义逻辑

7. **Cost Tracking** (`usage`)
   - 监控使用量
   - 成本控制

### 可选实现

8. **Skills**
   - 智能功能触发
   - 减少用户输入

9. **Plugins**
   - 模块化扩展
   - 团队共享

10. **File Checkpointing**
    - 文件修改回滚
    - 安全网

---

## 我们可能做错了或没用到的

### 1. 没有使用 `includePartialMessages`
如果当前实现是等待完整响应再发送，应该改为流式输出。

### 2. 权限控制不足
应该：
- 使用 hooks 过滤危险操作
- 记录所有工具调用日志
- 敏感操作转发给用户确认

### 3. 没有利用 Subagents
可以定义专门的 subagent：
- `code-reviewer`: 代码审查
- `document-writer`: 文档编写
- `test-runner`: 测试执行

### 4. Session 管理可能不完善
需要：
- 正确保存和恢复 sessionId
- 考虑会话超时和清理
- 支持 session 分叉进行实验

### 5. 没有 Cost Tracking
应该：
- 记录每个用户/团队的使用量
- 设置使用限额
- 成本告警

---

*笔记完成于 2026-03-03*
