import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  Agent,
  Model,
  OpenAIModel,
  Tool,
  type AgentContext,
  type AgentFunctionCallOutputItem,
  type AgentInputContentPart,
  type AgentInputMessage,
  type AgentOptions,
  type AgentResponseOutputItem,
  type AgentSkill,
  type ModelResponsesRequest,
  type ModelResponsesResponse,
} from '@manee/agent-framework';
import * as koffi from 'koffi';
import { PNG } from 'pngjs';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const defaultArkBaseURL = 'https://ark.cn-beijing.volces.com/api/v3';
const defaultArkModel = 'doubao-seed-2-0-pro-260215';

const artifactRoot = fileURLToPath(new URL('../.artifacts/windows', import.meta.url));

const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_CHAR = 0x0102;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONDOWN = 0x0204;
const WM_RBUTTONUP = 0x0205;
const MK_LBUTTON = 0x0001;
const MK_RBUTTON = 0x0002;
const SRCCOPY = 0x00cc0020;
const DIB_RGB_COLORS = 0;
const BI_RGB = 0;

const keyCodes: Record<string, number> = {
  alt: 0x12,
  backspace: 0x08,
  ctrl: 0x11,
  control: 0x11,
  delete: 0x2e,
  down: 0x28,
  end: 0x23,
  enter: 0x0d,
  escape: 0x1b,
  esc: 0x1b,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
  home: 0x24,
  insert: 0x2d,
  left: 0x25,
  meta: 0x5b,
  pagedown: 0x22,
  pageup: 0x21,
  right: 0x27,
  shift: 0x10,
  space: 0x20,
  tab: 0x09,
  up: 0x26,
  win: 0x5b,
};

type Rect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type BitmapInfo = {
  bmiHeader: {
    biSize: number;
    biWidth: number;
    biHeight: number;
    biPlanes: number;
    biBitCount: number;
    biCompression: number;
    biSizeImage: number;
    biXPelsPerMeter: number;
    biYPelsPerMeter: number;
    biClrUsed: number;
    biClrImportant: number;
  };
  bmiColors: number[];
};

type Win32Api = {
  EnumWindows(callback: (hwnd: bigint, lParam: bigint) => boolean, lParam: bigint): boolean;
  IsWindow(hwnd: bigint): boolean;
  IsWindowVisible(hwnd: bigint): boolean;
  IsWindowEnabled(hwnd: bigint): boolean;
  GetClassNameW(hwnd: bigint, buffer: Buffer, maxCount: number): number;
  GetWindowThreadProcessId(hwnd: bigint, processId: Buffer): number;
  GetWindowTextLengthW(hwnd: bigint): number;
  GetWindowTextW(hwnd: bigint, buffer: Buffer, maxCount: number): number;
  GetWindowRect(hwnd: bigint, rect: Rect): boolean;
  GetWindowDC(hwnd: bigint): bigint;
  ReleaseDC(hwnd: bigint, dc: bigint): number;
  PrintWindow(hwnd: bigint, dc: bigint, flags: number): boolean;
  PostMessageW(hwnd: bigint, msg: number, wParam: bigint, lParam: bigint): boolean;
  CreateCompatibleDC(dc: bigint): bigint;
  CreateCompatibleBitmap(dc: bigint, width: number, height: number): bigint;
  SelectObject(dc: bigint, object: bigint): bigint;
  BitBlt(
    destDc: bigint,
    x: number,
    y: number,
    width: number,
    height: number,
    srcDc: bigint,
    srcX: number,
    srcY: number,
    rop: number,
  ): boolean;
  GetDIBits(
    dc: bigint,
    bitmap: bigint,
    startScan: number,
    scanLines: number,
    bits: Buffer,
    bitmapInfo: BitmapInfo,
    usage: number,
  ): number;
  DeleteObject(object: bigint): boolean;
  DeleteDC(dc: bigint): boolean;
  GetLastError(): number;
};

interface WindowCapture {
  png: PNG;
  captureMethod: 'PrintWindow' | 'BitBlt';
}

interface WindowCandidate {
  hwnd: string;
  processId: number;
  processName: string;
  className: string;
  title: string;
  visible: boolean;
  enabled: boolean;
}

const imageInputParametersSchema = z.object({
  file_id: z.string().min(1).describe('Ark Files API id for an uploaded image.'),
  detail: z.enum(['auto', 'low', 'high']).optional().describe('Optional image detail hint.'),
});

const videoInputParametersSchema = z.object({
  file_id: z.string().min(1).describe('Ark Files API id for an uploaded video.'),
});

const audioInputParametersSchema = z.object({
  file_id: z.string().min(1).describe('Ark Files API id for uploaded audio.'),
});

type MultimodalKind = 'image' | 'video' | 'audio';
type ImageInputParameters = z.infer<typeof imageInputParametersSchema>;
type VideoInputParameters = z.infer<typeof videoInputParametersSchema>;
type AudioInputParameters = z.infer<typeof audioInputParametersSchema>;
type MultimodalContentPart = AgentInputContentPart;
type MultimodalToolResult = {
  id: string;
  type: MultimodalKind;
};
type CaptureWindowResult = {
  path: string;
  width: number;
  height: number;
  hwnd: string;
  title: string;
  className: string;
  captureMethod: WindowCapture['captureMethod'];
};

class DebugDumpModel extends Model {
  #inner: Model;
  #debugRoot: string;
  #requestIndex = 0;

  constructor(inner: Model, debugRoot: string) {
    super();
    this.#inner = inner;
    this.#debugRoot = debugRoot;
  }

