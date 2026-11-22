# DeskLatch 动作空间

`observe` 读取授权范围内的界面，`act` 提交动作，启用 Code Mode 的宿主还可以提供 `run_code`。可用的操作由宿主授权、后端能力、会话选项和当前控件的 `actions` 共同决定。

Agent 填动作类型、目标及参数，还可以指定操作后要验证的状态。执行器负责找出唯一目标、核对权限和实时接收方、选择受支持的派发路径，并返回逐步回执。已知精确控件时可以直接提交 selector。需要寻找目标、取得引用或查看状态时，用 `observe` 获取证据。

工作区的 `observe({workspace:true})` 会列出已登记的应用。成功切换应用时，`act` 回执会附上当前应用实际支持的 `capabilities` 和 `actionParameters`，Agent 可直接用这份说明构造下一次调用。

## 紧凑观察和增量读取

旧调用沿用原有输出。宿主可以用 `defaultObservationProjection:"compact"` 为会话开启紧凑输出，也可以在一次 `observe` 中指定 `projection:{mode:"compact"}`。用 `projection:{mode:"full"}` 可临时读取原有详细视图。

知道要操作的控件名称时，优先用该动作支持的精确 selector。需要引用时，用 `where` 查名称、所在面板或当前焦点，拿到本次引用即可操作。找网页段落可用 `read.query` 按关键词读，长正文用 `document.nextCursor` 续读。要看布局或比较可见的行时，有截图权限的会话可直接取 `view:"image"`。宽查询用于目标和区域都未知、还需探索界面的情形。只有同时需要像素与控件时才取 `both`。

```ts
const request = {
  view: "controls",
  where: { role: "Edit", name: "Title" },
  projection: { mode: "compact" },
} as const;
const first = await session.observe(request);
const repeat = await session.observe({
  ...request,
  projection: { ...request.projection, since: first.observationId },
});
```

`projection.kind` 表示当前视图的快照（`snapshot`）、变化（`delta`）或该范围无变化（`unchanged`）。`projection.backendComplete` 表示底层查询的完整性，`projection.truncated` 表示模型输出裁剪。增量结果只携带变化项的当前引用，`projection.removed` 里的 `snapshotKey` 只供合并视图。对没出现在当前回复里的目标，使用精确 selector 或定向观察取得新引用。

紧凑模式下，全窗口或仅按角色列控件默认先展示最多 6 项，有具体范围的查询默认最多 48 项。需要展开时可显式传 `projection.maxControls`，同时受约 9 KiB 的控件数据预算和宿主上限约束。发布数量只影响模型看到的列表，动作前仍由执行器查找并核验目标。会话保存最多四份可比较的公开快照，时效为 90 秒。基准只在原会话、原窗口或页面范围、相同查询和预算内有效。范围变化、缓存过期、查询不完整或目标难以可靠匹配时，返回当前紧凑快照，`projection.fallback` 给出原因。

宿主可以用 `defaultObservationProjection:"incremental"` 自动比较重复的宽范围控件观察。自动比较适用于未传 `where`、正文读取参数或显式投影的 `controls` 和 `both`。定向 `where` 默认返回当前紧凑快照和新引用。模型可显式传 `projection:{mode:"compact",since:"previous"}` 比较同一查询的上一份紧凑快照。两种方式都重新读取当前界面。带截图的 `both` 仍会返回本次截图，比较只覆盖控件。

当回复带有 `projection.basis:"published_controls"` 时，`unchanged` 和 `removed` 描述的是已经向模型展示的控件列表。前后两次底层查询均须完整，才能比较截断后的公布列表。`projection.truncated` 仍会标记裁剪。模型可用 `projection:{mode:"compact"}` 重新获取当前紧凑快照，或用 `where` 取得特定控件的新引用。`snapshotKey` 只用于合并列表。动作可以使用精确 selector，或使用当前回复中的引用并携带对应的 `observationId`。

