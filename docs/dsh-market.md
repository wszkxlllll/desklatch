# DSH 插件市场

DeskLatch 的原生包名为 `desklatch-dsh`。打包产物包含 `dsh.bundle.patch`、插件入口和运行依赖，可以直接用 DSH 安装本地包。当前验证的宿主是 DSH `0.2.2-rc.5`。[预览下载](https://github.com/wszkxlllll/desklatch/releases/tag/v0.1.0-dev.0) · [本地接入](integrations.md#deepseek-harness-原生插件)

## 用户从发现页安装

DSH 在「插件」中提供「自定义插件索引」实验功能。启用后，在「发现」页添加索引地址，再搜索并安装插件。索引中的版本来自 npm 包或指定 Git 提交。DSH 确认源和版本后会调用正常的插件安装流程。[DSH 官方插件索引指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.zh.md)

## 准备市场发布

1. 确定允许公开分发的内容、许可证及包发布账号。面向所有人的索引需要公开可读的安装源。
2. 从对应版本生成 `desklatch-dsh-<version>.tgz`，核对 `dsh.bundle.patch`、兼容版本和包内容。以 npm 发布时上传这份自包含插件包；以 Git 发布时需要提供可直接安装、包含构建产物的包目录。
3. 在公开安装源可用后，用空白 DSH profile 验证按包名或 Git 提交安装。随后向社区市场提交包名和仓库链接，或按 DSH 文档生成索引，放在可直接访问的 HTTPS 地址供用户添加。[社区市场](https://cordis.run/en) · [官方索引生成器说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md#generate-an-index-with-the-reference-generator)

本版通过 GitHub 预览和可转发的 Windows ZIP 分发。市场索引面向可安装的 npm 或 Git 版本，预览 ZIP 供用户解压后运行向导。
