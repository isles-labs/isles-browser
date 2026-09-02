# ISLES Browser 本地自动化 SDK

此目录包含 JavaScript SDK 源码，用于让 Puppeteer 或 Playwright 项目连接到由 ISLES Browser 本地 API 打开的配置文件。SDK 以源码形式随本仓库提供，目前尚未以 ISLES Browser 名义发布到 npm。

## 本地使用

从本仓库检出的目录安装 SDK，并在你的项目中使用合适的本地包名：

```bash
npm install /absolute/path/to/ISLES-Browser/packages/sdk
```

SDK 会通过本地 API 打开选定的 ISLES Browser 配置文件，将传入的 Puppeteer 或 Playwright 驱动连接到对应的调试地址，并返回浏览器和页面对象。它还提供可选的鼠标、键盘和滚轮节奏控制封装。

集成前请先阅读 `index.d.ts` 中的当前导出类型。为了兼容已有的本地使用者，源码导出名称保持稳定；公开文档则统一使用 ISLES Browser 品牌。

## 配置

本地 API 默认地址为 `http://127.0.0.1:49156`。请从 ISLES Browser 的 API 页面复制当前 Token，并通过本地环境变量传入。API 只接受来自回环地址的请求。

`humanize` 选项用于启用 SDK 的可选输入封装。这些封装通过 Puppeteer 或 Playwright 的页面 API 工作，不会接管系统鼠标指针。

请勿提交本地 API Token、关联私有数据的配置文件 ID 或浏览器调试地址。