紧凑或增量会话的 `view:"image"` 不再附带控件列表。需要同时看截图和控件时可用 `view:"both"`。后端继续保留坐标派发和遮挡核对所需的内部证据。

控件无法识别时，Windows 和启用了截图降级的 E2B 桌面可对截图中的可见位置单击或按行滚动。截图关联采集时已授权的前台窗口。模型用截图的 `observationId` 加上像素坐标，执行器在派发前复查当前前台窗口、落点归属和遮挡。已识别的高风险动作继续走审批。Windows 配置了本地 OCR 时，程序还可在单击落点附近识别高风险文字。

## 一次典型调用

```ts
await workspace.observe({ workspace: true });
await workspace.act({ activate: "editor" });

const observation = await workspace.observe({
  view: "controls",
  where: { name: "Title" },
});
const result = await workspace.act({
  observationId: observation.observationId,
  steps: [{
    kind: "type",
    target: { name: "Title" },
    text: "Review",
    expect: { target: { name: "Title" }, valueEquals: "Review" },
  }],
});
```

工作区切换 `{ activate: "application-id" }` 和浏览器导航 `{ navigate: "https://allowed.example/path" }` 各用一次独立的 `act`。导航只接受宿主允许的 HTTP(S) 来源。

## 观察输入和目标形状

| 需求 | 调用或目标 | 约束 |
| --- | --- | --- |
| 查看应用 | `observe({workspace:true})` | 返回可自动化应用、当前应用和当前能力。 |
| 看控件 | `observe({view:"controls"})` | 返回 `observationId`、控件、`complete` 和每个控件的 `actions`。 |
| 看图像 | `observe({view:"image"})` 或 `"both"` | 需要宿主和会话都授权图像；Code Mode 内不可取图。 |
| 读网页正文 | `observe({read:"document"})`、`observe({read:{query:"关键词"}})` 或 `observe({read:{cursor:"..."}})` | 只对获准读取正文的浏览器开放。使用 `document.nextCursor` 续读，查询和正文受字符、块数预算限制。 |
| 精确控件 | `{role?,name?,within?,state?}` | 至少填写 `role` 或 `name`。字符串按字面匹配，`within` 可限定已授权窗口或控件范围。 |
| 控件引用 | `{ref:"..."}` | 只在产生它的 `observationId` 和授权范围内有效。切换应用、导航或刷新后应重新观察。 |
| 图像坐标 | `{point:{x,y}}` | 使用原截图的像素坐标。需要对应观察的 `observationId`、相应的截图授权和后端点证据。 |
| 已建立焦点 | `{focusFromStep:1}` | 只能引用同一批中较早且已产生焦点记录的步骤；焦点变化后重新观察。 |
| 拖拽 | `{from:point,to:point}` | 由后端是否公布 `drag` 能力决定；端点需要同一观察的点证据。 |

`observationId` 在步骤中使用 `ref`、`point` 或拖拽时是必需的。执行器会在派发前重新观察并核对作用域、控件身份、几何和前台状态；不能用旧引用绕过这些检查。

## 动作参数

下面只说明协议形状。某个会话实际接受的目标形式、按键和滚动方向，以它公布的能力项为准。

| `kind` | 参数 | 常见目标 | 说明 |
| --- | --- | --- | --- |
| `click` | `button:"left"\|"right"`、`count:1\|2` | selector、ref、point | 能力项会限制按钮和次数；右键双击是全局禁止组合。 |
| `type` | `text:string`，能力带 `foreground:true` 时可选 `delivery:"foreground"` | selector、ref、focus，部分前台后端也公布 point | 在光标或已验证的选区输入。前台路线需要本次能力明确允许，且目标精确、可写。 |
| `setValue` | `value:string` | selector、ref | 替换整个公开值，需要控件提供可写的 Value/SetValue 路径。 |
| `scroll` | `direction`、`amount`、可选 `by:"line"\|"page"` | selector、ref，部分后端支持 point | 只有控件 `actions` 包含 `scroll` 且后端公布对应方向、单位时才可用。 |
| `keypress` | `key:string` | selector、ref、focus | 键集合由能力项决定；按键通常要求当前焦点证据。 |
| `hotkey` | `keys:string[]` | selector、ref、focus | 组合键由能力项列出；不要把未公布的快捷键当作可用。 |
| `drag` | `from`、`to` 两个点 | path | 需要后端同时支持拖拽和同一观察的点证据。 |

