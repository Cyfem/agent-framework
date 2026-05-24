/**
 * Windows Chat Completions 视觉 demo：复用 Windows 工具宿主的 Win32 handler，
 * 将截图以内联 `image_url` data URL 追加进 Chat 上下文，验证另一种模型协议。
 *
 * 交互动作仍由 `ARK_WINDOWS_DEMO_INTERACTIVE=1` 显式解锁；默认仅允许观察。
 */
import { readFile } from 'node:fs/promises';

import {
  Agent,
  OpenAIChatModel,
  OpenAIResponsesModel,
  type OpenAIChatContext,
  type OpenAIChatProtocol,
} from '@manee/agent-framework';

import {
  WindowsControlAgent,
  createWin32Api,
  weixinWindowsSkill,
  type CaptureWindowResult,
} from './windows';

const defaultArkBaseURL = 'https://ark.cn-beijing.volces.com/api/v3';
const defaultArkModel = 'doubao-seed-2-0-pro-260215';
const sharedWindowsToolNames = new Set([
  'find-window',
  'capture-window',
  'send-keyboard-message',
  'send-text',
  'click-window',
]);

/** Chat 协议代理只组合工具，底层窗口 handler 由共享的 Windows 工具宿主提供。 */
class WindowsChatControlAgent extends Agent<OpenAIChatProtocol> {}

const apiKey = process.env.ARK_API_KEY;

if (process.platform !== 'win32') {
  console.error('The Windows Chat control demo only runs on Windows.');
  process.exitCode = 1;
} else if (!apiKey) {
  console.error('Missing ARK_API_KEY. Run this demo with an Ark Coding Plan API key.');
  process.exitCode = 1;
} else {
  await runWindowsChatDemo(apiKey);
}

