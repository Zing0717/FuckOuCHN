import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import fs from 'fs';

import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } from 'electron';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import { ims } from '@ims-tech-auto/core';
import type { RunnerProgressEvent } from '@ims-tech-auto/core';
import AIModel from '@ims-tech-auto/core/ai/AIModel.js';
import HumanBehaviorPlugin from '@ims-tech-auto/core/plugins/HumanBehaviorPlugin.js';
import Config, { printConfigStatus, dataDir } from '@ims-tech-auto/core/config.js';

// 打印功能开关状态
printConfigStatus();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.join(dirname(__filename), '..', '..');

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 如果无法获得锁，说明已有实例在运行
  app.quit();
}

let uiWindow: BrowserWindow | null = null;
const automationWindows: BrowserWindow[] = [];
let tray: Tray | null = null;
// 真正退出应用时置为 true，用于区分"关闭窗口最小化到托盘"与"退出程序"
let isQuitting = false;
// 运行时开关：关闭窗口时是否最小化到托盘（默认读 _MINIMIZE_TO_TRAY，可在托盘菜单切换）
let minimizeToTray = (() => {
  const raw = String(process.env._MINIMIZE_TO_TRAY ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off';
})();

// 恢复显示窗口
function showAllWindows() {
  for (const w of [uiWindow, ...automationWindows]) {
    if (w && !w.isDestroyed()) w.show();
  }
  if (uiWindow && !uiWindow.isDestroyed()) {
    uiWindow.focus();
  }
}

// 创建右下角托盘图标及菜单
function createTray() {
  if (tray) return;
  let icon: Electron.NativeImage;
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.ico');
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('icon empty');
  } catch {
    // 兜底：用内置空图，避免托盘创建失败导致崩溃
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('国开刷课（FuckOuCHN）');

  const rebuildMenu = () => {
    if (!tray) return;
    const menu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showAllWindows() },
      { type: 'separator' },
      {
        label: '关闭时最小化到托盘',
        type: 'checkbox',
        checked: minimizeToTray,
        click: (item) => {
          minimizeToTray = item.checked;
          console.log(`[Tray] 关闭时最小化到托盘：${minimizeToTray ? '开启' : '关闭'}`);
          rebuildMenu();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };
  rebuildMenu();
  // 双击托盘图标恢复窗口
  tray.on('double-click', () => showAllWindows());
}

// 给窗口挂上"关闭即最小化到托盘"的行为
function attachMinimizeToTray(w: BrowserWindow) {
  w.on('close', (e) => {
    if (isQuitting) return; // 真正退出时放行
    if (!minimizeToTray) return; // 开关关闭时按正常关闭处理
    e.preventDefault();
    w.hide();
  });
}

let uiReady = false;
const bufferedProgress: RunnerProgressEvent[] = [];
let bufferedInit: { concurrency: number; ts: number } | null = null;

function sendToUi(channel: string, payload: any) {
  if (!uiWindow) return;
  // UI 未 ready 时先缓冲，避免漏事件导致"进度窗口不更新"。
  if (!uiReady) {
    if (channel === 'ims:ui:init') bufferedInit = payload;
    if (channel === 'ims:progress') bufferedProgress.push(payload as RunnerProgressEvent);
    return;
  }
  uiWindow.webContents.send(channel, payload);
}

function getConcurrency() {
  const raw = Number(process.env._CONCURRENCY ?? 1);
  const n = Number.isFinite(raw) ? Math.floor(raw) : 1;
  // 与 core 保持一致：允许 0 表示“自动并发（按课程数）”。
  // Electron 侧无法在创建窗口时提前知道课程数，因此这里预创建最多 6 个窗口。
  if (n === 0) return 6;
  return Math.min(Math.max(n, 1), 6);
}

function getShowWorkers() {
  const raw = String(process.env._SHOW_WORKERS ?? '0').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function getUiTopMost() {
  // 默认不置顶；需要置顶时在 .env 设 _UI_TOPMOST=1
  const raw = String(process.env._UI_TOPMOST ?? '0').trim();
  return raw === '1' || raw.toLowerCase() === 'true';
}

app.on('second-instance', () => {
  if (uiWindow) {
    if (uiWindow.isMinimized()) uiWindow.restore();
    uiWindow.focus();
  }
});
{
  const { appendSwitch } = app.commandLine;
  appendSwitch('remote-debugging-port', '9222');
  appendSwitch('no-sandbox');
  appendSwitch('disable-gpu');
  appendSwitch('disable-software-rasterizer');
  appendSwitch('disable-gpu-compositing');
  appendSwitch('disable-accelerated-video-decode');
  appendSwitch('disable-accelerated-video-encode');

  // 某些 Windows 环境下禁用 GPU 后仍可能出现视频渲染/解码异常，强制使用 SwiftShader。
  // 这些开关不会保证彻底消灭 ffmpeg 日志，但通常能减少因 GPU/ANGLE 导致的兼容性问题。
  appendSwitch('use-angle', 'swiftshader');
  appendSwitch('use-gl', 'swiftshader');
}

async function createWindow() {
  const concurrency = getConcurrency();
  const windowCount = Math.max(1, concurrency);

  const uiTopMost = getUiTopMost();
  const showWorkers = getShowWorkers();

  // 1) 先创建自动化窗口（Playwright 会操作这些窗口）
  for (let i = 0; i < windowCount; i++) {
    const w = new BrowserWindow({
      width: 1200,
      height: 900,
      title: `刷课窗口 W${i + 1}`,
      // 需要手动登录时至少保留一个可见窗口，其它 worker 窗口默认隐藏
      show: !Config.browser.headless && (showWorkers || i === 0),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        additionalArguments: ['--ims-window=automation', `--ims-worker=${i + 1}`],
      },
    });
    automationWindows.push(w);
    await w.loadFile(path.join(__dirname, '/automation.html'));
    w.webContents.setAudioMuted(true);
    attachMinimizeToTray(w);
  }

  // 2) 再创建 UI 窗口（只显示进度，不参与自动化）
  uiWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    title: '进度面板',
    show: !Config.browser.headless,
    alwaysOnTop: uiTopMost,
    webPreferences: {
      nodeIntegration: false, // 禁用 Node.js Integration
      contextIsolation: true, // 启用上下文隔离
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: ['--ims-window=ui'],
    },
  });

  await uiWindow.loadFile(path.join(__dirname, '/index.html'));
  uiWindow.webContents.setAudioMuted(true);
  attachMinimizeToTray(uiWindow);

  if (uiTopMost) {
    // Windows 下让 UI 更不容易被覆盖
    uiWindow.setAlwaysOnTop(true, 'floating');
  }

  // UI ready 握手：renderer 会发 ims:ui:ready。
  // 这里提前准备 init 数据，并在 ready 后补发。
  // 注意：不要在此处重置 uiReady，因为 preload 的 ims:ui:ready 可能已经发送并处理
  bufferedInit = { concurrency, ts: Date.now() };
  // uiReady = false;  // 已在变量声明时初始化，不要重置
  bufferedProgress.length = 0;

  if (process.env._DEBUG_UI) {
    uiWindow.webContents.openDevTools({ mode: 'detach' });
  }

  uiWindow.webContents.on('did-navigate', () => {
    // UI 页面被刷新/跳转后，需要重新握手
    uiReady = false;
  });

  uiWindow.on('closed', () => {
    uiWindow = null;
    uiReady = false;
    bufferedProgress.length = 0;
    bufferedInit = null;
  });

  // 使用 Playwright 连接窗口，示例连接到CDP端口（确保 Electron 打开时调试端口暴露）
  await connectToElectron().catch((err) => {
    console.error('Electron connection to Playwright failed:', err);
  });
}

