import './styles.css';

import {
  DEFAULT_CHAT_BASE_URL,
  DEFAULT_CHAT_MODEL,
  type ElectronWeixinApi,
  type ElectronWeixinConfig,
  type ElectronWeixinRunRequest,
  type RunnerEvent,
} from '../shared';

declare global {
  interface Window {
    electronWeixin: ElectronWeixinApi;
  }
}

const apiKeyInput = requireElement<HTMLInputElement>('apiKeyInput');
const baseUrlInput = requireElement<HTMLInputElement>('baseUrlInput');
const modelInput = requireElement<HTMLInputElement>('modelInput');
const maxIterationsInput = requireElement<HTMLInputElement>('maxIterationsInput');
const interactiveInput = requireElement<HTMLInputElement>('interactiveInput');
const saveConfigButton = requireElement<HTMLButtonElement>('saveConfigButton');
const recipientInput = requireElement<HTMLInputElement>('recipientInput');
const messageInput = requireElement<HTMLTextAreaElement>('messageInput');
const runButton = requireElement<HTMLButtonElement>('runButton');
const cancelButton = requireElement<HTMLButtonElement>('cancelButton');
const clearLogButton = requireElement<HTMLButtonElement>('clearLogButton');
const statusBadge = requireElement<HTMLSpanElement>('statusBadge');
const logList = requireElement<HTMLOListElement>('logList');
const screenshotMeta = requireElement<HTMLSpanElement>('screenshotMeta');
const screenshotEmpty = requireElement<HTMLDivElement>('screenshotEmpty');
const screenshotImage = requireElement<HTMLImageElement>('screenshotImage');

let running = false;

baseUrlInput.value = DEFAULT_CHAT_BASE_URL;
modelInput.value = DEFAULT_CHAT_MODEL;
maxIterationsInput.value = '30';

void loadConfig();

if (window.electronWeixin.platform !== 'win32') {
  appendLog('error', '当前不是 Windows 平台，此界面只能查看，不能执行 Win32 微信控制任务。');
  runButton.disabled = true;
}

window.electronWeixin.onRunnerEvent((event) => {
  handleRunnerEvent(event);
});

runButton.addEventListener('click', () => {
  void startTask();
});

cancelButton.addEventListener('click', () => {
  void cancelTask();
});

clearLogButton.addEventListener('click', () => {
  logList.replaceChildren();
});

saveConfigButton.addEventListener('click', () => {
  void saveConfig();
});

async function loadConfig(): Promise<void> {
  const result = await window.electronWeixin.loadConfig();

  if (!result.ok) {
    appendLog('error', result.error);
    return;
  }

  if (!result.config) {
    return;
  }

  applyConfig(result.config);
  appendLog('info', '已载入本地配置。');

  if (result.warning) {
    appendLog('warn', result.warning);
  }
}

async function saveConfig(): Promise<void> {
  const result = await window.electronWeixin.saveConfig(readConfig());

  if (!result.ok) {
    appendLog('error', result.error);
    return;
  }

  appendLog('info', '配置已保存到本机。');

  if (result.warning) {
    appendLog('warn', result.warning);
  }
}

async function startTask(): Promise<void> {
  if (running) {
    appendLog('warn', '已有任务正在运行。');
    return;
  }

  const request = readRequest();

  if (!request.config.apiKey) {
    appendLog('error', '请先填写 API key。');
    return;
  }

  if (!request.task.recipient) {
    appendLog('error', '请填写联系人名称。');
    return;
  }

  if (!request.task.message.trim()) {
    appendLog('error', '请填写消息内容。');
    return;
  }

  setRunning(true);
  setStatus('running', 'Running');
  appendLog('info', `准备发送给 ${request.task.recipient}。`);

  const result = await window.electronWeixin.startTask(request);

  if (!result.ok) {
    appendLog('error', result.error);
    setRunning(false);
    setStatus('failed', 'Failed');
  }
}

async function cancelTask(): Promise<void> {
  const result = await window.electronWeixin.cancelTask();

  if (!result.ok) {
    appendLog('warn', result.error);
  }
}