async function runWindowsChatDemo(apiKey: string): Promise<void> {
  // Chat 版本复用同一套 Win32 handler，但截图以 data URL 形式进入 Chat user message。
  const baseURL = process.env.ARK_BASE_URL ?? defaultArkBaseURL;
  const modelName = process.env.ARK_MODEL ?? defaultArkModel;
  const interactiveEnabled = process.env.ARK_WINDOWS_DEMO_INTERACTIVE === '1';
  const recipient = process.env.ARK_WEIXIN_RECIPIENT?.trim() || '躲在月影中';
  const messageText = process.env.ARK_WEIXIN_MESSAGE?.trim() || '你好';
  const api = createWin32Api();
  const chatModel = new OpenAIChatModel({
    apiKey,
    baseURL,
    model: modelName,
  });

  // 该宿主仅提供已绑定的 Win32 handler，不会请求 Responses 接口。
  const toolHost = new WindowsControlAgent(
    {
      llm: new OpenAIResponsesModel({
        apiKey,
        baseURL,
        model: modelName,
      }),
    },
    api,
    interactiveEnabled,
  );
  const agent = new WindowsChatControlAgent({
    llm: chatModel,
    skills: [weixinWindowsSkill],
    maxIterations: 30,
    systemPrompts: [
      [
        'You are running a Windows Weixin control demo on the local machine.',
        'Use the available tools to inspect Weixin windows and reason from screenshots attached as Chat image_url content.',
        'Every capture-window result is automatically appended as a visual user message in the next model request.',
        'Do not send destructive input to important windows. Only handle the prepared Weixin workflow.',
        interactiveEnabled
          ? 'Interactive mode is enabled for the Weixin workflow described by the skill.'
          : 'Interactive mode is disabled. Only inspect windows and report that ARK_WINDOWS_DEMO_INTERACTIVE=1 is required to send.',
      ].join('\n'),
    ],
  });

  for (const tool of toolHost.tools) {
    if (sharedWindowsToolNames.has(tool.name)) {
      agent.tools.push(tool);
    }
  }

  for (const toolName of sharedWindowsToolNames) {
    agent.onBeforeToolCall(toolName, (_parameters, message) => {
      console.log(`tool: ${message.name} ${message.arguments}`);
    });
    agent.onAfterToolCall(toolName, (_parameters, message, result) => {
      console.log(`tool result: ${message.name} ${summarizeResult(result)}`);
    });
  }

  agent.onAfterToolCall(
    'capture-window',
    async (_parameters, _message, result) => {
      if (!isCaptureWindowResult(result)) {
        return;
      }

      try {
        const base64 = (await readFile(result.path)).toString('base64');

        agent.appendContext(
          chatModel.buildUserMessage({
            content: [
              {
                type: 'text',
                text: [
                  'This is the latest captured window screenshot.',
                  `hwnd=${result.hwnd}`,
                  `title=${result.title || '(empty)'}`,
                  `className=${result.className}`,
                  `path=${result.path}`,
                  `size=${result.width}x${result.height}`,
                ].join('\n'),
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${base64}`,
                  detail: 'high',
                },
              },
            ],
          }),
        );
      } catch (error) {
        agent.appendContext(
          chatModel.buildUserMessage({
            content: [
              {
                type: 'text',
                text: [
                  `The screenshot at ${result.path} could not be loaded for visual analysis.`,
                  'The current window state has not been visually confirmed.',
                  'Do not continue with any click or send action that requires visual confirmation.',
                ].join('\n'),
              },
            ],
          }),
        );

        throw error;
      }
    },
    { await: true },
  );

  agent.onModelResponse((messages) => {
    console.log(`model: ${summarizeOutput(messages)}`);
  });
  agent.onToolCallError((name, triggerType, error) => {
    console.log(`tool error: ${name}/${triggerType}/${toErrorMessage(error)}`);
  });
  agent.onAgentError((error) => {
    console.log(`agent error: ${error.message}`);
  });

  agent.init();

  console.log(`windows chat demo: baseURL=${baseURL} model=${modelName}`);
  console.log(`windows chat demo: interactive=${interactiveEnabled ? 'enabled' : 'disabled'}`);
  console.log(`windows chat demo: recipient=${recipient} message=${messageText}`);

  const finalContext = await agent.agent(
    [
      'Run the Windows Weixin multimodal messaging demo.',
      `Target Weixin contact: ${recipient}`,
      `Prepared message text: ${messageText}`,
      'First call get-skill to fetch the Weixin Windows send-message handbook, then follow it strictly.',
      'When visual confirmation is needed, call capture-window and inspect the image in the next turn.',
      interactiveEnabled
        ? 'Interactive actions are enabled for this Weixin workflow.'
        : 'Interactive actions are disabled, so only inspect and report the required opt-in.',
    ].join('\n'),
  );

  console.log(`windows chat demo complete: messages=${finalContext.length}`);
}

function isCaptureWindowResult(result: unknown): result is CaptureWindowResult {
  // after hook 接收 unknown 工具结果，先做最小结构判断再读取截图路径。
  if (!result || typeof result !== 'object') {
    return false;
  }

  const candidate = result as Partial<CaptureWindowResult>;

  return (
    typeof candidate.path === 'string' &&
    typeof candidate.hwnd === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.className === 'string' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number'
  );
}

function summarizeOutput(output: readonly OpenAIChatContext[]): string {
  // 日志只展示消息类型和工具名，避免把图片 data URL 输出到终端。
  return output
    .map((message) => {
      if (message.role === 'assistant' && message.tool_calls?.length) {
        return message.tool_calls
          .flatMap((call) => (call.type === 'function' ? [`tool_call:${call.function.name}`] : []))
          .join(', ');
      }

      return `message:${message.role}`;
    })
    .join(', ');
}

function summarizeResult(result: unknown): string {
  // 工具结果可能是对象，统一压缩成短文本便于观察流程。
  const text = typeof result === 'string' ? result : JSON.stringify(result);

  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

function toErrorMessage(error: unknown): string {
  // 事件回调拿到 unknown error，终端日志统一转成可读字符串。
  return error instanceof Error ? error.message : String(error);
}
