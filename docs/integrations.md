# 接入 DeskLatch

DeskLatch 提供 `observe` 和 `act`。前者获取界面信息，后者派发经核对的动作并返回回执。宿主配置模型、可操作的界面及审批渠道。

```mermaid
flowchart LR
    DSH["DeepSeek Harness"] -->|原生插件| Desk["DeskLatch<br/>observe · act"]
    MCP["支持 MCP 的客户端"] -->|本地 MCP 服务| Desk
    SDK["LangGraph 或自研 Agent"] -->|TypeScript SDK| Desk
    Desk --> Web["受管 Chromium"]
    Desk --> Windows["Windows UIA"]
    Desk --> E2B["E2B Desktop"]
```

## DeepSeek Harness 原生插件

Windows 使用 [安装向导](../distribution/windows/README.md)。先启动 DSH 桌面版完成首次初始化，再从系统托盘完全退出。运行向导，选择原生插件，安装完成后打开授权页并勾选应用。经验证的版本为 DSH `0.2.2-rc.5`。

Windows 官方桌面版的 `resources/runtime/cli/bin/dsh.cmd` 位于应用安装目录，可用脚本全路径运行该命令。重新打开 DSH，在 **设置 → 模型** 选择已配置的模型即可试用。 [官方插件命令](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md) · [模型配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)

DSH 加载安装包里的 `dsh.bundle.patch`，挂载 Cordis 插件，注册 `desklatch_observe` 和 `desklatch_act`。Windows 插件加载 CUA 和授权页保存的应用范围。发生审批时，插件把等待请求交给 DSH 的会话审批服务，由用户决定是否恢复原动作。

已有 DSH Agent 循环的应用可以自行给插件提供已授权的会话。下例中的 `openDeskSession` 由宿主实现，并把回调传给 `createDeskSession`。

```js
import { createDeskDshApprovalBridge, createDeskDshPlugin } from "desklatch/dsh";

const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider, model },
  async setup(agentCtx) {
    const approval = createDeskDshApprovalBridge(agentCtx);
    const plugin = agentCtx.plugin(createDeskDshPlugin(
      () => openDeskSession({ onApprovalRequested: approval.onApprovalRequested }),
      { approval },
    ));
    await plugin.await();
  },
});
```

通过 DSH 的 Agent 发送任务，用完后调用 `handle.dispose()` 释放 Agent 和会话。 [独立 DSH 接入示例](../examples/frameworks/dsh.mjs)

## MCP 客户端

支持本地 stdio MCP 的客户端可使用 Windows 向导生成的配置。也可以在 Node.js 22.19 或更高版本下，下载核心包并在新目录运行以下命令。

```sh
npm install --omit=optional /path/to/desklatch-0.1.0-dev.2.tgz
npm exec -- desklatch-setup mcp --install
```

在授权页保存应用范围，再将 `desklatch.mcp.json` 中的 `mcpServers.desklatch` 导入客户端。Windows 配置会加载本机操作后端，关键动作通过 Windows 审批窗口确认。经 DSH 的官方 MCP 客户端使用时，可以从安装目录的 `desklatch.dsh-mcp.yml` 复制 `servers.desklatch` 配置，替换现有同名条目，工具调用带 `mcp__desklatch__` 前缀。[DSH 的 MCP 接入](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/mcp.md)

`desklatch-mcp --demo` 用于隔离浏览器示例。要接入应用自己的桌面，可以给启动命令传入宿主模块的绝对路径。模块导出 `openDeskSession()`，返回当前授权的会话。宿主也可以直接创建 `createDeskMcpServer(endpoints)`，连接自己的 MCP transport。会话通过 `onApprovalRequested` 回调交出待确认的动作。宿主展示请求后调用 `resolveApproval` 回传用户决定。[MCP 宿主示例](../examples/frameworks/browser-host.mjs)

## TypeScript SDK

在宿主项目安装 [Release 的核心包](https://github.com/wszkxlllll/desklatch/releases/tag/v0.1.0-dev.2)，再安装实际使用的框架和驱动。下面的 `page` 是宿主已打开且授权的 Playwright Page，`allowedOrigin` 是允许操作的来源。

```ts
import { createDeskSession, createDeskTools } from "desklatch";
import { createBrowserBackend } from "desklatch/browser";
import { createLangChainTools } from "desklatch/langchain";
import { ToolNode } from "@langchain/langgraph/prebuilt";

const session = createDeskSession(createBrowserBackend(page, {
  authorizedOrigins: [allowedOrigin],
}));
const endpoints = createDeskTools(session);
const toolNode = new ToolNode(createLangChainTools(endpoints));
// Register toolNode with the existing graph. At teardown: await session.close().
```

OpenAI Agents SDK 可以用 `createOpenAIAgentsTools(endpoints)` 把工具交给自己的 `Agent.tools`。其他 TypeScript 宿主直接调用 `createDeskTools(session)` 返回的工具定义及执行入口。多应用共用一个会话时，通过 `createWorkspace({ applications })` 登记授权应用。应用可以绑定已打开的桌面会话，也可以在第一次选中时由宿主接入。[LangGraph 接入示例](../examples/frameworks/langgraph.mjs) · [工作区接口](architecture.md#多个应用共用的工作区)

应用可通过 `canAutomate` 接入应用和窗口排除设置。在本仓库构建后运行 `node examples/automation-settings/server.mjs`，打开终端显示的地址即可试用设置页。[应用和窗口排除设置](architecture.md#应用和窗口排除设置)

使用智谱 Chat Completions 的 LangGraph 宿主，可以在模型调用前使用 `prepareDeskChatCompletionsMessages(messages)` 投递获准的图片，同时保留原始工具回复和调用编号。[模型接入示例](../examples/zhipu-acceptance.mjs)

## 工具接口

| 工具 | 常见用法 |
| --- | --- |
| `observe` | 使用 `{workspace:true}` 列出可选应用，或读取当前界面的控件、正文和获准的截图 |
| `act` | 使用 `{activate:"editor"}` 切换到已登记的编辑器，使用 `{navigate:url}` 打开获准的网址，或使用 `{steps:[...]}` 操作当前界面 |

目标明确时，可一次提交多个动作。执行器逐步查找实际控件、核对风险，并读取 `expect` 所指的结果。

```json
{
  "steps": [
    { "kind": "type", "target": { "name": "Title" }, "text": "Review" },
    {
      "kind": "type",
      "target": { "name": "Notes" },
      "text": "Approved draft",
      "expect": { "target": { "name": "Notes" }, "valueEquals": "Approved draft" }
    }
  ]
}
```

使用截图坐标、控件引用或拖拽端点时，需要带上 `observationId`。后端公布支持的动作与参数组合。网页正文需要浏览器后端和会话均授权读取，之后用 `observe({read:{query:"停止入场"}})` 查找，或把 `nextCursor` 作为 `read.cursor` 续读。宿主可用 `desklatch/reuse` 开启已核验步骤的记录与复用。[动作输入契约](../schema/act-input.schema.json) · [执行架构](architecture.md)

## 选装与验收

Windows 向导里可单独选择 OCR 和 E2B。原生插件与 MCP 读取相同的安装配置，沿用 `observe` 和 `act`。OCR 可在获得截图授权后补充本地证据。会话切换到 E2B 应用时才创建云电脑。 [可选组件配置](setup-optional.md)

运行 `npm run pack:install -- ./distribution/out` 生成核心包、DSH 包和 Windows 向导。普通 `npm test` 可离线运行。真实模型或 E2B 测试的密钥、运行条件和结束清理见验收记录。[可复跑测试](verification.md#复跑)