function readRequest(): ElectronWeixinRunRequest {
  return {
    config: readConfig(),
    task: {
      recipient: recipientInput.value.trim(),
      message: messageInput.value,
    },
  };
}

function readConfig(): ElectronWeixinConfig {
  const maxIterations = Number(maxIterationsInput.value);

  return {
    apiKey: apiKeyInput.value.trim(),
    baseURL: baseUrlInput.value.trim() || DEFAULT_CHAT_BASE_URL,
    model: modelInput.value.trim() || DEFAULT_CHAT_MODEL,
    maxIterations: Number.isInteger(maxIterations) && maxIterations > 0 ? maxIterations : 30,
    interactiveEnabled: interactiveInput.checked,
  };
}

function applyConfig(config: ElectronWeixinConfig): void {
  apiKeyInput.value = config.apiKey;
  baseUrlInput.value = config.baseURL;
  modelInput.value = config.model;
  maxIterationsInput.value = String(config.maxIterations);
  interactiveInput.checked = config.interactiveEnabled;
}

function handleRunnerEvent(event: RunnerEvent): void {
  if (event.type === 'status') {
    setStatus(event.status, event.status);
    appendLog(event.status === 'failed' ? 'error' : 'info', event.message, event.at);
    return;
  }

  if (event.type === 'log') {
    appendLog(event.level, event.message, event.at);
    return;
  }

  if (event.type === 'model') {
    appendLog('info', `模型响应：${event.summary || '(empty)'}`, event.at);
    return;
  }

  if (event.type === 'tool-call') {
    appendLog('info', `工具调用：${event.name} ${event.argumentsPreview}`, event.at);
    return;
  }

  if (event.type === 'tool-result') {
    appendLog('info', `工具结果：${event.name} ${event.resultPreview}`, event.at);
    return;
  }

  if (event.type === 'tool-error') {
    appendLog('error', `工具异常：${event.name}/${event.triggerType} ${event.message}`, event.at);
    return;
  }

  if (event.type === 'screenshot') {
    updateScreenshot(event);
    appendLog(
      'info',
      `截图已通过 Cloudflare URL 注入视觉上下文：${event.remoteImageUrl}`,
      event.at,
    );
    return;
  }

  if (event.type === 'done') {
    appendLog(
      event.canceled ? 'warn' : 'info',
      `任务结束，上下文消息数：${event.messageCount}${event.canceled ? '，期间收到取消请求' : ''}。`,
      event.at,
    );
    setRunning(false);
    setStatus(event.canceled ? 'canceled' : 'ended', event.canceled ? 'Canceled' : 'Ended');
    return;
  }

  if (event.type === 'error') {
    appendLog('error', event.message, event.at);
    setRunning(false);
    setStatus('failed', 'Failed');
  }
}

function updateScreenshot(event: Extract<RunnerEvent, { type: 'screenshot' }>): void {
  screenshotEmpty.hidden = true;
  screenshotImage.hidden = false;
  screenshotImage.src = event.dataUrl;
  screenshotMeta.textContent = `${event.hwnd} · ${event.className} · ${event.width}x${event.height}`;
  screenshotImage.title = `${event.title}\n${event.path}\n${event.remoteImageUrl}`;
}

function setRunning(value: boolean): void {
  running = value;
  runButton.disabled = value || window.electronWeixin.platform !== 'win32';
  cancelButton.disabled = !value;
  saveConfigButton.disabled = value;
}

function setStatus(status: string, label: string): void {
  statusBadge.textContent = label;
  statusBadge.dataset.status = status;
}

function appendLog(
  level: 'info' | 'warn' | 'error',
  message: string,
  at = new Date().toISOString(),
): void {
  const item = document.createElement('li');
  const time = document.createElement('time');
  const text = document.createElement('span');

  item.className = `log-item ${level}`;
  time.textContent = new Date(at).toLocaleTimeString();
  text.textContent = message;
  item.append(time, text);
  logList.append(item);
  item.scrollIntoView({ block: 'end' });
}

function requireElement<TElement extends HTMLElement>(id: string): TElement {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }

  return element as TElement;
}
