const { app, BrowserWindow, Tray, nativeImage, ipcMain, shell, Notification, screen, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');

const USAGE_URL = 'https://chatgpt.com/codex/cloud/settings/analytics#usage';
const USAGE_BASE_URL = USAGE_URL.split('#')[0];
const PAGE_LOAD_TIMEOUT_MS = 45000;
const PAGE_READ_TIMEOUT_MS = 15000;
const APP_ROOT = path.resolve(__dirname, '..');
const USER_DATA_DIR = app.isPackaged ? path.join(app.getPath('appData'), 'Codex Balance Tray') : path.join(APP_ROOT, 'userdata');
const CACHE_DIR = path.join(USER_DATA_DIR, 'cache');

fs.mkdirSync(CACHE_DIR, { recursive: true });
app.setName('Codex QuotaRing');
app.setPath('userData', USER_DATA_DIR);
app.commandLine.appendSwitch('disk-cache-dir', CACHE_DIR);
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

let tray;
let settingsWindow;
let settingsPageWindow;
let statusWindow;
let trayMenuWindow;
let browserWindow;
let refreshTimer;
let activeRefreshPromise = null;
let lastPanelToggleAt = 0;
let panelReady = false;
let pendingPanelShow = false;
let panelVisible = false;
let panelDestroyTimer = null;
let lastPanelBounds = null;
let trayMenuVisible = false;
let lastTrayMenuToggleAt = 0;
let lastSettingsPageShowAt = 0;
const PANEL_WINDOW_SIZE = { width: 356, height: 416 };
const STATUS_WINDOW_SIZE = { width: 226, height: 78 };
const PANEL_DESTROY_DELAY_MS = 30000;
let lastUsage = {
  status: '等待刷新',
  fiveHour: null,
  weekly: null,
  fiveHourReset: null,
  weeklyReset: null,
  updatedAt: null,
  error: null
};

const defaultConfig = {
  refreshMinutes: 5,
  warnBelowPercent: 20,
  notifyWhenLow: true,
  autoRefreshOnStart: true,
  autoLaunch: false,
  floatingStatusBar: true,
  statusWindowBounds: null,
  language: 'en',
  theme: 'light'
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return { ...defaultConfig, ...JSON.parse(raw) };
  } catch {
    return { ...defaultConfig };
  }
}

function saveConfig(nextConfig) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(nextConfig, null, 2));
}

let config = loadConfig();

function syncAutoLaunch() {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(config.autoLaunch),
      path: process.execPath,
      args: app.isPackaged ? [] : [APP_ROOT]
    });
  } catch {
    // Login item support varies between packaged and dev Electron runs.
  }
}

function makeTrayIcon(fiveHour, weekly) {
  const primary = normalizePercent(fiveHour ?? weekly);
  const primaryColor = usageColor(primary);
  const size = 32;
  const buffer = Buffer.alloc(size * size * 4);
  const track = hexToBgra('#cbd5e1');
  const primaryBgra = hexToBgra(primaryColor);
  const centerBgra = hexToBgra('#111827');
  const textColor = hexToBgra('#ffffff');

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      buffer[i + 3] = 0;
      if (distance(x, y, 15.5, 15.5) <= 10.4) writeBgra(buffer, i, centerBgra);
      paintRingPixel(buffer, i, x, y, 15.5, 15.5, 13.6, 4.4, track, primaryBgra, primary);
      paintCenterDigits(buffer, i, x, y, primary, textColor);
    }
  }

  const image = nativeImage.createFromBitmap(buffer, { width: size, height: size, scaleFactor: 1 });
  image.setTemplateImage(false);
  return image;
}

function normalizePercent(value) {
  return typeof value === 'number' ? Math.max(0, Math.min(100, value)) : null;
}

function usageColor(value) {
  if (value === null) return '#737373';
  if (value < config.warnBelowPercent) return '#ef4444';
  if (value < 50) return '#f59e0b';
  return '#22c55e';
}