  async responses(request: ModelResponsesRequest): Promise<ModelResponsesResponse> {
    this.#requestIndex += 1;
    const requestId = String(this.#requestIndex).padStart(3, '0');
    const requestPath = join(this.#debugRoot, `${requestId}-request.json`);
    const summaryPath = join(this.#debugRoot, `${requestId}-summary.json`);

    await mkdir(this.#debugRoot, { recursive: true });
    await writeJsonFile(requestPath, request);
    await writeJsonFile(summaryPath, summarizeModelRequest(request));

    try {
      const response = await this.#inner.responses(request);

      await writeJsonFile(join(this.#debugRoot, `${requestId}-response.json`), response);
      return response;
    } catch (error) {
      await writeJsonFile(join(this.#debugRoot, `${requestId}-error.json`), serializeError(error));
      throw error;
    }
  }
}

const weixinWindowsSkill: AgentSkill = {
  name: 'Windows 微信联系人搜索与消息发送',
  description:
    '在 Windows 微信桌面端中搜索联系人、打开聊天、输入消息、发送，并通过截图确认每个关键状态。',
  systemContent: [
    '只能使用当前 demo 暴露的 Windows 工具操作微信窗口，不要使用剪贴板。',
    '联系人名称和消息正文都必须通过 send-text 发送 WM_CHAR 文本。',
    '每次执行关键点击或文字输入后，都调用 capture-window 获取截图；截图会自动作为多模态图片进入下一轮模型请求，请基于图片判断窗口状态。',
    '不要复用旧的搜索下拉窗口 hwnd；每次输入联系人名称后都重新调用 find-window 查找下拉窗口。',
    '搜索结果下拉窗是独立顶层窗口，点击联系人结果时必须使用下拉窗口 hwnd，不能把下拉坐标换算到主窗口。',
    '发送前必须 capture-window 截取主窗口，并确认聊天标题匹配目标联系人；如果不匹配，停止并报告，不要发送。',
  ].join('\n'),
  sops: [
    {
      description: '搜索微信联系人并发送一条已准备好的消息',
      content: [
        '1. 调用 find-window 查找微信主窗口：processName="Weixin"，className="Qt51514QWindowIcon"，exactClassName=true，visibleOnly=true，enabledOnly=true，limit=10。微信标题可能乱码，不要依赖 title。',
        '2. 对主窗口调用 capture-window，检查截图是否是微信主界面。',
        '3. 点击主窗口搜索框：click-window({ hwnd: mainHwnd, x: 159, y: 55, button: "left" })。',
        '4. 若需要确认焦点，点击搜索框后用 send-text 输入 a，再 capture-window 检查 a 是否出现在搜索框；如果 a 出现在聊天输入框，用 send-keyboard-message 发送 backspace 删除后重新点击搜索框。确认后删除探测字符。',
        '5. 使用 send-text 在主窗口输入目标联系人名称。',
        '6. 重新调用 find-window 查找搜索下拉窗口：processName="Weixin"，className="Qt51514QWindowToolSaveBits"，exactClassName=true，title="Weixin"，exactTitle=true，visibleOnly=true，enabledOnly=false，limit=10。',
        '7. 对下拉窗口调用 capture-window，outputName 可包含 weixin-dropdown，printFlags=2；通过多模态截图确认下拉结果里有目标联系人。',
        '8. 通过下拉窗口 hwnd 点击联系人结果：click-window({ hwnd: dropdownHwnd, x: 122, y: 73, button: "left" })。',
        '9. 对主窗口调用 capture-window，通过多模态截图确认聊天标题是目标联系人。',
        '10. 点击聊天输入框：click-window({ hwnd: mainHwnd, x: 330, y: 563, button: "left" })。',
        '11. 使用 send-text 输入准备好的消息正文。',
        '12. 对主窗口调用 capture-window，确认消息正文已经出现在聊天输入框。',
        '13. 点击发送按钮：click-window({ hwnd: mainHwnd, x: 1215, y: 658, button: "left" })。',
        '14. 最后对主窗口调用 capture-window，确认消息气泡已经出现在聊天记录中。',
      ].join('\n'),
    },
  ],
};

class WindowsControlAgent extends Agent {
  #api: Win32Api;
  #interactiveEnabled: boolean;
  #multimodalInputs = new Map<string, MultimodalContentPart[]>();

  constructor(options: AgentOptions, api: Win32Api, interactiveEnabled: boolean) {
    super(options);
    this.#api = api;
    this.#interactiveEnabled = interactiveEnabled;
  }

  takeMultimodalInput(id: string): MultimodalContentPart[] | undefined {
    const content = this.#multimodalInputs.get(id);

    if (content) {
      this.#multimodalInputs.delete(id);
    }

    return content;
  }

  @Tool({
    name: 'find-window',
    description:
      'Find Windows top-level windows by process name, class name, title, visibility, or enabled state. Returns hwnd values as hex strings.',
    parameters: z.object({
      processName: z.string().optional().describe('Process name such as notepad or Code.'),
      className: z.string().optional().describe('Window class name such as Qt51514QWindowIcon.'),
      title: z.string().optional().describe('Substring to match in the window title.'),
      exactTitle: z
        .boolean()
        .default(false)
        .describe('Use exact title matching instead of substring matching.'),
      exactClassName: z
        .boolean()
        .default(false)
        .describe('Use exact class name matching instead of substring matching.'),
      visibleOnly: z.boolean().default(true).describe('Only return visible windows.'),
      enabledOnly: z.boolean().default(false).describe('Only return enabled windows.'),
      limit: z.number().int().positive().max(50).default(10).describe('Maximum result count.'),
    }),
  })
  async #findWindow(parameters: unknown): Promise<Record<string, unknown>> {
    const {
      processName,
      className,
      title,
      exactTitle = false,
      exactClassName = false,
      visibleOnly = true,
      enabledOnly = false,
      limit = 10,
    } = parameters as {
      processName?: string;
      className?: string;
      title?: string;
      exactTitle?: boolean;
      exactClassName?: boolean;
      visibleOnly?: boolean;
      enabledOnly?: boolean;
      limit?: number;
    };
    const candidates = await listTopLevelWindows(this.#api);
    const processQuery = processName?.trim().toLowerCase();
    const classQuery = className?.trim().toLowerCase();
    const titleQuery = title?.trim().toLowerCase();

    const matches = candidates
      .filter((candidate) => {
        const hwnd = parseHwnd(candidate.hwnd);

        if (!this.#api.IsWindow(hwnd)) {
          return false;
        }

        const processMatches =
          !processQuery || candidate.processName.toLowerCase().includes(processQuery);
        const candidateClassName = candidate.className.toLowerCase();
        const classMatches =
          !classQuery ||
          (exactClassName
            ? candidateClassName === classQuery
            : candidateClassName.includes(classQuery));
        const candidateTitle = candidate.title.toLowerCase();
        const titleMatches =
          !titleQuery ||
          (exactTitle ? candidateTitle === titleQuery : candidateTitle.includes(titleQuery));
        const visibleMatches = !visibleOnly || candidate.visible;
        const enabledMatches = !enabledOnly || candidate.enabled;

        return processMatches && classMatches && titleMatches && visibleMatches && enabledMatches;
      })
      .slice(0, Math.min(limit, 50));

    return {
      count: matches.length,
      matches,
      note:
        matches.length === 0
          ? 'No matching visible main windows were found. Try a broader title or processName.'
          : undefined,
    };
  }

  @Tool({
    name: 'capture-window',
    description:
      'Capture a target window by hwnd and save a PNG file. Returns the local PNG path and window metadata.',
    parameters: z.object({
      hwnd: z.string().describe('Window handle as a hex string, for example 0x00123456.'),
      outputName: z.string().optional().describe('Optional filename hint without extension.'),
      printFlags: z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe('Optional PrintWindow flags. Use 2 for some transient Qt windows.'),
    }),
  })
  async #captureWindow(parameters: unknown): Promise<Record<string, unknown>> {
    const {
      hwnd,
      outputName,
      printFlags = 0,
    } = parameters as { hwnd: string; outputName?: string; printFlags?: number };
    const handle = this.#requireWindow(hwnd);
    const rect = this.#getWindowRect(handle);
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;

    if (width <= 0 || height <= 0) {
      return {
        hwnd: formatHwnd(handle),
        error: `Window has an invalid capture size: ${width}x${height}.`,
      };
    }

    const title = this.#getWindowTitle(handle);
    const className = this.#getWindowClassName(handle);
    const screenshot = this.#captureWindowPixels(handle, width, height, printFlags);
    const safeName = sanitizeFileName(outputName || title || formatHwnd(handle));
    const filePath = join(artifactRoot, `${Date.now()}-${safeName}.png`);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, PNG.sync.write(screenshot.png));

    return {
      path: filePath,
      width,
      height,
      hwnd: formatHwnd(handle),
      title,
      className,
      captureMethod: screenshot.captureMethod,
    };
  }

  @Tool({
    name: 'input-image',
    description:
      'Insert an image uploaded through Ark Files as a multimodal user message for the next model turn.',
    parameters: imageInputParametersSchema,
  })
  async #inputImage(parameters: unknown): Promise<MultimodalToolResult> {
    const { file_id, detail } = parameters as ImageInputParameters;

    return this.#createMultimodalToolResult('image', {
      type: 'input_image',
      file_id,
      ...(detail ? { detail } : {}),
    });
  }

  @Tool({
    name: 'input-video',
    description:
      'Insert a video uploaded through Ark Files as a multimodal user message for the next model turn.',
    parameters: videoInputParametersSchema,
  })
  async #inputVideo(parameters: unknown): Promise<MultimodalToolResult> {
    const { file_id } = parameters as VideoInputParameters;

    return this.#createMultimodalToolResult('video', {
      type: 'input_video',
      file_id,
    });
  }

