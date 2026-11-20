<h1 align="center">DeskLatch</h1>

<p align="center"><strong>为已有 AI Agent 提供桌面操作与用户审批。</strong></p>

<p align="center">
  <a href="https://github.com/wszkxlllll/desklatch/releases/download/v0.1.0-dev.2/DeskLatch-Windows-Setup.zip">下载 Windows 预览</a> ·
  <a href="docs/integrations.md">接入指南</a> ·
  <a href="docs/verification.md">实测记录</a>
</p>

DeskLatch 让 Agent 读取浏览器和桌面界面、执行一组操作，并在需要时等待用户确认。你可以把它装进 DeepSeek Harness，也可以接到支持本地 MCP 的客户端或自己的 Agent 应用。

## 快速安装

1. 从 [GitHub Release](https://github.com/wszkxlllll/desklatch/releases/tag/v0.1.0-dev.2) 下载 `DeskLatch-Windows-Setup.zip`，解压后双击 `install.cmd`。
2. 选择安装目录和接入方式。使用 DSH 桌面版时选 **DeepSeek Harness 插件**，先完成 DSH 的首次启动，再从系统托盘退出后安装。其他支持本地 MCP 的客户端选择 **MCP**，安装完成后复制生成的配置。
3. 打开想用的应用，点击向导里的「打开授权页」，勾选应用并保存。之后可以从安装目录运行 `DeskLatch-Authorize.cmd`，随时增减授权。
4. 启动客户端，例如让 Agent 在已授权的记事本草稿中填入一段文字，再切换到另一个已授权应用读取内容。

Windows x64 基础安装包含原生 CUA 驱动和窗口核验组件。OCR 和 E2B 可以分别安装或使用已有配置，也可以跳过。OCR 在获得截图授权后为难以判断的操作补充本地文字证据。配置 E2B 后，同一会话可以切换到云端浏览器或 Writer。 [安装说明](distribution/windows/README.md) · [OCR 与 E2B 配置](docs/setup-optional.md)

## 接入方式

| 你在用什么 | 怎么接入 | 如何审批 |
| --- | --- | --- |
| DeepSeek Harness | 安装原生插件，在 DSH 内注册 `desklatch_observe` 与 `desklatch_act` | 在 DSH 的会话卡上批准或拒绝 |
| 支持本地 stdio MCP 的客户端 | 导入向导生成的配置，由客户端启动 DeskLatch 服务。用户在授权页管理应用范围 | 在 DeskLatch 的 Windows 审批窗口批准或拒绝 |
| LangGraph、OpenAI Agents SDK 或自研应用 | 创建已授权的 DeskLatch 会话或工作区，将工具注册到现有 Agent | 通过 `onApprovalRequested` 和 `resolveApproval` 接入自己的界面及业务规则 |

三条路径共用同一套执行器。模型、对话历史和桌面会话由接入的宿主管理。[框架集成与接口](docs/integrations.md)

## 能做什么

- **按需读取界面。** 读取控件或网页正文，按关键词查找长页面。获准时再取图。
- **一次调用做多步。** 在每步执行前核对目标和权限，按指定条件读回结果，并返回逐步回执。
- **用代码处理任务分支。** 开发版可开启 Code Mode，让 Agent 在一次调用内按页面状态执行分支、循环和筛选。[Code Mode 接入](docs/code-mode.md)
- **让用户做关键决定。** 需要确认时暂停动作。用户同意后仍会检查操作对象是否变化。
- **复用已核验的步骤。** 宿主可记录合适的字段填写、标签切换和展开操作。再次使用时按当前页面核对。
- **接入本机或云桌面。** 已验证受管 Chromium、Windows UIA 和 E2B Desktop 路径。实际可用动作取决于宿主授权及所选后端。[支持范围和验证](docs/verification.md)

## 开发与发布

使用 Node.js 22.19 或更新版本。

```sh
npm ci
npm test
npm run pack:install -- ./distribution/out
```

产品设定、安装与发布分别见 [执行架构](docs/architecture.md)、[开发与接入](docs/integrations.md) 和 [DSH 插件市场](docs/dsh-market.md)。
