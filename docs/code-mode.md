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

评测宿主如需记录程序实际控制流，可在创建宿主时传入仅宿主可见的
`onEvaluation(evaluation)` 回调。回调拿到原始 `source`、公开运行结果和私有
`controlFlow`；控制流计数不会出现在 `run_code` 的工具回复、`inspect` 数据或审批
输入中。`controlFlow.branches` 记录实际条件取值，`loops` 记录实际进入循环体的
次数，`fixedWrapper` 标记没有分支或循环的直线程序。当前 AST 计数覆盖 `if`、三元
条件、`&&`/`||`/`??` 左侧短路决定、`switch` 分支和 `for`/`for…of`/`for…in`/
`while`/`do` 循环。`unsupported` 会标记 TypeScript 不可用、解析/打印失败、循环
函数声明包装和逻辑赋值等未覆盖情况；动态 `eval`/`Function` 生成的代码、回调或
库内部循环、可选链和异常边缘不纳入静态计数，正式记录时应按此限制分类。每次
最多保留 128 个分支和 128 个循环计数器，超出部分以 `unsupported` 标记。

| 接入方式 | 开启方法 |
| --- | --- |
| TypeScript SDK、自研 Agent | `createDeskCodeMode(session)` 或 `createDeskCodeMode(workspace)`，注册返回的 `tools` |
| LangGraph、OpenAI Agents SDK | 用原适配器注册 `host.tools` |
| MCP | 服务参数使用 `desklatch-mcp --code-mode --windows <authorization-file>`，或在已有参数前加 `--code-mode`。在启动环境设置 `DESKLATCH_CODE_MODE_MAX_CALLS` 可配置每次程序预算。用 SDK 创建服务时传入 `host.tools` |
| DSH 原生插件 | 在 DSH 宿主进程环境中设 `DESKLATCH_CODE_MODE=1`，工具名为 `desklatch_run_code`；同时可设 `DESKLATCH_CODE_MODE_MAX_CALLS` 配置每次程序预算。用 SDK 挂载时传 `codeMode: true`，并接入原审批桥 |

### 每次 `run_code` 调用预算

每个 `run_code` 程序默认最多调用宿主工具 16 次；`desk.observe` 和 `desk.act` 共用此预算。它按单次程序计数，不是模型 HTTP 轮数，也不跨程序累计。官方 MCP 和打包 DSH 插件可用 `DESKLATCH_CODE_MODE_MAX_CALLS` 设置 1–48 之间的十进制整数。只设置这个变量不会开启 Code Mode；MCP 仍须使用 `--code-mode` 或 `DESKLATCH_CODE_MODE=1`，DSH 仍须设置 `DESKLATCH_CODE_MODE=1`。Code Mode 已启用时，若预算值不是有效整数或超出范围，入口会在启动宿主前报错并给出修复提示；不设置时仍使用默认值 16。SDK 创建的 Code Mode 实例只使用传入的选项，例如 `createDeskCodeMode(session, { maxCalls: 24 })`，不会读取或改变其他实例的环境预算。

PowerShell 示例：

```powershell
# MCP：启动新进程时读取 32 次预算；--code-mode 独立开启功能
$env:DESKLATCH_CODE_MODE_MAX_CALLS = "32"
desklatch-mcp --code-mode --windows C:\path\authorization.json

# DSH：设置功能开关和预算后重启宿主或重新加载插件
$env:DESKLATCH_CODE_MODE = "1"
$env:DESKLATCH_CODE_MODE_MAX_CALLS = "32"
```

修改环境变量后，已运行的 MCP 进程需重新启动；DSH 需重启宿主或重新加载该插件，新的预算才会生效。

