# Code Mode

宿主可为现有会话开启 `run_code`。Agent 提交一段 JavaScript 或可擦除类型的 TypeScript 函数体，在一次工具调用内执行分支、循环和数据筛选。对固定动作序列，直接调用多步 `act` 即可。需要根据中间页面状态决定下一步时，程序可以就地处理观察结果。

```js
import { createDeskCodeMode } from "desklatch/code-mode";
import { createLangChainTools } from "desklatch/langchain";

const host = createDeskCodeMode(workspace);
const tools = createLangChainTools(host.tools); // 注册到宿主已有的 ToolNode
const result = await host.runCode({
  code: `
    const found = [];
    for (const query of ["opening hours", "last admission"]) {
      const page = await desk.observe({ read: { query } });
      if (page.document?.matchCount > 0) found.push(query);
    }
    inspect(found);
  `,
}, signal);
```

`desk.observe(args)` 和 `desk.act(args)` 使用原工具的参数和权限。每次调用依次等待。`inspect(value)` 返回选中的 JSON 数据，另外返回 `calls`、`actions` 和最终状态。程序直接 `return` 的值留在沙箱内。TypeScript 通过 `language: "typescript"` 选用，支持类型注解等可擦除语法。

| 接入方式 | 开启方法 |
| --- | --- |
| TypeScript SDK、自研 Agent | `createDeskCodeMode(session)` 或 `createDeskCodeMode(workspace)`，注册返回的 `tools` |
| LangGraph、OpenAI Agents SDK | 用原适配器注册 `host.tools` |
| MCP | 服务参数使用 `desklatch-mcp --code-mode --windows <authorization-file>`，或在已有参数前加 `--code-mode`。用 SDK 创建服务时传入 `host.tools` |
| DSH 原生插件 | 在 DSH 宿主进程环境中设 `DESKLATCH_CODE_MODE=1`，工具名为 `desklatch_run_code`。用 SDK 挂载时传 `codeMode: true`，并接入原审批桥 |

程序在独立子进程中的 QuickJS WebAssembly 实例内运行。宿主只接收有大小限制的 JSON 消息，程序可触达的外部操作只有 `desk.observe` 和 `desk.act`。授权、目标校验、审批、核验及原生桌面动作都留在宿主端。程序内可读已授权的控件和正文，普通 `observe` 可继续使用宿主已授予的截图能力。[QuickJS WebAssembly 运行时](https://github.com/justjake/quickjs-emscripten/tree/main/packages/quickjs-emscripten-core)

宿主默认预算为 30 秒、16 次工具调用和 8 KiB 的 `inspect` 数据，源码上限为 32 KiB。默认脚本内存预算为 8 MiB，Wasm 线性内存硬上限为 24 MiB，包含引擎启动预留的 16 MiB。受信任的宿主可配置 `timeoutMs`、`maxCalls`、`memoryBytes` 和 `maxInspectBytes`。一段脚本独占同一宿主的工具调度，宿主负责协调共用一个桌面的多个会话。

遇到拒绝、目标变化、`partial`、`unknown` 或待审批结果时，脚本停止并交出已有回执。DSH 可在原生审批卡取得用户决定后返回该步的最终结果。取消或超时会停止脚本，并向正在等待的宿主操作发出取消信号。拿不到确切的动作回执时，结果记为 `unknown`，原调用收尾前同一宿主继续报告 `code_mode_busy`。是否继续由外部 Agent 根据实际页面和回执判断。

## 复跑真实网页

安装依赖后运行 `npm run build` 和 `node examples/code-mode-python-docs.mjs`。程序使用独立的 Chromium 会话。如果自动检测不到 Chromium，在 `DESKLATCH_CHROMIUM` 中提供浏览器可执行文件路径。示例打开 Python 官方模块索引，通过控件引用进入 `pathlib`，核对页面，再循环查找两个主题。验收从浏览器读取实际地址和页面标题项。[真实任务示例](../examples/code-mode-python-docs.mjs) · [评测计划](verification.md#下一轮成本对照计划)
