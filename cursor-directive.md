# ISLES Browser 开发说明

## 项目结构

ISLES Browser 是一个 Electron 应用，主要由三个包组成：

- `packages/main`：应用生命周期、浏览器进程管理、持久化和本地 API
- `packages/preload`：主进程和渲染进程之间的类型化桥接层
- `packages/renderer`：React 用户界面

请保持进程边界明确。渲染进程应通过预加载桥接层调用能力，不应直接导入 Node.js 或 Electron 主进程 API。

## 开发约定

- 使用 TypeScript，并遵循相邻模块的实现模式。
- 保持主进程 IPC 处理函数简洁，并验证其输入。
- 配置文件路径、API Token、Cookie、代理凭据、浏览器调试地址和云端访问数据均属于敏感信息。
- 不要记录或提交私有浏览器数据。
- 修改设置、操作流程或公开本地 API 行为时，请同步更新面向用户的文档。

## 验证

根据改动范围选择检查命令：

```bash
npm run typecheck:main
npm run typecheck:preload
npm run typecheck:renderer
npm test
```

发布相关改动前请运行 `npm run build`。涉及真实浏览器窗口、代理或本地 API 连接的改动，请使用可丢弃的测试配置文件，并避免产生外部副作用。