function paintRingPixel(buffer, index, x, y, cx, cy, radius, thickness, track, fill, percent) {
  const d = distance(x, y, cx, cy);
  if (Math.abs(d - radius) > thickness / 2) return;

  writeBgra(buffer, index, track);
  if (percent === null) return;

  const angle = (Math.atan2(y - cy, x - cx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
  const fraction = angle / (Math.PI * 2);
  if (fraction <= percent / 100) {
    writeBgra(buffer, index, fill);
  }
}

function paintCenterDigits(buffer, index, x, y, value, color) {
  if (value === null) {
    if ((x >= 14 && x <= 17 && y >= 13 && y <= 16) || (x >= 15 && x <= 16 && y >= 20 && y <= 21)) {
      writeBgra(buffer, index, color);
    }
    return;
  }

  const digits = value >= 100 ? '99' : String(Math.round(value)).padStart(2, '0');
  const startX = 6;
  for (let n = 0; n < digits.length; n += 1) {
    if (scaledDigitPixel(digits[n], x - startX - n * 10, y - 8)) {
      writeBgra(buffer, index, color);
    }
  }
}

function scaledDigitPixel(digit, x, y) {
  if (x < 0 || y < 0) return false;
  return digitPixel(digit, Math.floor(x / 3), Math.floor(y / 3));
}

function digitPixel(digit, x, y) {
  const patterns = {
    0: ['111', '101', '101', '101', '111'],
    1: ['010', '110', '010', '010', '111'],
    2: ['111', '001', '111', '100', '111'],
    3: ['111', '001', '111', '001', '111'],
    4: ['101', '101', '111', '001', '001'],
    5: ['111', '100', '111', '001', '111'],
    6: ['111', '100', '111', '101', '111'],
    7: ['111', '001', '010', '010', '010'],
    8: ['111', '101', '111', '101', '111'],
    9: ['111', '101', '111', '001', '111']
  };
  return patterns[digit]?.[y]?.[x] === '1';
}

function hexToBgra(hex) {
  const value = hex.replace('#', '');
  return {
    b: parseInt(value.slice(4, 6), 16),
    g: parseInt(value.slice(2, 4), 16),
    r: parseInt(value.slice(0, 2), 16),
    a: 255
  };
}

function writeBgra(buffer, index, color) {
  buffer[index] = color.b;
  buffer[index + 1] = color.g;
  buffer[index + 2] = color.r;
  buffer[index + 3] = color.a;
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function usageLine(label, value, reset) {
  if (typeof value !== 'number') return `${label}: 未读取`;
  return `${label}: ${value}% remaining${reset ? `, resets ${reset}` : ''}`;
}

function updateTray() {
  if (!tray) return;
  tray.setImage(makeTrayIcon(lastUsage.fiveHour, lastUsage.weekly));
  tray.setToolTip('');
  tray.setContextMenu(null);

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('usage:update', { usage: lastUsage, config });
  }
  if (settingsPageWindow && !settingsPageWindow.isDestroyed()) {
    settingsPageWindow.webContents.send('usage:update', { usage: lastUsage, config });
  }
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.webContents.send('usage:update', { usage: lastUsage, config });
  }
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.webContents.send('usage:update', { usage: lastUsage, config });
  }
  syncFloatingStatusWindow();
}

function showLowBalanceNotification() {
  if (!config.notifyWhenLow) return;
  const values = [lastUsage.fiveHour, lastUsage.weekly].filter((value) => typeof value === 'number');
  if (!values.some((value) => value <= config.warnBelowPercent)) return;

  new Notification({
    title: 'Codex 余额偏低',
    body: `当前 5 小时 ${lastUsage.fiveHour ?? '-'}%，每周 ${lastUsage.weekly ?? '-'}%。`
  }).show();
}

function showErrorNotification(message) {
  new Notification({
    title: 'Codex Balance 刷新失败',
    body: message || '无法读取余额，请检查登录状态或网络连接。'
  }).show();
}