ipcMain.on('ims:ui:ready', (evt) => {
  // 确保是当前 uiWindow 发来的
  if (!uiWindow) return;
  if (evt.sender.id !== uiWindow.webContents.id) return;

  uiReady = true;

  if (bufferedInit) {
    console.log('[Main] Sending buffered init to UI');
    uiWindow.webContents.send('ims:ui:init', bufferedInit);
  }

  if (bufferedProgress.length) {
    console.log(`[Main] Sending ${bufferedProgress.length} buffered progress events`);
    for (const e of bufferedProgress.splice(0)) {
      uiWindow.webContents.send('ims:progress', e);
    }
  }
});

// ---------- 运行时长统计（本次运行 / 今日累计） ----------
// 今日累计跨重启持久化：按日期存 JSON，进程运行期间每 30s 落盘一次，退出时再落一次。
const runtimeStatsFile = path.join(dataDir, '.runtime-stats.json');
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const sessionStart = Date.now();
let todaySeconds = (() => {
  try {
    const stats = JSON.parse(fs.readFileSync(runtimeStatsFile, 'utf-8'));
    return stats.date === todayKey() ? Number(stats.seconds) || 0 : 0;
  } catch {
    return 0;
  }
})();

function persistRuntimeStats() {
  try {
    fs.writeFileSync(
      runtimeStatsFile,
      JSON.stringify({ date: todayKey(), seconds: todaySeconds }),
    );
  } catch {
    // 落盘失败不影响运行
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const formatDuration = (totalSeconds: number) => {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
};

// 每秒累加并推送到 UI；每 30 拍落盘一次
let runtimeTick = 0;
setInterval(() => {
  todaySeconds += 1;
  runtimeTick += 1;
  if (runtimeTick % 30 === 0) persistRuntimeStats();
  sendToUi('ims:runtime', {
    session: Date.now() - sessionStart,
    today: todaySeconds * 1000,
    ts: Date.now(),
  });
}, 1000);

process.on('exit', persistRuntimeStats);
app.on('before-quit', persistRuntimeStats);
// ---------- 运行时长统计结束 ----------

ipcMain.on('ims:log', (evt, msg) => {
  console.log('[Renderer Log]', msg);
});

// ---------- 暂停 / 继续 ----------
// UI 按钮点击 -> 切换 core 的暂停闸门，并把最新状态广播回 UI。
ipcMain.on('ims:pause:toggle', async () => {
  try {
    const core = await import('@ims-tech-auto/core');
    const paused = core.togglePause();
    console.log(`[Pause] 刷课${paused ? '已暂停' : '已继续'}`);
    sendToUi('ims:pause:state', { paused });
  } catch (err) {
    console.error('[Pause] 切换失败:', (err as any)?.message ?? err);
  }
});

ipcMain.on('ims:pause:query', async () => {
  try {
    const core = await import('@ims-tech-auto/core');
    sendToUi('ims:pause:state', { paused: core.isPaused() });
  } catch {
    /* ignore */
  }
});
// ---------- 暂停 / 继续结束 ----------

async function waitForCDP(url: string, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for CDP at ${url}`);
}

async function connectToElectron() {
  const cdpHost = '127.0.0.1';
  const cdpPort = '9222';
  const cdpUrl = `http://${cdpHost}:${cdpPort}`;

  console.log('Waiting for CDP...');
  await waitForCDP(cdpUrl + '/json/version');
  console.log('CDP is ready.');

  // Fetch the WebSocket URL manually
  const response = await fetch(cdpUrl + '/json/version');
  if (!response.ok) {
    throw new Error(`Failed to fetch CDP version info: ${response.statusText}`);
  }
  const json: any = await response.json();
  const wsEndpoint = json.webSocketDebuggerUrl;

  if (!wsEndpoint) {
    throw new Error('Could not find webSocketDebuggerUrl in CDP response');
  }

  console.log(`Connecting to CDP at ${wsEndpoint}`);

  // 连接到 Electron 的 CDP 端口
  const browser = await chromium
    .use(StealthPlugin())
    .use(HumanBehaviorPlugin())
    .connectOverCDP(wsEndpoint, {
      slowMo: 240,
      timeout: 1000 * 60 * 2,
      headers: {
        Accept: 'application/json',
        Connection: 'keep-alive',
      },
    });

  await AIModel.init(true);

  const session = ims.login(browser, {
    ...Config.user,
    loginApi: Config.urls.login(),
    homeApi: Config.urls.home(),

  });

  // 转发 core 的进度事件到 UI
  const knownCourseIds = new Set<number>();
  session.onProgress((e: RunnerProgressEvent) => {
    const cid = (e as any)?.course?.courseId;
    if (typeof cid === 'number' && cid > 0) knownCourseIds.add(cid);
    sendToUi('ims:progress', e);
  });

  // 每 60s 轮询国开平台的真实完成度（my-completeness），推送到 UI 面板
  const completenessTimer = setInterval(async () => {
    if (knownCourseIds.size === 0) return;
    try {
      const CourseApi = (await import('@ims-tech-auto/core/api/course.js')).default;
      const rows = await Promise.all(
        [...knownCourseIds].map(async (id) => {
          try {
            const r = await CourseApi.getCourseCompletenessById(id);
            return { courseId: id, ...r, ok: true };
          } catch {
            return { courseId: id, ok: false };
          }
        }),
      );
      sendToUi('ims:completeness', { rows, ts: Date.now() });
    } catch (err) {
      console.warn('[Completeness] 轮询失败:', (err as any)?.message ?? err);
    }
  }, 60 * 1000);

  try {
    const runner = await session.start();
    // 原版这里会无差别再跑一遍（restart），第一遍正常跑完时纯属重复；
    // 且第二遍抛出的异常无人捕获会导致进程静默退出。改为仅在第一遍
    // 因异常提前结束时重试一次，并打印退出原因。
    if (runner && typeof (runner as any).restart === 'function') {
      await (runner as any).restart().catch((e: unknown) => {
        console.error('[Main] 二次执行也失败，退出前记录原因:', e);
      });
    }
  } catch (err) {
    console.error('[Main] 课程执行流程异常退出:', err);
  }

  clearInterval(completenessTimer);
  console.log('[Main] 流程结束，应用退出。');
  app.exit();
}

function buildChineseMenu() {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: '文件',
      submenu: [
        { role: 'reload', label: '刷新页面' },
        { role: 'forceReload', label: '强制刷新' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '恢复缩放' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏切换' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            const win = new BrowserWindow({ width: 360, height: 200, show: true, autoHideMenuBar: false });
            win.loadURL(
              'data:text/html;charset=utf-8,' +
                encodeURIComponent(
                  '<body style="font-family:sans-serif;text-align:center;padding-top:50px"><h2>ImsTechAuto</h2><p>国开自动刷课工具（FuckOuCHN）</p></body>',
                ),
            );
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 强制 Chromium 以中文环境启动，避免国开站点跳转到 ?locale=en 页面
app.commandLine.appendSwitch('lang', 'zh-CN');

app.whenReady().then(() => {
  buildChineseMenu();
  createTray();
  createWindow();
});

app.on('before-quit', () => {
  // 标记为真正退出，让窗口 close 事件放行
  isQuitting = true;
});

app.on('window-all-closed', async () => {
  // 启用托盘时，窗口全关不退出，程序继续在后台刷课
  if (minimizeToTray && !isQuitting) return;
  app.quit();
});
