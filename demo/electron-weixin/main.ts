import { app, BrowserWindow, ipcMain, safeStorage, type WebContents } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { getElectronWeixinArtifactRoot, runElectronWeixinTask } from './agent-runner';
import {
  DEFAULT_CHAT_BASE_URL,
  DEFAULT_CHAT_MODEL,
  DEFAULT_SCREENSHOT_PUBLIC_BASE_URL,
  IPC_CANCEL_WEIXIN_TASK,
  IPC_LOAD_CONFIG,
  IPC_RUNNER_EVENT,
  IPC_SAVE_CONFIG,
  IPC_START_WEIXIN_TASK,
  type ElectronWeixinConfig,
  type ElectronWeixinRunRequest,
  type ElectronWeixinSendTask,
  type LoadConfigResult,
  type RunnerEvent,
  type SaveConfigResult,
  type StartRunResult,
} from './shared';

interface ActiveRun {
  canceled: boolean;
}

interface StoredElectronWeixinConfig {
  version: 1;
  baseURL: string;
  model: string;
  maxIterations: number;
  interactiveEnabled: boolean;
  encryptedApiKey?: string;
}

let mainWindow: BrowserWindow | undefined;
let activeRun: ActiveRun | undefined;
let staticServer: ChildProcessWithoutNullStreams | undefined;