Windows 前台表格会话只有在公布带 `foreground:true` 的 `type` 能力和 Enter 按键时，才可使用这条已验证的网格编辑路由。对精确目标单元格直接发送 `type` 并设置 `delivery:"foreground"`，随后用 `{focusFromStep:1}` 将 Enter 绑定到本批次第一个 TYPE 步骤。例如 `[{kind:"type",target:{name:"<exact cell name>"},text:"<new value>",delivery:"foreground"},{kind:"keypress",target:{focusFromStep:1},key:"Enter"}]`；目标也可以是当前 observation 的 ref。前台 type 本身会定位到单元格；这条路线上不要先单击，因为额外激活可能把光标放进旧内容。只在该宿主已验证所选单元格输入会替换内容、且目标不处于活动编辑光标中时使用。Enter 后重新读取单元格值；窗口、原单元格、选中状态和实际键盘焦点仍由后端核对。编辑器失去焦点、授权撤销或出现遮挡时，后续按键可以单独停止。已经收到 `dispatched` 的输入仍保留在逐步回执中；不得为恢复焦点而重复已派发的 `type`。跨调用操作时，用 `observe({where:{state:"focused"}})` 取得新的焦点引用再请求按键。保存后的任务验收应从磁盘读回目标值。

下例是一次滚动请求。

```json
{
  "observationId": "obs-...",
  "steps": [
    { "kind": "scroll", "target": { "ref": "ref-..." }, "direction": "down", "amount": 2, "by": "line" }
  ]
}
```

每步可以附一个只读 `expect`，例如 `{target: selector, state:"present"|State}` 或 `{target: selector, valueEquals:"..."}`。执行器派发后，用它独立读取并核对指定状态。

核验要对应实际目标。用 `state:"visible"` 可以确认控件仍可见，用 `valueEquals` 可以确认控件公开的值。需要确认 Word 或 Excel 已经保存时，由宿主在保存后独立读回文件和指定内容。

当前 Windows CUA 会话的 `type` 能力带有 `foreground:true` 时，才接受 `delivery:"foreground"`。按坐标输入需要精确授权的 PID/HWND、`allowForegroundInput` 和 `allowDesktopCapture`。对于尚未聚焦的 selector 或 ref，执行器从新鲜且完整的控件几何中找到唯一可写接收方。对于 point，执行器核对同一观察的点证据和命中的可写控件。派发前复查前台、遮挡和物理接收方。后端使用的私有几何或窗口图像留在宿主内，Code Mode 只提交参数和处理回执。输入后用公开值或保存结果核对是否提交。

已聚焦的可写文本编辑区可以直接在光标或选区输入。会话在 `type.targets` 提供 `focus` 时，可在同批先用 `hotkey` 全选文本，再用 `type` 指定 `target:{focusFromStep:1}`。派发前核对窗口和原焦点，通过后在原选区键入。对于 Excel，若焦点仍在网格，`Ctrl+A` 选中的可能是区域，修改单元格时应定位到该格。

会话已公布前台输入能力时，可以这样提交。

```json
{
  "observationId": "obs-...",
  "steps": [{
    "kind": "type",
    "target": { "ref": "ref-..." },
    "text": "Review",
    "delivery": "foreground",
    "expect": { "target": { "name": "Title" }, "valueEquals": "Review" }
  }]
}
```

