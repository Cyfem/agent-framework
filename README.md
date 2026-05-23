# @manee/agent-framework workspace

这是面向 Node.js 的 AI Agent 框架工作区。核心 npm 包为 `@manee/agent-framework`，模型接口使用 Responses API；`demo` 工作区用于本地和真实方舟集成验证。

## 结构

```text
.
|-- packages/core/       # Agent、Tool、Model、OpenAIModel 与公开类型
|-- demo/                # mock、方舟、Windows 和金融新闻示例
|-- package.json
`-- pnpm-workspace.yaml
```

## 环境

- Node.js >= 22
- pnpm 11.x
- TypeScript 与 Vite
- `@Tool(...)` 使用 2023-11 decorators，由 Vite + Babel 插件构建

## 命令

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm demo
```

运行方舟 Responses API 示例：

```powershell
$env:ARK_API_KEY="your-ark-api-key"
pnpm demo:ark:smoke
pnpm demo:ark
```

运行 Windows 截图视觉/微信流程示例：

```powershell
$env:ARK_API_KEY="your-ark-api-key"
$env:ARK_WINDOWS_DEMO_INTERACTIVE="1"
pnpm demo:windows
```

Windows demo 默认连接方舟 `api/coding/v3` 接口和 `doubao-seed-2-0-pro-260215`，截图会通过 Files API 上传并以 `input_image.file_id` 进入后续 Responses input，不会把 base64 图像塞入工具结果。

## 示例

- `demo/src/main.ts`：离线 mock model，覆盖工具、技能、子代理、事件和并发保护。
- `demo/src/ark-glm.ts`：方舟最小 smoke。
- `demo/src/complex.ts`：方舟完整功能场景。
- `demo/src/windows.ts`：Windows 窗口工具、截图上传与视觉输入。
- `demo/src/finance-news-smoke.ts`：离线新闻工具链回归。

发布包用户文档位于 [packages/core/README.md](./packages/core/README.md)。

## 注释与声明

`packages/core/src` 的公开 API 使用中文 TSDoc，构建出的类型声明会携带这些说明；`demo/src` 中的模块级注释用于说明各验证场景的数据流和安全边界。