function openUsageWindow(visible = true) {
  if (browserWindow && !browserWindow.isDestroyed() && !browserWindow.webContents.isCrashed()) {
    if (visible) browserWindow.show();
    if (!isUsagePageUrl(browserWindow.webContents.getURL())) {
      browserWindow.loadURL(USAGE_URL);
    }
    return browserWindow;
  }

  if (browserWindow && !browserWindow.isDestroyed()) {
    const staleWindow = browserWindow;
    browserWindow = null;
    staleWindow.destroy();
  }

  browserWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    show: visible,
    title: 'ChatGPT Codex Usage',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  browserWindow.on('closed', () => {
    browserWindow = null;
  });

  browserWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (isIgnorableNavigationError(errorCode, errorDescription)) return;
    if (browserWindow && !browserWindow.isDestroyed()) {
      lastUsage = {
        ...lastUsage,
        status: '刷新失败',
        updatedAt: Date.now(),
        error: errorDescription || '页面加载失败'
      };
      updateTray();
      showErrorNotification(lastUsage.error);
    }
  });

  browserWindow.loadURL(USAGE_URL);
  return browserWindow;
}

function isUsagePageUrl(url) {
  return typeof url === 'string' && url.startsWith(USAGE_BASE_URL);
}

function isUsagePageLoaded(win) {
  if (!win || win.isDestroyed()) return false;
  const currentUrl = win.webContents.getURL();
  return isUsagePageUrl(currentUrl) && !win.webContents.isLoading();
}

async function prepareUsagePage(win, { forceReload = false } = {}) {
  if (!win || win.isDestroyed()) throw new Error('使用页面窗口已关闭');
  if (win.webContents.isCrashed()) throw new Error('使用页面已停止响应，请重新刷新');

  const currentUrl = win.webContents.getURL();
  const onUsagePage = isUsagePageUrl(currentUrl);

  if (!onUsagePage) {
    await withTimeout(win.loadURL(USAGE_URL), PAGE_LOAD_TIMEOUT_MS, '使用页面加载超时');
    return;
  }

  if (forceReload) {
    if (win.webContents.isLoading()) {
      await waitForPageReady(win, PAGE_LOAD_TIMEOUT_MS);
      return;
    }

    try {
      win.webContents.stop();
      win.webContents.reloadIgnoringCache();
      await waitForPageReady(win, PAGE_LOAD_TIMEOUT_MS);
      return;
    } catch {
      await withTimeout(win.loadURL(USAGE_URL), PAGE_LOAD_TIMEOUT_MS, '使用页面重新加载超时');
      return;
    }
  }

  if (win.webContents.isLoading()) {
    await waitForPageReady(win, PAGE_LOAD_TIMEOUT_MS);
  }
}

function waitForPageReady(win, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed()) {
      reject(new Error('使用页面窗口已关闭'));
      return;
    }

    let settled = false;
    let settleTimer = null;
    const timeout = setTimeout(() => finish(false), timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      if (settleTimer) clearTimeout(settleTimer);
      win.webContents.removeListener('did-stop-loading', onReady);
      win.webContents.removeListener('did-finish-load', onReady);
      win.webContents.removeListener('dom-ready', onReady);
      win.webContents.removeListener('did-fail-load', onFail);
      win.removeListener('closed', onClosed);
    };

    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (ok) resolve();
      else reject(error || new Error('页面加载超时，请打开登录页面确认 ChatGPT 已登录'));
    };

    const onReady = () => {
      if (win.isDestroyed()) {
        finish(false, new Error('使用页面窗口已关闭'));
        return;
      }
      if (win.webContents.isLoading()) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => finish(true), 250);
    };

    const onFail = (_event, _errorCode, errorDescription) => {
      if (isIgnorableNavigationError(_errorCode, errorDescription)) {
        onReady();
        return;
      }
      finish(false, new Error(errorDescription || '页面加载失败'));
    };

    const onClosed = () => finish(false, new Error('使用页面窗口已关闭'));

    win.webContents.on('did-stop-loading', onReady);
    win.webContents.on('did-finish-load', onReady);
    win.webContents.on('dom-ready', onReady);
    win.webContents.on('did-fail-load', onFail);
    win.on('closed', onClosed);
    onReady();
  });
}