程序在独立子进程中的 QuickJS WebAssembly 实例内运行。宿主只接收有大小限制的 JSON 消息，程序可触达的外部操作只有 `desk.observe` 和 `desk.act`。授权、目标校验、审批、核验及原生桌面动作都留在宿主端。程序内可读已授权的控件和正文；Code Mode 的 `observe` 只返回文字和控件，截图能力仍由外层普通工具按其权限处理。[QuickJS WebAssembly 运行时](https://github.com/justjake/quickjs-emscripten/tree/main/packages/quickjs-emscripten-core)

## Code Mode 中的动作空间

脚本内的 `desk.observe` 使用同一会话的观察设置，可以用 `since:"previous"` 请求差分，或显式选择不带 `since` 的紧凑模式获取一份当前快照。读取批量数据时，先用 `where` 或正文关键词缩小范围，再在程序内筛选，并用 `inspect` 返回所需结果。动作引用以当前回复为准，其他目标可用精确 selector 或通过重新观察取得引用。[观察参数与快照有效期](actions.md)

`desk.observe` 和 `desk.act` 沿用同一会话的授权、能力交集和目标校验，不提供原生窗口句柄、shell 或后端私有命令。Code Mode 内的 `observe` 拒绝 `view:"image"` 和 `view:"both"`；需要图像时由宿主在普通工具边界按自己的图像授权处理。正文读取仍须浏览器会话和宿主同时允许。

`desk.act` 的步骤仍使用 `click`、`type`、`setValue`、`scroll`、`keypress`、`hotkey` 和（仅在某个后端公布时）`drag`。若当前能力的 `type` 条目带 `foreground:true`，Code Mode 也可提交 `delivery:"foreground"`；执行所需的私有几何和窗口图像不会进入脚本或工具回复。`ref`、`point` 和拖拽都绑定产生它的 `observationId`；`focusFromStep` 只能指向同一批中较早且已产生焦点记录的步骤。每次调用都应检查逐步回执，不能把 `completed` 当成每一步都已 `verified`。[完整动作空间参考](actions.md)

默认允许脚本实际执行 30 秒，单次宿主工具等待最多 120 秒，整次调用最多 180 秒。等待审批或云电脑启动计入工具等待及整次调用时间。默认上限还有 16 次工具调用、8 KiB 的 `inspect` 数据和 32 KiB 的源码。脚本内存预算为 8 MiB，Wasm 线性内存硬上限为 24 MiB，包含引擎启动的 16 MiB。宿主可通过 `timeoutMs`、`toolWaitTimeoutMs`、`overallTimeoutMs` 和其他预算选项配置。一段脚本独占同一宿主的工具调度。

遇到审批拒绝、撤销权限、目标变化、`partial` 或 `unknown`，运行时停止脚本并交出已有回执。对控件缺失、引用过期等定位问题，只有整批动作均确认未派发时才允许一次恢复。脚本须先取得新观察，再自行选择下一步。待审批状态由宿主处理，DSH 可通过原生审批卡取得用户决定后返回该步的最终结果。取消或超时会停止脚本并发出取消信号。原调用返回的权威回执仍会保留，等待期内无法确认的动作记为 `unknown`。同一宿主在原调用收尾前报告 `code_mode_busy`。

仅在 `createDeskCodeMode` 包装的宿主中，实际动作回执出现 `unknown`、`partial`、缺少请求步骤，或调用异常且无法证明未派发时，宿主会在结果顶层附上安全的 `reconciliationIncident`，并暂停后续 `act` 派发，包括直接工具和新程序。已明确拒绝的预检，以及完整的 `not_dispatched` 回执不会触发暂停。只读 `observe` 和 `inspect` 仍可用于独立核验；模型没有解除接口，也不会自动重放动作。

可信宿主可通过 `host.getReconciliationIncident()` 查询当前事件，并在独立核验后用 `host.reconcileActDelivery(incident.id)` 确认。只接受仍然匹配的当前 ID；有动作或程序仍在收尾时不会清除。动作审批与核验分开：事件未解决时，新的批准不会继续派发，拒绝仍可结清待审批请求。

## 复跑真实网页

安装依赖后运行 `npm run build` 和 `node examples/code-mode-python-docs.mjs`。程序使用独立的 Chromium 会话。如果自动检测不到 Chromium，在 `DESKLATCH_CHROMIUM` 中提供浏览器可执行文件路径。示例打开 Python 官方模块索引，通过控件引用进入 `pathlib`，核对页面，再循环查找两个主题。验收从浏览器读取实际地址和页面标题项。[真实任务示例](../examples/code-mode-python-docs.mjs) · [评测计划](verification.md#下一轮成本对照计划)
