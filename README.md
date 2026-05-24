# @manee/agent-framework workspace

这是 `@manee/agent-framework` 的开发工作区。核心包位于 `packages/core`，提供协议无关的 `Agent<P>`、`Model<P>` 抽象，以及 OpenAI-compatible Chat / Responses 适配器；`demo` 工作区用于离线、方舟、Windows 和业务场景验证。

## 结构

```text
.
|-- packages/core/       # npm 包源码、README、Vite library build 配置
|-- demo/                # mock、方舟、Windows、金融新闻等验证场景
|-- package.json         # workspace 脚本
`-- pnpm-workspace.yaml
```

## 环境要求

- Node.js >= 22
- pnpm 11.x
- TypeScript + Vite
- `@Tool(...)` 使用 2023-11 decorators，由 Vite + Babel 插件转换

## 常用命令

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm format
pnpm format:check
pnpm demo
pnpm demo:chat
```

真实方舟示例需要通过环境变量提供 key：

```powershell
$env:ARK_API_KEY="your-ark-api-key"
pnpm demo:ark:smoke
pnpm demo:ark
pnpm demo:ark:subagent
```

Windows 视觉/微信流程示例默认只观察窗口。需要真实点击、输入和发送时，必须显式启用交互开关：

```powershell
$env:ARK_API_KEY="your-ark-api-key"
$env:ARK_WINDOWS_DEMO_INTERACTIVE="1"
pnpm demo:windows
pnpm demo:windows:chat
```

## Demo 分类

- `demo/src/main.ts`：离线 Responses mock，覆盖工具、技能、事件、子代理、并发保护和上下文保真。
- `demo/src/chat.ts`：离线 Chat mock，覆盖新版 `tool_calls[] -> tool` 工具闭环。
- `demo/src/ark-glm.ts`、`demo/src/complex.ts`、`demo/src/ark-subagent.ts`：真实方舟 smoke、完整功能和子代理验证。
- `demo/src/windows.ts`、`demo/src/windows-responses.ts`、`demo/src/windows-chat.ts`：Windows 窗口工具、截图视觉注入和微信 skill 流程。
- `demo/src/finance-news.ts`、`demo/src/finance-news-smoke.ts`：金融新闻 RSS 工具链和离线 fixture 回归。

## 文档与注释

发布包使用文档位于 [packages/core/README.md](./packages/core/README.md)。`packages/core/src` 的公开 API 使用中文 TSDoc，构建后的 `.d.ts` 会携带这些说明，方便 npm 包使用方在 IDE 中查看。