function isIgnorableNavigationError(errorCode, errorDescription = '') {
  return errorCode === -3 || /ERR_ABORTED/i.test(errorDescription);
}

async function readUsageFromPage(win) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await readUsageFromPageOnce(win);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await delay(1000);
        try {
          await prepareUsagePage(win, { forceReload: true });
        } catch (reloadError) {
          lastError = reloadError;
        }
      }
    }
  }

  lastUsage = {
    ...lastUsage,
    status: '刷新失败',
    updatedAt: Date.now(),
    error: lastError ? lastError.message : '读取失败'
  };
  updateTray();
  showErrorNotification(lastUsage.error);
}

async function readUsageFromPageOnce(win) {
  try {
    const result = await withTimeout(win.webContents.executeJavaScript(`
      (() => {
        const text = document.body ? document.body.innerText : '';
        const compact = text.replace(/\\r/g, '');
        const lines = compact.split('\\n').map((line) => line.trim()).filter(Boolean);
        const findBlock = (patterns) => {
          const index = lines.findIndex((line) => patterns.some((pattern) => pattern.test(line)));
          if (index < 0) return null;
          return lines.slice(index, index + 12).join('\\n');
        };
        const parsePercent = (block) => {
          if (!block) return null;
          const remainingMatch = block.match(/(\\d{1,3})\\s*%\\s*(?:remaining|left|剩余)?/i);
          if (!remainingMatch) return null;
          const value = Number(remainingMatch[1]);
          return value >= 0 && value <= 100 ? value : null;
        };
        const parseReset = (block) => {
          if (!block) return null;
          const match = block.match(/(?:Resets?|Reset|重置)\\s*[:：]?\\s*([^\\n]+)/i);
          return match ? match[1].trim() : null;
        };
        const fiveCard = findBlock([
          /5\\s*hour/i,
          /five\\s*hour/i,
          /5\\s*小时/,
          /小时额度/
        ]);
        const weeklyCard = findBlock([
          /weekly/i,
          /week\\s*limit/i,
          /每周/,
          /周额度/
        ]);
        return {
          title: document.title,
          href: location.href,
          textSample: compact.slice(0, 800),
          fiveHour: parsePercent(fiveCard),
          weekly: parsePercent(weeklyCard),
          fiveHourReset: parseReset(fiveCard),
          weeklyReset: parseReset(weeklyCard)
        };
      })();
    `), PAGE_READ_TIMEOUT_MS, '余额读取超时，请打开登录页面确认 ChatGPT 状态');

    if (typeof result.fiveHour !== 'number' && typeof result.weekly !== 'number') {
      const loginHint = /log in|sign in|登录|continue/i.test(result.textSample || '');
      const revokedHint = /token|revoked|refresh/i.test(result.textSample || '');
      if (loginHint || revokedHint) {
        throw new Error('需要在登录页面重新登录 ChatGPT');
      }
      throw new Error(`没有在页面中找到余额文本：${result.title || result.href || '未知页面'}`);
    }

    lastUsage = {
      status: '已更新',
      fiveHour: result.fiveHour,
      weekly: result.weekly,
      fiveHourReset: result.fiveHourReset,
      weeklyReset: result.weeklyReset,
      updatedAt: Date.now(),
      error: null
    };
    updateTray();
    showLowBalanceNotification();
  } catch (error) {
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function refreshUsage({ visible = false } = {}) {
  if (activeRefreshPromise) return activeRefreshPromise;

  activeRefreshPromise = (async () => {
    try {
      lastUsage = { ...lastUsage, status: '正在刷新', error: null };
      updateTray();
      const win = openUsageWindow(visible);
      if (!visible) win.hide();
      await prepareUsagePage(win, { forceReload: true });
      await readUsageFromPage(win);
    } catch (error) {
      lastUsage = {
        ...lastUsage,
        status: '刷新失败',
        updatedAt: Date.now(),
        error: error.message
      };
      updateTray();
      showErrorNotification(lastUsage.error);
    } finally {
      activeRefreshPromise = null;
    }
  })();

  return activeRefreshPromise;
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshUsage({ visible: false });
  }, Math.max(1, Number(config.refreshMinutes || 5)) * 60 * 1000);
}