  @Tool({
    name: 'input-audio',
    description:
      'Insert audio uploaded through Ark Files as a multimodal user message for the next model turn.',
    parameters: audioInputParametersSchema,
  })
  async #inputAudio(parameters: unknown): Promise<MultimodalToolResult> {
    const { file_id } = parameters as AudioInputParameters;

    return this.#createMultimodalToolResult('audio', {
      type: 'input_audio',
      file_id,
    });
  }

  @Tool({
    name: 'send-keyboard-message',
    description:
      'Post keyboard messages to a target window hwnd. Interactive actions are disabled unless ARK_WINDOWS_DEMO_INTERACTIVE=1.',
    parameters: z.object({
      hwnd: z.string().describe('Window handle as a hex string.'),
      key: z
        .string()
        .min(1)
        .describe('Common key name such as enter, tab, f5, or a single character.'),
      modifiers: z
        .array(z.enum(['ctrl', 'shift', 'alt', 'win']))
        .default([])
        .describe('Optional modifier keys to hold while sending the key.'),
      repeat: z
        .number()
        .int()
        .positive()
        .max(20)
        .default(1)
        .describe('Number of repeated key presses.'),
    }),
  })
  #sendKeyboardMessage(parameters: unknown): Record<string, unknown> | string {
    if (!this.#interactiveEnabled) {
      return interactiveDisabledMessage();
    }

    const {
      hwnd,
      key,
      modifiers = [],
      repeat = 1,
    } = parameters as {
      hwnd: string;
      key: string;
      modifiers?: string[];
      repeat?: number;
    };
    const handle = this.#requireWindow(hwnd);
    const keyCode = resolveKeyCode(key);
    const modifierCodes = modifiers.map(resolveKeyCode);

    for (const modifierCode of modifierCodes) {
      this.#postMessage(handle, WM_KEYDOWN, BigInt(modifierCode), 1n);
    }

    for (let index = 0; index < repeat; index += 1) {
      this.#postMessage(handle, WM_KEYDOWN, BigInt(keyCode), 1n);
      this.#postMessage(handle, WM_KEYUP, BigInt(keyCode), 0xc0000001n);
    }

    for (const modifierCode of modifierCodes.reverse()) {
      this.#postMessage(handle, WM_KEYUP, BigInt(modifierCode), 0xc0000001n);
    }

    return {
      hwnd: formatHwnd(handle),
      key,
      modifiers,
      repeat,
      sent: true,
    };
  }

  @Tool({
    name: 'send-text',
    description:
      'Post WM_CHAR messages for text input to a target window hwnd. Interactive actions are disabled unless ARK_WINDOWS_DEMO_INTERACTIVE=1.',
    parameters: z.object({
      hwnd: z.string().describe('Window handle as a hex string.'),
      text: z.string().min(1).describe('Text to send through WM_CHAR messages.'),
    }),
  })
  #sendText(parameters: unknown): Record<string, unknown> | string {
    if (!this.#interactiveEnabled) {
      return interactiveDisabledMessage();
    }

    const { hwnd, text } = parameters as { hwnd: string; text: string };
    const handle = this.#requireWindow(hwnd);

    for (let index = 0; index < text.length; index += 1) {
      this.#postMessage(handle, WM_CHAR, BigInt(text.charCodeAt(index)), 0n);
    }

    return {
      hwnd: formatHwnd(handle),
      codeUnits: text.length,
      sent: true,
    };
  }

  @Tool({
    name: 'click-window',
    description:
      'Post mouse click messages to a target window hwnd. Coordinates are client-area coordinates.',
    parameters: z.object({
      hwnd: z.string().describe('Window handle as a hex string.'),
      x: z.number().int().nonnegative().describe('Client-area X coordinate.'),
      y: z.number().int().nonnegative().describe('Client-area Y coordinate.'),
      button: z.enum(['left', 'right']).default('left').describe('Mouse button.'),
      double: z.boolean().default(false).describe('Send two clicks.'),
    }),
  })
  #clickWindow(parameters: unknown): Record<string, unknown> | string {
    if (!this.#interactiveEnabled) {
      return interactiveDisabledMessage();
    }

    const {
      hwnd,
      x,
      y,
      button = 'left',
      double = false,
    } = parameters as {
      hwnd: string;
      x: number;
      y: number;
      button?: 'left' | 'right';
      double?: boolean;
    };
    const handle = this.#requireWindow(hwnd);
    const lParam = makeLParam(x, y);
    const downMessage = button === 'right' ? WM_RBUTTONDOWN : WM_LBUTTONDOWN;
    const upMessage = button === 'right' ? WM_RBUTTONUP : WM_LBUTTONUP;
    const buttonState = button === 'right' ? MK_RBUTTON : MK_LBUTTON;
    const count = double ? 2 : 1;

    for (let index = 0; index < count; index += 1) {
      this.#postMessage(handle, downMessage, BigInt(buttonState), lParam);
      this.#postMessage(handle, upMessage, 0n, lParam);
    }

    return {
      hwnd: formatHwnd(handle),
      x,
      y,
      button,
      double,
      sent: true,
    };
  }

  #requireWindow(hwnd: string): bigint {
    const handle = parseHwnd(hwnd);

    if (!this.#api.IsWindow(handle)) {
      throw new Error(`Invalid or closed window handle: ${hwnd}.`);
    }

    return handle;
  }

  #getWindowTitle(hwnd: bigint): string {
    return getWindowTitle(this.#api, hwnd);
  }

  #getWindowClassName(hwnd: bigint): string {
    return getWindowClassName(this.#api, hwnd);
  }

  #getWindowRect(hwnd: bigint): Rect {
    const rect: Rect = {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    };

    if (!this.#api.GetWindowRect(hwnd, rect)) {
      throw new Error(`GetWindowRect failed for ${formatHwnd(hwnd)}.`);
    }

    return rect;
  }

  #captureWindowPixels(
    hwnd: bigint,
    width: number,
    height: number,
    printFlags: number,
  ): WindowCapture {
    const windowDc = this.#api.GetWindowDC(hwnd);

    if (!windowDc) {
      throw new Error(`GetWindowDC failed. lastError=${this.#api.GetLastError()}`);
    }

    const memoryDc = this.#api.CreateCompatibleDC(windowDc);
    let bitmap = 0n;
    let oldObject = 0n;

    try {
      bitmap = this.#api.CreateCompatibleBitmap(windowDc, width, height);

      if (!memoryDc || !bitmap) {
        throw new Error(`CreateCompatibleBitmap failed. lastError=${this.#api.GetLastError()}`);
      }

      oldObject = this.#api.SelectObject(memoryDc, bitmap);

      const printed = this.#api.PrintWindow(hwnd, memoryDc, printFlags);
      const captured =
        printed || this.#api.BitBlt(memoryDc, 0, 0, width, height, windowDc, 0, 0, SRCCOPY);

      if (!captured) {
        throw new Error(
          `PrintWindow and BitBlt both failed. lastError=${this.#api.GetLastError()}`,
        );
      }

      const bitmapInfo = createBitmapInfo(width, height);
      const bits = Buffer.alloc(width * height * 4);
      const scanLines = this.#api.GetDIBits(
        memoryDc,
        bitmap,
        0,
        height,
        bits,
        bitmapInfo,
        DIB_RGB_COLORS,
      );

      if (scanLines === 0) {
        throw new Error(`GetDIBits failed. lastError=${this.#api.GetLastError()}`);
      }

      return {
        png: bgraToPng(bits, width, height),
        captureMethod: printed ? 'PrintWindow' : 'BitBlt',
      };
    } finally {
      if (oldObject) {
        this.#api.SelectObject(memoryDc, oldObject);
      }

      if (bitmap) {
        this.#api.DeleteObject(bitmap);
      }

      if (memoryDc) {
        this.#api.DeleteDC(memoryDc);
      }

      this.#api.ReleaseDC(hwnd, windowDc);
    }
  }

  #postMessage(hwnd: bigint, message: number, wParam: bigint, lParam: bigint): void {
    if (!this.#api.PostMessageW(hwnd, message, wParam, lParam)) {
      throw new Error(
        `PostMessageW failed. message=${message} lastError=${this.#api.GetLastError()}`,
      );
    }
  }

  #createMultimodalToolResult(
    kind: MultimodalKind,
    mediaPart: Exclude<MultimodalContentPart, { type: 'input_text' }>,
  ): MultimodalToolResult {
    const id = createMultimodalInputId();

    this.#multimodalInputs.set(id, [
      {
        type: 'input_text',
        text: `这是${getMediaKindLabel(kind)}id为${id}的内容`,
      },
      mediaPart,
    ]);

    return {
      id,
      type: kind,
    };
  }
}

