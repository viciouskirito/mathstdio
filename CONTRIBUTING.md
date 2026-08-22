# 贡献指南

感谢你改进 Math Studio。项目面向课堂和自主学习场景，代码变更应优先保证数学正确性、安全性、键盘可用性和移动端体验。

## 开发环境

- Node.js 20+（CI 使用 Node.js 24）
- npm（必须保留并更新 `package-lock.json`）
- Chromium、Firefox、WebKit（用于端到端测试）

```bash
npm ci
npx playwright install chromium firefox webkit
npm run dev
```

## 变更原则

- 不使用 `eval`、`new Function` 或未经白名单校验的表达式执行方式。
- 用户表达式必须通过 DOM 节点和 `textContent` 呈现；富文本必须先经过 DOMPurify。
- 不在仓库、日志、Storage、测试夹具或截图中加入真实 API Key。
- 3D 对象移除时要释放 Geometry 和 Material；非活动场景不得维持 RAF 循环。
- 新增交互必须提供可见焦点、语义化名称和键盘路径，并兼顾 390×844 视口。
- 不读取或依赖本地忽略的 `.env`、`config.js`；v3 不使用它们。

## 代码流程

1. 从最新 `main` 创建短生命周期分支。
2. 用小而明确的提交实现变更，提交信息建议遵循 Conventional Commits，例如 `fix: 修正参数范围校验`。
3. 为数学边界、安全回归和 UI 行为补充相应测试。
4. 运行完整门禁：

```bash
npm run check
```

如果视觉变化是有意的，可运行以下命令并逐张审查 `e2e/__screenshots__`：

```bash
npm run test:e2e -- --update-snapshots
```

## 测试要求

- 表达式变更：覆盖优先级、隐式乘法、白名单、复杂度和非有限结果。
- 数学变更：覆盖零值、反向范围、极端数值和已知解析结果。
- AI 变更：必须拦截 `/models` 与 `/chat/completions`，覆盖成功、恶意 Markdown、401、429、5xx 和中止/超时；不得访问真实服务。
- 界面变更：至少检查 1440×900、390×844、浅色、深色、键盘导航和 axe 扫描。
- 3D 变更：验证相机适配、WebGL 降级提示、资源释放和静置渲染计数。

## Pull Request 清单

- [ ] 变更范围清晰，没有无关文件或凭据。
- [ ] `npm run format:check`、Lint、类型检查、单测和构建通过。
- [ ] Chromium 功能/视觉测试及 Firefox、WebKit 冒烟测试通过。
- [ ] 新行为已写入 README 或相关文档。
- [ ] 安全、性能、可访问性和移动端影响已经检查。

安全漏洞不要提交公开 Issue 或 Pull Request，请使用 [SECURITY.md](./SECURITY.md) 中的私密报告渠道。