function showSettingsWindow() {
  showSettingsPage();
}

function togglePanel() {
  hideTrayMenu();
  const now = Date.now();
  if (now - lastPanelToggleAt < 520) return;
  lastPanelToggleAt = now;

  if (panelVisible) {
    hidePanel();
    return;
  }

  if (!settingsWindow || settingsWindow.isDestroyed()) {
    pendingPanelShow = true;
    createSettingsWindow();
    return;
  }

  if (!panelReady) {
    pendingPanelShow = true;
    return;
  }

  showPanel({ toggle: true });
}

function showPanel({ toggle = false } = {}) {
  if (toggle && panelVisible) {
    hidePanel();
    return;
  }

  hideSettingsPage();
  clearPanelDestroyTimer();

  if (!settingsWindow || settingsWindow.isDestroyed()) {
    pendingPanelShow = true;
    createSettingsWindow();
    return;
  }

  if (!panelReady) {
    pendingPanelShow = true;
    return;
  }

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    positionWindowNearTray(settingsWindow);
    settingsWindow.showInactive();
    panelVisible = true;
    return;
  }
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) return;
  clearPanelDestroyTimer();
  panelReady = false;
  settingsWindow = new BrowserWindow({
    width: PANEL_WINDOW_SIZE.width,
    height: PANEL_WINDOW_SIZE.height,
    resizable: false,
    frame: false,
    transparent: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'Codex Balance',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
    panelReady = false;
    pendingPanelShow = false;
    panelVisible = false;
    clearPanelDestroyTimer();
  });

  settingsWindow.once('ready-to-show', () => {
    panelReady = true;
    positionWindowNearTray(settingsWindow);
    if (pendingPanelShow) {
      pendingPanelShow = false;
      settingsWindow.showInactive();
      panelVisible = true;
    }
  });

  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
}

function showSettingsPage() {
  hideTrayMenu();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    lastPanelBounds = settingsWindow.getBounds();
  }
  hidePanel({ destroy: true });

  const now = Date.now();
  if (now - lastSettingsPageShowAt < 350) return;
  lastSettingsPageShowAt = now;

  if (settingsPageWindow && !settingsPageWindow.isDestroyed()) {
    positionSettingsPageWindow(settingsPageWindow);
    settingsPageWindow.showInactive();
    settingsPageWindow.webContents.send('usage:update', { usage: lastUsage, config });
    return;
  }

  settingsPageWindow = new BrowserWindow({
    width: PANEL_WINDOW_SIZE.width,
    height: PANEL_WINDOW_SIZE.height,
    resizable: false,
    frame: false,
    transparent: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'Codex Balance Settings',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsPageWindow.on('closed', () => {
    settingsPageWindow = null;
  });

  settingsPageWindow.once('ready-to-show', () => {
    positionSettingsPageWindow(settingsPageWindow);
    settingsPageWindow.showInactive();
  });

  settingsPageWindow.loadFile(path.join(__dirname, 'settings-page.html'));
}

function hideSettingsPage() {
  if (settingsPageWindow && !settingsPageWindow.isDestroyed()) {
    settingsPageWindow.close();
  }
}

function createStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) return;

  statusWindow = new BrowserWindow({
    width: STATUS_WINDOW_SIZE.width,
    height: STATUS_WINDOW_SIZE.height,
    resizable: false,
    frame: false,
    transparent: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'Codex Balance Status',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  statusWindow.on('closed', () => {
    statusWindow = null;
  });

  statusWindow.on('moved', () => {
    rememberStatusWindowPosition();
  });

  statusWindow.once('ready-to-show', () => {
    positionStatusWindow(statusWindow);
    statusWindow.showInactive();
  });

  statusWindow.loadFile(path.join(__dirname, 'status.html'));
}

function syncFloatingStatusWindow() {
  if (config.floatingStatusBar) {
    createStatusWindow();
  } else if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.close();
  }
}