const staticServerPort = 2345;
const configFileName = 'electron-weixin-config.json';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: 'Agent Framework - 微信 Chat 控制台',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));

  if (process.env.ELECTRON_WEIXIN_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function emit(webContents: WebContents, event: RunnerEvent): void {
  if (!webContents.isDestroyed()) {
    webContents.send(IPC_RUNNER_EVENT, event);
  }
}

function now(): string {
  return new Date().toISOString();
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateSendTask(
  task: ElectronWeixinSendTask,
): { ok: true; task: ElectronWeixinSendTask } | { ok: false; error: string } {
  const recipient = task.recipient.trim();

  if (!recipient) {
    return { ok: false, error: '请填写联系人名称。' };
  }

  if (!task.message.trim()) {
    return { ok: false, error: '请填写消息内容。' };
  }

  return {
    ok: true,
    task: {
      recipient,
      message: task.message,
    },
  };
}

ipcMain.handle(IPC_LOAD_CONFIG, async (): Promise<LoadConfigResult> => {
  try {
    return await loadStoredConfig();
  } catch (error) {
    return {
      ok: false,
      error: `读取本地配置失败：${normalizeError(error)}`,
    };
  }
});

ipcMain.handle(
  IPC_SAVE_CONFIG,
  async (_event, config: ElectronWeixinConfig): Promise<SaveConfigResult> => {
    try {
      return await saveStoredConfig(config);
    } catch (error) {
      return {
        ok: false,
        error: `保存本地配置失败：${normalizeError(error)}`,
      };
    }
  },
);

ipcMain.handle(
  IPC_START_WEIXIN_TASK,
  (event, request: ElectronWeixinRunRequest): StartRunResult => {
    if (activeRun) {
      return {
        ok: false,
        error: '当前已有一个微信 Agent 任务正在运行。',
      };
    }

    if (process.platform !== 'win32') {
      return {
        ok: false,
        error: '该 Electron demo 只支持 Windows 平台。',
      };
    }

    if (!request.config.apiKey.trim()) {
      return {
        ok: false,
        error: '请先填写 API key。',
      };
    }

    const taskValidation = validateSendTask(request.task);

    if (!taskValidation.ok) {
      return taskValidation;
    }

    const validatedRequest: ElectronWeixinRunRequest = {
      ...request,
      task: taskValidation.task,
    };
    const run: ActiveRun = { canceled: false };
    activeRun = run;

    emit(event.sender, {
      type: 'status',
      status: 'running',
      message: 'Agent 任务已启动。',
      at: now(),
    });

    void runElectronWeixinTask({
      request: validatedRequest,
      isCanceled: () => run.canceled,
      onEvent: (runnerEvent) => {
        emit(event.sender, runnerEvent);
      },
    })
      .then((result) => {
        emit(event.sender, {
          type: 'done',
          messageCount: result.messageCount,
          canceled: result.canceled,
          at: now(),
        });
      })
      .catch((error: unknown) => {
        emit(event.sender, {
          type: 'error',
          message: normalizeError(error),
          at: now(),
        });
      })
      .finally(() => {
        if (activeRun === run) {
          activeRun = undefined;
        }
      });

    return { ok: true };
  },
);

ipcMain.handle(IPC_CANCEL_WEIXIN_TASK, (): StartRunResult => {
  if (!activeRun) {
    return {
      ok: false,
      error: '当前没有正在运行的任务。',
    };
  }

  activeRun.canceled = true;

  mainWindow?.webContents.send(IPC_RUNNER_EVENT, {
    type: 'status',
    status: 'canceled',
    message: '已请求取消。当前版本会尽量阻止后续工具动作，但不会强行中断正在进行的模型请求。',
    at: now(),
  } satisfies RunnerEvent);

  return { ok: true };
});

app.whenReady().then(() => {
  void ensureStaticServer()
    .catch((error: unknown) => ({
      ok: false,
      message: `截图静态服务启动失败：${normalizeError(error)}`,
    }))
    .then((serverState) => {
      createWindow();
      mainWindow?.webContents.once('did-finish-load', () => {
        mainWindow?.webContents.send(IPC_RUNNER_EVENT, {
          type: 'log',
          level: serverState.ok ? 'info' : 'error',
          message: serverState.message,
          at: now(),
        } satisfies RunnerEvent);
      });
    });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  staticServer?.kill();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

async function ensureStaticServer(): Promise<{ ok: boolean; message: string }> {
  const artifactRoot = getElectronWeixinArtifactRoot();

  mkdirSync(artifactRoot, { recursive: true });

  if (await isPortListening(staticServerPort)) {
    return {
      ok: true,
      message: `2345 端口已有静态资源服务，截图目录：${artifactRoot}，公网地址前缀：${DEFAULT_SCREENSHOT_PUBLIC_BASE_URL}/`,
    };
  }

  const command = resolveServeCommand();

  staticServer = spawn(
    command.file,
    [...command.args, artifactRoot, '-l', String(staticServerPort), '--no-clipboard'],
    {
      cwd: process.cwd(),
      windowsHide: true,
    },
  );

  staticServer.stdout.on('data', (chunk: Buffer) => {
    void chunk;
  });
  staticServer.stderr.on('data', (chunk: Buffer) => {
    void chunk;
  });

  await waitForPort(staticServerPort, 10_000);

  return {
    ok: true,
    message: `已用 serve 启动截图静态服务：${artifactRoot} -> http://127.0.0.1:${staticServerPort}/，公网地址前缀：${DEFAULT_SCREENSHOT_PUBLIC_BASE_URL}/`,
  };
}

async function loadStoredConfig(): Promise<LoadConfigResult> {
  let raw: string;

  try {
    raw = await readFile(getConfigFilePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true };
    }

    throw error;
  }

  const stored = JSON.parse(raw) as Partial<StoredElectronWeixinConfig>;
  let apiKey = '';
  let warning: string | undefined;

  if (typeof stored.encryptedApiKey === 'string' && stored.encryptedApiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        apiKey = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'));
      } catch (error) {
        warning = `已读取配置，但 API key 解密失败：${normalizeError(error)}`;
      }
    } else {
      warning = '已读取配置，但当前系统安全存储不可用，无法恢复 API key。';
    }
  }

  return {
    ok: true,
    config: {
      apiKey,
      baseURL:
        typeof stored.baseURL === 'string' && stored.baseURL.trim()
          ? stored.baseURL
          : DEFAULT_CHAT_BASE_URL,
      model:
        typeof stored.model === 'string' && stored.model.trim() ? stored.model : DEFAULT_CHAT_MODEL,
      maxIterations:
        Number.isInteger(stored.maxIterations) && (stored.maxIterations ?? 0) > 0
          ? (stored.maxIterations as number)
          : 30,
      interactiveEnabled: stored.interactiveEnabled === true,
    },
    ...(warning ? { warning } : {}),
  };
}

async function saveStoredConfig(config: ElectronWeixinConfig): Promise<SaveConfigResult> {
  const apiKey = config.apiKey.trim();
  let encryptedApiKey: string | undefined;
  let warning: string | undefined;

  if (apiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
    } else {
      warning = '系统安全存储不可用，已保存常规配置，但没有保存 API key。';
    }
  }

  const stored: StoredElectronWeixinConfig = {
    version: 1,
    baseURL: config.baseURL.trim() || DEFAULT_CHAT_BASE_URL,
    model: config.model.trim() || DEFAULT_CHAT_MODEL,
    maxIterations:
      Number.isInteger(config.maxIterations) && config.maxIterations > 0
        ? config.maxIterations
        : 30,
    interactiveEnabled: config.interactiveEnabled,
    ...(encryptedApiKey ? { encryptedApiKey } : {}),
  };
  const configPath = getConfigFilePath();
  const temporaryPath = `${configPath}.tmp`;

  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, configPath);

  return {
    ok: true,
    ...(warning ? { warning } : {}),
  };
}

function getConfigFilePath(): string {
  return join(app.getPath('userData'), configFileName);
}

function resolveServeCommand(): { file: string; args: string[] } {
  const localServe =
    process.platform === 'win32'
      ? join(process.cwd(), 'node_modules', '.bin', 'serve.cmd')
      : join(process.cwd(), 'node_modules', '.bin', 'serve');

  if (existsSync(localServe)) {
    return {
      file: localServe,
      args: [],
    };
  }

  return {
    file: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['--yes', 'serve'],
  };
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: '127.0.0.1', port });

    socket.once('connect', () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.once('error', () => {
      resolvePort(false);
    });
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolvePort(false);
    });
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortListening(port)) {
      return;
    }

    await new Promise((resolveWait) => {
      setTimeout(resolveWait, 250);
    });
  }

  throw new Error(`serve 未能在 ${timeoutMs}ms 内监听 ${port} 端口。`);
}
