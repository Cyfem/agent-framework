/**
 * Windows Responses demo 的启动入口。
 *
 * Win32 工具实现在 `windows.ts` 中保持可复用且无导入副作用，供 Chat 版本共享。
 */
import { runWindowsDemo } from './windows';

if (process.platform !== 'win32') {
  console.error('The Windows control demo only runs on Windows.');
  process.exitCode = 1;
} else if (!process.env.ARK_API_KEY) {
  console.error('Missing ARK_API_KEY. Run this demo with an Ark Coding Plan API key.');
  process.exitCode = 1;
} else {
  await runWindowsDemo(process.env.ARK_API_KEY);
}