if (process.platform !== 'win32') {
  console.error('The Windows control demo only runs on Windows.');
  process.exitCode = 1;
} else if (!process.env.ARK_API_KEY) {
  console.error('Missing ARK_API_KEY. Run this demo with an Ark Coding Plan API key.');
  process.exitCode = 1;
} else {
  await runWindowsDemo(process.env.ARK_API_KEY);
}

function createMultimodalInputId(): string {
  return `id${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function getMediaKindLabel(kind: MultimodalKind): string {
  if (kind === 'image') {
    return '图片';
  }

  if (kind === 'video') {
    return '视频';
  }

  return '音频';
}

function appendMultimodalToolResult(agent: WindowsControlAgent, result: unknown): void {
  if (!isMultimodalToolResult(result)) {
    return;
  }

  const content = agent.takeMultimodalInput(result.id);

  if (!content) {
    return;
  }

  agent.appendContext({
    role: 'user',
    content,
  });
}

async function appendScreenshotToolResult(
  agent: WindowsControlAgent,
  model: OpenAIModel,
  result: unknown,
): Promise<void> {
  if (!isCaptureWindowResult(result)) {
    return;
  }

  try {
    const uploaded = await model.uploadFile(result.path, { purpose: 'user_data' });
    const id = createMultimodalInputId();

    agent.appendContext({
      role: 'user',
      content: [
        {
          type: 'input_image',
          file_id: uploaded.id,
          detail: 'high',
        },
        {
          type: 'input_text',
          text: [
            `This is window screenshot id=${id}.`,
            `hwnd=${result.hwnd}`,
            `title=${result.title || '(empty)'}`,
            `className=${result.className}`,
            `path=${result.path}`,
            `size=${result.width}x${result.height}`,
          ].join('\n'),
        },
      ],
    });
  } catch (error) {
    agent.appendContext({
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: [
            `The screenshot at ${result.path} could not be uploaded for visual analysis.`,
            'The current window state has not been visually confirmed.',
            'Do not continue with any click or send action that requires visual confirmation.',
          ].join('\n'),
        },
      ],
    });

    throw error;
  }
}

function isMultimodalToolResult(result: unknown): result is MultimodalToolResult {
  if (!result || typeof result !== 'object') {
    return false;
  }

  const candidate = result as Partial<MultimodalToolResult>;

  return (
    typeof candidate.id === 'string' &&
    typeof candidate.type === 'string' &&
    (candidate.type === 'image' || candidate.type === 'video' || candidate.type === 'audio')
  );
}

function isCaptureWindowResult(result: unknown): result is CaptureWindowResult {
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

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function summarizeModelRequest(request: ModelResponsesRequest): Record<string, unknown> {
  return {
    inputCount: request.input.length,
    toolCount: request.tools.length,
    input: request.input.map((message, index) => ({
      index,
      ...summarizeRequestItem(message),
    })),
    tools: request.tools.map((tool) => tool.name),
  };
}

function summarizeRequestItem(message: AgentContext): Record<string, unknown> {
  if (isAgentInputMessage(message)) {
    return {
      type: message.type ?? 'input_message',
      role: message.role,
      content: summarizeRequestContent(message.content),
    };
  }

  if (message.type === 'message' && 'role' in message) {
    return {
      type: message.type,
      role: message.role,
      status: 'status' in message ? message.status : undefined,
    };
  }

  if (message.type === 'function_call') {
    return {
      type: message.type,
      name: 'name' in message ? message.name : undefined,
      callId: 'call_id' in message ? message.call_id : undefined,
      status: 'status' in message ? message.status : undefined,
    };
  }

  if (isFunctionCallOutputItem(message)) {
    return {
      type: message.type,
      callId: message.call_id,
      outputPreview: message.output.slice(0, 240),
    };
  }

  return {
    type: message.type,
    status: 'status' in message ? message.status : undefined,
  };
}

function isAgentInputMessage(message: AgentContext): message is AgentInputMessage {
  return (
    'role' in message &&
    (message.role === 'system' || message.role === 'developer' || message.role === 'user') &&
    'content' in message &&
    Array.isArray(message.content)
  );
}

function isFunctionCallOutputItem(message: AgentContext): message is AgentFunctionCallOutputItem {
  return (
    message.type === 'function_call_output' &&
    'call_id' in message &&
    typeof message.call_id === 'string' &&
    'output' in message &&
    typeof message.output === 'string'
  );
}

function summarizeRequestContent(content: readonly AgentInputContentPart[]): unknown {
  return content.map((part) => {
    if (part.type === 'input_text') {
      return {
        type: part.type,
        length: part.text.length,
        preview: part.text.slice(0, 240),
      };
    }

    if (part.type === 'input_image') {
      return {
        type: part.type,
        fileId: part.file_id,
        detail: part.detail,
      };
    }

    return {
      type: part.type,
      fileId: part.file_id,
    };
  });
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') {
    return {
      value: error,
    };
  }

  const record = error as Record<string, unknown>;

  return {
    name: record.name,
    message: record.message,
    status: record.status,
    code: record.code,
    type: record.type,
    param: record.param,
    requestID: record.requestID,
    error: record.error,
    stack: record.stack,
  };
}

async function runWindowsDemo(apiKey: string): Promise<void> {
  const baseURL = process.env.ARK_BASE_URL ?? defaultArkBaseURL;
  const modelName = process.env.ARK_MODEL ?? defaultArkModel;
  const api = createWin32Api();
  const interactiveEnabled = process.env.ARK_WINDOWS_DEMO_INTERACTIVE === '1';
  const recipient = process.env.ARK_WEIXIN_RECIPIENT?.trim() || '躲在月影中';
  const messageText = process.env.ARK_WEIXIN_MESSAGE?.trim() || '你好';
  const debugRoot = join(artifactRoot, 'debug', String(Date.now()));
  const llm = new OpenAIModel({
    apiKey,
    baseURL,
    model: modelName,
  });

  const agent = new WindowsControlAgent(
    {
      llm: process.env.ARK_DEBUG_DUMP === '1' ? new DebugDumpModel(llm, debugRoot) : llm,
      skills: [weixinWindowsSkill],
      maxIterations: 30,
      systemPrompts: [
        [
          'You are running a Windows Weixin control demo on the local machine.',
          'Use tools to inspect Weixin windows, save screenshots as PNG files, and reason from the injected multimodal screenshots.',
          'Every capture-window result is automatically attached as an image in the next model request. Use those images to judge search focus, dropdown results, chat title, input text, and sent message state.',
          'Do not send destructive input to important windows. This demo is only for sending the prepared Weixin message to the specified contact.',
          interactiveEnabled
            ? 'Interactive mode is enabled. You may use click-window, send-text, and send-keyboard-message only for the Weixin workflow described by the skill.'
            : 'Interactive mode is disabled. Only inspect Weixin with find-window and capture-window, then report that ARK_WINDOWS_DEMO_INTERACTIVE=1 is required to send the message.',
        ].join('\n'),
      ],
    },
    api,
    interactiveEnabled,
  );

  for (const toolName of [
    'find-window',
    'capture-window',
    'input-image',
    'input-video',
    'input-audio',
    'send-keyboard-message',
    'send-text',
    'click-window',
  ]) {
    agent.onBeforeToolCall(toolName, (_parameters, message) => {
      console.log(`tool: ${message.name} ${message.arguments}`);
    });

    agent.onAfterToolCall(toolName, (_parameters, message, result) => {
      console.log(`tool result: ${message.name} ${summarizeResult(result)}`);
    });
  }

  for (const toolName of ['input-image', 'input-video', 'input-audio']) {
    agent.onAfterToolCall(
      toolName,
      (_parameters, _message, result) => {
        appendMultimodalToolResult(agent, result);
      },
      {
        await: true,
      },
    );
  }

  agent.onAfterToolCall(
    'capture-window',
    async (_parameters, _message, result) => {
      await appendScreenshotToolResult(agent, llm, result);
    },
    {
      await: true,
    },
  );

  agent.onModelResponse((output) => {
    console.log(`model: ${summarizeOutput(output)}`);
  });

  agent.onToolCallError((name, triggerType, error) => {
    console.log(`tool error: ${name}/${triggerType}/${toErrorMessage(error)}`);
  });

  agent.onAgentError((error) => {
    console.log(`agent error: ${error.message}`);
  });

  agent.onAgentStatusChanged('running', () => {
    console.log('status: running');
  });

  agent.onAgentStatusChanged('ended', (_rawContext, context) => {
    console.log(`status: ended messages=${context.length}`);
  });

  agent.onAgentStatusChanged('failed', () => {
    console.log('status: failed');
  });

  agent.init();

  console.log(`windows demo: baseURL=${baseURL} model=${modelName}`);
  console.log(`windows demo: interactive=${interactiveEnabled ? 'enabled' : 'disabled'}`);
  console.log(`windows demo: recipient=${recipient} message=${messageText}`);
  if (process.env.ARK_DEBUG_DUMP === '1') {
    console.log(`windows demo: debug dumps=${debugRoot}`);
  }

  const task = [
    'Run the Windows Weixin multimodal messaging demo.',
    `Target Weixin contact: ${recipient}`,
    `Prepared message text: ${messageText}`,
    'First call get-skill to fetch the Weixin Windows send-message handbook, then follow it strictly.',
    'Whenever you need to judge window state, call capture-window and wait for the next model turn to inspect the injected screenshot image.',
    'Before sending, verify from a main-window screenshot that the chat title matches the target contact. If it does not match, stop and report the mismatch.',
    'After sending, capture the main window again and verify the sent message bubble appears.',
    interactiveEnabled
      ? 'Interactive actions are enabled for this Weixin workflow.'
      : 'Interactive actions are disabled, so only inspect the Weixin window and report that ARK_WINDOWS_DEMO_INTERACTIVE=1 is required before sending.',
    'Summarize the result briefly.',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  const finalContext = await agent.agent(task);

  console.log(`windows demo complete: messages=${finalContext.length}`);
}

function createWin32Api(): Win32Api {
  const rectType = koffi.struct('RECT', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long',
  });
  const bitmapInfoHeaderType = koffi.struct('BITMAPINFOHEADER', {
    biSize: 'uint32_t',
    biWidth: 'int32_t',
    biHeight: 'int32_t',
    biPlanes: 'uint16_t',
    biBitCount: 'uint16_t',
    biCompression: 'uint32_t',
    biSizeImage: 'uint32_t',
    biXPelsPerMeter: 'int32_t',
    biYPelsPerMeter: 'int32_t',
    biClrUsed: 'uint32_t',
    biClrImportant: 'uint32_t',
  });

  koffi.struct('BITMAPINFO', {
    bmiHeader: bitmapInfoHeaderType,
    bmiColors: koffi.array('uint32_t', 1),
  });
  const enumWindowsProcType = koffi.proto('__stdcall', 'EnumWindowsProc', 'bool', [
    'void *',
    'intptr_t',
  ]);

  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  return {
    EnumWindows: user32.func('__stdcall', 'EnumWindows', 'bool', [
      koffi.pointer(enumWindowsProcType),
      'intptr_t',
    ]) as Win32Api['EnumWindows'],
    IsWindow: user32.func('__stdcall', 'IsWindow', 'bool', ['void *']) as Win32Api['IsWindow'],
    IsWindowVisible: user32.func('__stdcall', 'IsWindowVisible', 'bool', [
      'void *',
    ]) as Win32Api['IsWindowVisible'],
    IsWindowEnabled: user32.func('__stdcall', 'IsWindowEnabled', 'bool', [
      'void *',
    ]) as Win32Api['IsWindowEnabled'],
    GetClassNameW: user32.func('__stdcall', 'GetClassNameW', 'int', [
      'void *',
      'void *',
      'int',
    ]) as Win32Api['GetClassNameW'],
    GetWindowThreadProcessId: user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint', [
      'void *',
      'void *',
    ]) as Win32Api['GetWindowThreadProcessId'],
    GetWindowTextLengthW: user32.func('__stdcall', 'GetWindowTextLengthW', 'int', [
      'void *',
    ]) as Win32Api['GetWindowTextLengthW'],
    GetWindowTextW: user32.func('__stdcall', 'GetWindowTextW', 'int', [
      'void *',
      'void *',
      'int',
    ]) as Win32Api['GetWindowTextW'],
    GetWindowRect: user32.func('__stdcall', 'GetWindowRect', 'bool', [
      'void *',
      koffi.out(koffi.pointer(rectType)),
    ]) as Win32Api['GetWindowRect'],
    GetWindowDC: user32.func('__stdcall', 'GetWindowDC', 'void *', [
      'void *',
    ]) as Win32Api['GetWindowDC'],
    ReleaseDC: user32.func('__stdcall', 'ReleaseDC', 'int', [
      'void *',
      'void *',
    ]) as Win32Api['ReleaseDC'],
    PrintWindow: user32.func('__stdcall', 'PrintWindow', 'bool', [
      'void *',
      'void *',
      'uint',
    ]) as Win32Api['PrintWindow'],
    PostMessageW: user32.func('__stdcall', 'PostMessageW', 'bool', [
      'void *',
      'uint',
      'uintptr_t',
      'intptr_t',
    ]) as Win32Api['PostMessageW'],
    CreateCompatibleDC: gdi32.func('__stdcall', 'CreateCompatibleDC', 'void *', [
      'void *',
    ]) as Win32Api['CreateCompatibleDC'],
    CreateCompatibleBitmap: gdi32.func('__stdcall', 'CreateCompatibleBitmap', 'void *', [
      'void *',
      'int',
      'int',
    ]) as Win32Api['CreateCompatibleBitmap'],
    SelectObject: gdi32.func('__stdcall', 'SelectObject', 'void *', [
      'void *',
      'void *',
    ]) as Win32Api['SelectObject'],
    BitBlt: gdi32.func('__stdcall', 'BitBlt', 'bool', [
      'void *',
      'int',
      'int',
      'int',
      'int',
      'void *',
      'int',
      'int',
      'uint',
    ]) as Win32Api['BitBlt'],
    GetDIBits: gdi32.func('__stdcall', 'GetDIBits', 'int', [
      'void *',
      'void *',
      'uint',
      'uint',
      'void *',
      koffi.inout(koffi.pointer('BITMAPINFO')),
      'uint',
    ]) as Win32Api['GetDIBits'],
    DeleteObject: gdi32.func('__stdcall', 'DeleteObject', 'bool', [
      'void *',
    ]) as Win32Api['DeleteObject'],
    DeleteDC: gdi32.func('__stdcall', 'DeleteDC', 'bool', ['void *']) as Win32Api['DeleteDC'],
    GetLastError: kernel32.func(
      '__stdcall',
      'GetLastError',
      'uint',
      [],
    ) as Win32Api['GetLastError'],
  };
}

async function listTopLevelWindows(api: Win32Api): Promise<WindowCandidate[]> {
  const processNames = await listProcessNameMap();
  const candidates: WindowCandidate[] = [];
  const ok = api.EnumWindows((hwnd) => {
    const title = getWindowTitle(api, hwnd);
    const className = getWindowClassName(api, hwnd);
    const processIdBuffer = Buffer.alloc(4);

    api.GetWindowThreadProcessId(hwnd, processIdBuffer);

    const processId = processIdBuffer.readUInt32LE(0);

    candidates.push({
      hwnd: formatHwnd(hwnd),
      processId,
      processName: processNames.get(processId) ?? 'unknown',
      className,
      title,
      visible: api.IsWindowVisible(hwnd),
      enabled: api.IsWindowEnabled(hwnd),
    });

    return true;
  }, 0n);

  if (!ok) {
    throw new Error(`EnumWindows failed. lastError=${api.GetLastError()}`);
  }

  return candidates;
}

async function listProcessNameMap(): Promise<Map<number, string>> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [Console]::OutputEncoding',
    'Get-Process |',
    '  ForEach-Object {',
    '    [pscustomobject]@{',
    '      processId = $_.Id',
    '      processName = $_.ProcessName',
    '    }',
    '  } | ConvertTo-Json -Depth 3',
  ].join('\n');

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  const text = stdout.trim();

  if (!text) {
    return new Map();
  }

  const value = JSON.parse(text) as unknown;
  const rows = Array.isArray(value) ? value : [value];
  const processNames = new Map<number, string>();

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }

    const record = row as Record<string, unknown>;
    const processId = Number(record.processId);
    const processName = String(record.processName ?? '').trim();

    if (Number.isInteger(processId) && processName) {
      processNames.set(processId, processName);
    }
  }

  return processNames;
}

function getWindowTitle(api: Win32Api, hwnd: bigint): string {
  const length = Math.max(0, api.GetWindowTextLengthW(hwnd));
  const buffer = Buffer.alloc((length + 1) * 2);

  api.GetWindowTextW(hwnd, buffer, length + 1);
  return buffer.toString('utf16le').replace(/\0+$/g, '').trim();
}

function getWindowClassName(api: Win32Api, hwnd: bigint): string {
  const maxCount = 512;
  const buffer = Buffer.alloc(maxCount * 2);
  const length = api.GetClassNameW(hwnd, buffer, maxCount);

  return buffer
    .subarray(0, Math.max(0, length) * 2)
    .toString('utf16le')
    .trim();
}

function parseHwnd(value: string): bigint {
  const text = value.trim();

  if (!text) {
    throw new Error('Window handle is empty.');
  }

  try {
    return text.toLowerCase().startsWith('0x') ? BigInt(text) : BigInt(text);
  } catch {
    throw new Error(`Invalid window handle: ${value}.`);
  }
}

function formatHwnd(hwnd: bigint): string {
  return `0x${hwnd.toString(16).padStart(8, '0')}`;
}

function sanitizeFileName(value: string): string {
  const sanitized = value
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '-' : char))
    .join('')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return sanitized || 'window';
}

function createBitmapInfo(width: number, height: number): BitmapInfo {
  return {
    bmiHeader: {
      biSize: koffi.sizeof('BITMAPINFOHEADER'),
      biWidth: width,
      biHeight: -height,
      biPlanes: 1,
      biBitCount: 32,
      biCompression: BI_RGB,
      biSizeImage: width * height * 4,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    },
    bmiColors: [0],
  };
}

function bgraToPng(buffer: Buffer, width: number, height: number): PNG {
  const png = new PNG({ width, height });

  for (let offset = 0; offset < buffer.length; offset += 4) {
    png.data[offset] = buffer[offset + 2] ?? 0;
    png.data[offset + 1] = buffer[offset + 1] ?? 0;
    png.data[offset + 2] = buffer[offset] ?? 0;
    png.data[offset + 3] = buffer[offset + 3] === 0 ? 255 : (buffer[offset + 3] ?? 255);
  }

  return png;
}

function resolveKeyCode(key: string): number {
  const normalized = key.trim();
  const lower = normalized.toLowerCase();
  const mapped = keyCodes[lower];

  if (mapped !== undefined) {
    return mapped;
  }

  if (/^[a-z]$/i.test(normalized)) {
    return normalized.toUpperCase().charCodeAt(0);
  }

  if (/^[0-9]$/.test(normalized)) {
    return normalized.charCodeAt(0);
  }

  throw new Error(`Unsupported key: ${key}.`);
}

function makeLParam(x: number, y: number): bigint {
  return BigInt(((y & 0xffff) << 16) | (x & 0xffff));
}

function interactiveDisabledMessage(): string {
  return 'Interactive Windows actions are disabled. Set ARK_WINDOWS_DEMO_INTERACTIVE=1 to allow keyboard, text, or mouse tools.';
}

function summarizeOutput(output: readonly AgentResponseOutputItem[]): string {
  return output
    .map((item) => {
      if (item.type === 'function_call' && 'name' in item) {
        return `function_call:${String(item.name)}`;
      }

      if (item.type === 'message' && 'role' in item) {
        return `message:${String(item.role)}`;
      }

      return item.type;
    })
    .join(', ');
}

function summarizeResult(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result);

  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
