# 参与贡献 ISLES Browser

感谢你参与 ISLES Browser。请保持改动聚焦，说明用户可见的效果，并避免将不相关的重构与功能或修复混在同一个 Pull Request 中。

## 提交 Issue 前

请先搜索已有 Issue。一份有帮助的问题报告应包含：

- ISLES Browser 版本、操作系统和 CPU 架构
- 清晰的复现步骤
- 预期行为和实际行为
- 经过脱敏处理的日志或截图（如有必要）

请勿提交 API Token、浏览器调试地址、配置文件目录、Cookie、密码、助记词或其他私密数据。

## 本地环境

ISLES Browser 需要 Node.js 18 或更高版本、npm 9 或更高版本，以及本机安装的 Chrome 或 Chromium。

```bash
npm install
npm run watch:mac
```

提交 Pull Request 前，请运行与改动相关的检查：

```bash
npm run typecheck
npm test
npm run build
```

使用 `npm run lint` 运行代码检查；需要格式化时使用 `npm run format`。

## Pull Request 要求

- 从当前默认分支创建分支。
- 标题应简洁描述改动结果，而不是实现细节。
- 改变行为时应提供相应测试。
- 改变公开设置、操作流程或本地 API 时应更新文档。
- 保持与 `package.json` 中声明的 Node.js 和 Electron 版本兼容。

涉及配置文件、代理、本地 API 鉴权、原生输入或云端同步的修改需要格外谨慎。请使用可丢弃的本地测试数据验证，不要提交任何私有配置文件数据。

## 代码风格

项目使用 TypeScript、Electron、React、ESLint 和 Prettier。请遵循附近代码的既有模式，在模块边界保留明确的类型，并且不要在没有明确必要性的情况下新增依赖。