function showTrayMenu() {
  const now = Date.now();
  if (now - lastTrayMenuToggleAt < 520) return;
  lastTrayMenuToggleAt = now;

  hidePanel({ destroy: true });
  hideSettingsPage();

  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    positionWindowNearTray(trayMenuWindow);
    if (!trayMenuVisible) {
      trayMenuWindow.showInactive();
      trayMenuVisible = true;
    }
    trayMenuWindow.webContents.send('usage:update', { usage: lastUsage, config });
    return;
  }

  trayMenuWindow = new BrowserWindow({
    width: PANEL_WINDOW_SIZE.width,
    height: PANEL_WINDOW_SIZE.height,
    resizable: false,
    frame: false,
    transparent: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'Codex Balance Menu',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  trayMenuWindow.on('closed', () => {
    trayMenuWindow = null;
    trayMenuVisible = false;
  });

  trayMenuWindow.once('ready-to-show', () => {
    positionWindowNearTray(trayMenuWindow);
    trayMenuWindow.showInactive();
    trayMenuVisible = true;
  });

  trayMenuWindow.loadFile(path.join(__dirname, 'menu.html'));
}

function hideTrayMenu() {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.close();
  }
  trayMenuVisible = false;
}

function positionStatusWindow(win) {
  const width = STATUS_WINDOW_SIZE.width;
  const height = STATUS_WINDOW_SIZE.height;
  win.setSize(width, height, false);

  const saved = normalizeSavedBounds(config.statusWindowBounds, width, height);
  if (saved) {
    win.setPosition(saved.x, saved.y, false);
    return;
  }

  const display = screen.getPrimaryDisplay();
  const margin = 12;
  const x = display.workArea.x + Math.round((display.workArea.width - width) / 2);
  const y = display.workArea.y + display.workArea.height - height - margin;
  win.setPosition(x, y, false);
}

function rememberStatusWindowPosition() {
  if (!statusWindow || statusWindow.isDestroyed()) return;
  const bounds = statusWindow.getBounds();
  config = {
    ...config,
    statusWindowBounds: {
      x: bounds.x,
      y: bounds.y
    }
  };
  saveConfig(config);
}

function normalizeSavedBounds(bounds, width, height) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return null;
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const margin = 6;
  return {
    x: Math.min(Math.max(bounds.x, display.workArea.x + margin), display.workArea.x + display.workArea.width - width - margin),
    y: Math.min(Math.max(bounds.y, display.workArea.y + margin), display.workArea.y + display.workArea.height - height - margin)
  };
}

function positionWindowNearTray(win) {
  const width = PANEL_WINDOW_SIZE.width;
  const height = PANEL_WINDOW_SIZE.height;
  win.setSize(width, height, false);

  const trayBounds = tray ? tray.getBounds() : null;
  const anchor = trayBounds && trayBounds.width && trayBounds.height
    ? {
        x: trayBounds.x + trayBounds.width / 2,
        y: trayBounds.y + trayBounds.height / 2
      }
    : {
        x: screen.getPrimaryDisplay().workArea.x + screen.getPrimaryDisplay().workArea.width,
        y: screen.getPrimaryDisplay().workArea.y + screen.getPrimaryDisplay().workArea.height
      };

  const display = screen.getDisplayNearestPoint(anchor);
  const margin = 10;
  const x = Math.min(
    Math.max(anchor.x - width + 18, display.workArea.x + margin),
    display.workArea.x + display.workArea.width - width - margin
  );
  const y = Math.min(
    Math.max(anchor.y - height - 22, display.workArea.y + margin),
    display.workArea.y + display.workArea.height - height - 22
  );
  win.setPosition(Math.round(x), Math.round(y), false);
}

