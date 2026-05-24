import { contextBridge, ipcRenderer } from 'electron';

import {
  type ElectronWeixinApi,
  type ElectronWeixinConfig,
  type ElectronWeixinRunRequest,
  type LoadConfigResult,
  type RunnerEvent,
  type SaveConfigResult,
  type StartRunResult,
} from './shared';

const ipcStartWeixinTask = 'electron-weixin:start-task';
const ipcCancelWeixinTask = 'electron-weixin:cancel-task';
const ipcRunnerEvent = 'electron-weixin:runner-event';
const ipcLoadConfig = 'electron-weixin:load-config';
const ipcSaveConfig = 'electron-weixin:save-config';

const api: ElectronWeixinApi = {
  platform: process.platform,
  loadConfig() {
    return ipcRenderer.invoke(ipcLoadConfig) as Promise<LoadConfigResult>;
  },
  saveConfig(config: ElectronWeixinConfig) {
    return ipcRenderer.invoke(ipcSaveConfig, config) as Promise<SaveConfigResult>;
  },
  startTask(request: ElectronWeixinRunRequest) {
    return ipcRenderer.invoke(ipcStartWeixinTask, request) as Promise<StartRunResult>;
  },
  cancelTask() {
    return ipcRenderer.invoke(ipcCancelWeixinTask) as Promise<StartRunResult>;
  },
  onRunnerEvent(callback: (event: RunnerEvent) => void) {
    const listener = (_event: Electron.IpcRendererEvent, runnerEvent: RunnerEvent): void => {
      callback(runnerEvent);
    };

    ipcRenderer.on(ipcRunnerEvent, listener);

    return () => {
      ipcRenderer.off(ipcRunnerEvent, listener);
    };
  },
};

contextBridge.exposeInMainWorld('electronWeixin', api);
