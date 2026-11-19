# DeskLatch

A host-controlled computer-use runtime for AI agents.

DeskLatch 把桌面观察和操作接入已有 Agent。模型只得到 `observe` 和按授权开放的 `act`。宿主拥有桌面连接、任务循环、模型和用户审批渠道。核心包可独立加载，框架和驱动使用各自的子路径。

## 将桌面工具接入已有框架

以下代码由宿主运行。`page` 是宿主已打开且授权的 Playwright Page，`allowedOrigin` 是该页面允许操作的来源。

```ts
import { createDeskSession, createDeskTools, desktopToolInstructions } from "desklatch";
import { createBrowserBackend } from "desklatch/browser";
import { createLangChainTools } from "desklatch/langchain";
import { ToolNode } from "@langchain/langgraph/prebuilt";

const session = createDeskSession(createBrowserBackend(page, {
  authorizedOrigins: [allowedOrigin],
}));
const endpoints = createDeskTools(session);
const node = new ToolNode(createLangChainTools(endpoints));
// Add node to the host graph. desktopToolInstructions can be appended to its instructions.
// At host teardown: await session.close().
```

| 宿主 | 接入方式 |
| --- | --- |
| LangChain / LangGraph JS | `createLangChainTools(endpoints)` 返回框架工具。宿主自己绑定模型或创建 `ToolNode`。[可运行的 ToolNode 示例](examples/frameworks/langgraph.mjs) |
| OpenAI Agents SDK for TypeScript | 从 `desklatch/openai-agents` 导入 `createOpenAIAgentsTools(endpoints)`，把结果传给已有 `Agent` 的 `tools`。模型及 API 端点由宿主选择。[智谱实例](examples/zhipu-acceptance.mjs) |
| MCP 客户端 | 从 `desklatch/mcp` 导入 `createDeskMcpServer(endpoints)`，连接宿主的 MCP transport。stdio 启动器可加载宿主提供的本地模块，模块导出 `openDeskSession()`。[宿主示例](examples/frameworks/browser-host.mjs) |

构建完成后，MCP 客户端可将启动命令配置为 `node`，参数依次为 `dist/bin/mcp.js` 和宿主模块的绝对路径。此仓库内可试用 `node dist/bin/mcp.js examples/frameworks/browser-host.mjs`。它打开新建的无头浏览器测试表单，stdio 专用于 MCP。

## 一次调用多步

目标明确时直接传名称。执行器在各步派发之前查找实际控件、检查风险，并在有 `expect` 时读取动作后的真实状态。

```json
{
  "steps": [
    {"kind":"type","target":{"name":"Title"},"text":"Review"},
    {"kind":"type","target":{"name":"Notes"},"text":"Approved draft",
     "expect":{"target":{"name":"Notes"},"valueEquals":"Approved draft"}}
  ]
}
```

纯条件请求可以首调。使用控件引用、截图坐标或拖拽端点时需带上 `observationId`。每个后端公布自己的动作与参数组合。期望值只适用于已获准读取的公开字段。应用可用 `onApprovalRequested` 接收确认请求，再通过仅宿主可调用的 `resolveApproval` 处理用户决定。[运行时及宿主责任](docs/architecture.md) · [act 输入契约](schema/act-input.schema.json)

## 构建和验证

使用 Node.js 22.19 或更新版本。

```sh
npm ci
npm test
```

要从另一个项目接入，可在本仓库构建后运行 `npm pack`，将生成的 `.tgz` 路径交给宿主项目的 `npm install`。宿主按接入方式安装对应的框架或驱动，例如 `playwright-core` 和 `@langchain/core`。核心包的直接运行依赖只有 Ajv。

真实浏览器用例使用隔离的 Chromium 实例。可用 `DESKLATCH_CHROMIUM` 指定已安装的浏览器路径。主动运行 `npm run verify:zhipu` 时才使用 `ZHIPU_API_KEY` 调用智谱 `glm-5.3-flash`。工具参数只涉及脚本自己创建的表单，最终值由浏览器独立回读。该脚本同时记录模型请求、图片、工具调用及执行器观察次数。

[首版验收记录](docs/verification.md)