function positionSettingsPageWindow(win) {
  win.setSize(PANEL_WINDOW_SIZE.width, PANEL_WINDOW_SIZE.height, false);
  if (lastPanelBounds) {
    win.setPosition(lastPanelBounds.x, lastPanelBounds.y, false);
    lastPanelBounds = null;
    return;
  }
  positionWindowNearTray(win);
}

function clearPanelDestroyTimer() {
  if (panelDestroyTimer) {
    clearTimeout(panelDestroyTimer);
    panelDestroyTimer = null;
  }
}

function hidePanel({ destroy = false } = {}) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    lastPanelBounds = settingsWindow.getBounds();
    if (destroy) {
      settingsWindow.close();
    } else {
      settingsWindow.hide();
      clearPanelDestroyTimer();
      panelDestroyTimer = setTimeout(() => {
        panelDestroyTimer = null;
        if (settingsWindow && !settingsWindow.isDestroyed() && !panelVisible) {
          settingsWindow.close();
        }
      }, PANEL_DESTROY_DELAY_MS);
    }
  }
  pendingPanelShow = false;
  panelVisible = false;
}

ipcMain.handle('app:get-state', () => ({ usage: lastUsage, config }));
ipcMain.handle('app:refresh', () => refreshUsage({ visible: false }));
ipcMain.handle('app:open-usage', () => openUsageWindow(true));
ipcMain.handle('app:toggle-panel', () => {
  togglePanel();
});
ipcMain.handle('app:hide-panel', () => {
  hidePanel();
});
ipcMain.handle('app:show-settings-panel', () => {
  showSettingsPage();
});
ipcMain.handle('app:hide-settings-page', () => {
  hideSettingsPage();
});
ipcMain.handle('app:hide-tray-menu', () => {
  hideTrayMenu();
});
ipcMain.handle('app:quit', () => {
  app.quit();
});
ipcMain.handle('app:save-config', (_event, nextConfig) => {
  config = {
    ...config,
    refreshMinutes: Math.max(1, Number(nextConfig.refreshMinutes || config.refreshMinutes)),
    warnBelowPercent: Math.max(1, Math.min(100, Number(nextConfig.warnBelowPercent || config.warnBelowPercent))),
    notifyWhenLow: Boolean(nextConfig.notifyWhenLow),
    autoRefreshOnStart: Boolean(nextConfig.autoRefreshOnStart),
    autoLaunch: Boolean(nextConfig.autoLaunch),
    floatingStatusBar: nextConfig.floatingStatusBar !== false,
    statusWindowBounds: nextConfig.statusWindowBounds && Number.isFinite(nextConfig.statusWindowBounds.x) && Number.isFinite(nextConfig.statusWindowBounds.y)
      ? { x: nextConfig.statusWindowBounds.x, y: nextConfig.statusWindowBounds.y }
      : config.statusWindowBounds,
    language: nextConfig.language === 'en' ? 'en' : 'zh',
    theme: nextConfig.theme === 'dark' ? 'dark' : 'light'
  };
  saveConfig(config);
  syncAutoLaunch();
  syncFloatingStatusWindow();
  scheduleRefresh();
  updateTray();
  return { usage: lastUsage, config };
});

app.whenReady().then(() => {
  if (!singleInstanceLock) return;
  tray = new Tray(makeTrayIcon(null, null));
  tray.on('click', togglePanel);
  tray.on('right-click', showTrayMenu);
  createSettingsWindow();
  syncFloatingStatusWindow();
  updateTray();
  syncAutoLaunch();
  scheduleRefresh();

  if (config.autoRefreshOnStart) {
    setTimeout(() => refreshUsage({ visible: false }), 1000);
  }

  powerMonitor.on('resume', () => {
    if (config.autoRefreshOnStart) {
      setTimeout(() => refreshUsage({ visible: false }), 2500);
    }
  });
});

app.on('second-instance', () => {
  showSettingsWindow();
});

app.on('window-all-closed', () => {
  // Keep the tray app alive after closing settings or browser windows.
});

app.on('before-quit', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