`Ctrl+A` 的含义取决于实际焦点。在文本编辑器中可能选中文字，在 Excel 网格中可能选中数据区域或整张工作表。回执为 `dispatched` 表示键盘事件已投递，选择结果要用新的焦点、控件观察或应用读回来确认。[Microsoft Excel 选择单元格内容](https://support.microsoft.com/en-us/excel/get-started/select-cell-contents-in-excel)

## 后端差异

| 后端 | 能力概要 | 重要边界 |
| --- | --- | --- |
| Playwright 浏览器 | click、type、setValue、scroll、keypress、hotkey；图像授权后 click 可用 point | `authorizedOrigins` 限制页面；`allowDocumentText` 单独控制正文；浏览器控件和页面正文不是同一类证据。 |
| Windows CUA 前台 | selector/ref/point click、type、scroll，以及按授权和焦点提供 keypress/hotkey；前台还可公布 point 双击/右键 | point、前台输入和截图都需要对应授权；每次仍核对精确 PID/HWND、遮挡和新鲜物理证据。 |
| Windows CUA 后台 | selector/ref click、type、scroll（通常纵向按行） | 不使用前台截图或广泛输入；能力取决于已登记的背景驱动来源。 |
| Windows 原生 UIA | 已验证的背景路径公布 selector/ref click 和 setValue | 不把通用 CUA 的按键、点或截图能力自动带到原生 UIA。 |
| E2B 浏览器 | 与受管浏览器能力相近；`allowImages` 决定 point click 是否进入模型能力 | 页面来源由 E2B 产品授权；浏览器导航和控件动作都有独立的时间与来源检查。 |
| E2B Writer | selector/ref/point click、selector/ref/focus type、selector/ref scroll（up/down、line）、受限 hotkey | point 需要完整 AT-SPI 观察和 X11 接收方证明；降级窗口快照不会伪装成坐标证据；Writer 产品将滚动上限设为 20。 |

工作区的按需应用可能在激活前只公布静态能力。激活成功回执中的 `capabilities` 和 `actionParameters` 才是本次已打开会话的实际参数；控件级别仍以观察结果的 `actions` 为最后条件。浏览器关闭图像授权时，按需清单也会去掉 point 目标。

`drag` 仍是协议动作形状，但当前内置受管浏览器、Windows 和 E2B 产品能力表不公布它；只有宿主接入并公布 `path` 能力时才可提交。类似地，Windows 的前台、后台和原生 UIA 能力不能互相推导，必须使用本次会话实际返回的组合。

## 回执、审批和安全边界

`act` 的外层状态通常是 `completed`、`stopped` 或 `rejected`；每一步另有 `verified`、`dispatched`、`partial`、`unknown`、`not_dispatched` 等事实。`completed` 不等于每个动作都已产生可见效果，只有相应核验存在时才会标为 `verified`。

- `approval_required` 会保留当前动作和前面步骤的回执。宿主向用户展示审批卡，再用同一会话的 `resolveApproval` 恢复或拒绝。
- `partial`、`unknown`、撤销、对象变化和焦点变化都停止后续程序。远程派发结果未知时，DeskLatch 不自动重放动作。
- `expect` 只做只读核验；核验失败不会把动作事实改写成未派发。
- Code Mode 只在整批动作被确认 `not_dispatched` 且返回了新控件观察时允许一次恢复。已出现 `dispatched` 或 `unknown` 的批次不会重放。[Code Mode 说明](code-mode.md)

常用默认预算是每批最多 32 步、文本 16,384 字符、滚动 100 个单位、会话工具等待 30 秒；宿主或具体产品可以进一步收窄。以运行时返回的能力、限制和错误码为准。

协议的机器可读定义见 [act-input.schema.json](../schema/act-input.schema.json)。接入方式见 [框架集成](integrations.md)，运行时边界见 [执行架构](architecture.md)，发布包和真实验收见 [实测记录](verification.md)。
