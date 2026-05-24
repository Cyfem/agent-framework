export const DEFAULT_CHAT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
export const DEFAULT_CHAT_MODEL = 'glm-5.1';
export const DEFAULT_SCREENSHOT_PUBLIC_BASE_URL = 'https://weixin-agent.maneerui.com';

export const IPC_START_WEIXIN_TASK = 'electron-weixin:start-task';
export const IPC_CANCEL_WEIXIN_TASK = 'electron-weixin:cancel-task';
export const IPC_RUNNER_EVENT = 'electron-weixin:runner-event';
export const IPC_LOAD_CONFIG = 'electron-weixin:load-config';
export const IPC_SAVE_CONFIG = 'electron-weixin:save-config';

export interface ElectronWeixinConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  maxIterations: number;
  interactiveEnabled: boolean;
}

export interface ElectronWeixinSendTask {
  recipient: string;
  message: string;
}

export interface ElectronWeixinRunRequest {
  config: ElectronWeixinConfig;
  task: ElectronWeixinSendTask;
}

export type RunnerEvent =
  | {
      type: 'status';
      status: 'idle' | 'running' | 'ended' | 'failed' | 'canceled';
      message: string;
      at: string;
    }
  | {
      type: 'log';
      level: 'info' | 'warn' | 'error';
      message: string;
      at: string;
    }
  | {
      type: 'model';
      summary: string;
      at: string;
    }
  | {
      type: 'tool-call';
      name: string;
      argumentsPreview: string;
      at: string;
    }
  | {
      type: 'tool-result';
      name: string;
      resultPreview: string;
      at: string;
    }
  | {
      type: 'tool-error';
      name: string;
      triggerType: string;
      message: string;
      at: string;
    }
  | {
      type: 'screenshot';
      path: string;
      hwnd: string;
      title: string;
      className: string;
      width: number;
      height: number;
      dataUrl: string;
      remoteImageUrl: string;
      at: string;
    }
  | {
      type: 'done';
      messageCount: number;
      canceled: boolean;
      at: string;
    }
  | {
      type: 'error';
      message: string;
      at: string;
    };

export type StartRunResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };

export type LoadConfigResult =
  | {
      ok: true;
      config?: ElectronWeixinConfig;
      warning?: string;
    }
  | {
      ok: false;
      error: string;
    };

export type SaveConfigResult =
  | {
      ok: true;
      warning?: string;
    }
  | {
      ok: false;
      error: string;
    };

export interface ElectronWeixinApi {
  platform: NodeJS.Platform;
  loadConfig(): Promise<LoadConfigResult>;
  saveConfig(config: ElectronWeixinConfig): Promise<SaveConfigResult>;
  startTask(request: ElectronWeixinRunRequest): Promise<StartRunResult>;
  cancelTask(): Promise<StartRunResult>;
  onRunnerEvent(callback: (event: RunnerEvent) => void): () => void;
}
