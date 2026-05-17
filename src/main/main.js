import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { RecorderStore } from './recorder-store.js';

const require = createRequire(import.meta.url);
const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  session: electronSession,
  shell
} = require('electron');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);
const logoPath = path.join(__dirname, '../renderer/assets/signaltrail-logo.svg');
const macIconPath = path.join(__dirname, '../renderer/assets/signaltrail-logo.icns');
const unpackedMainDir = __dirname.replace(
  `${path.sep}app.asar`,
  `${path.sep}app.asar.unpacked`
);
const keyboardMonitorSourcePath = path.join(unpackedMainDir, 'keyboard-monitor.swift');
const nativeKeyboardMonitorPath = path.join(
  unpackedMainDir,
  '../../build/Release/keyboard_monitor.node'
);

app.setName('SignalTrail');

let mainWindow;
let recorderStore;
let keyboardMonitorProcess = null;
let keyboardMonitorBuffer = '';
let keyboardMonitorBinaryPath = null;
let nativeKeyboardMonitor = null;
let nativeKeyboardMonitorRunning = false;
let keyboardPermissionPromptOpen = false;
let browserPermissionPromptOpen = false;
const browserPermissionPromptsShown = new Set();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 1060,
    minHeight: 700,
    backgroundColor: '#0f1115',
    title: 'SignalTrail',
    icon: process.platform === 'darwin' ? macIconPath : logoPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.env.SIGNALTRAIL_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function setDockIcon() {
  if (process.platform !== 'darwin' || !app.dock) {
    return;
  }

  const dockIcon = nativeImage.createFromPath(macIconPath);

  if (!dockIcon.isEmpty()) {
    app.dock.setIcon(dockIcon);
  }
}

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame?.url ?? '';
  const protocol = new URL(senderUrl).protocol;

  if (protocol !== 'file:') {
    throw new Error(`Blocked IPC from untrusted origin: ${senderUrl}`);
  }
}

function normalizeType(type) {
  if (typeof type !== 'string' || type.length === 0 || type.length > 64) {
    return 'event';
  }

  return type.replaceAll(/[^a-z0-9:-]/gi, '-').toLowerCase();
}

function normalizePayload(payload) {
  try {
    const json = JSON.stringify(payload ?? {});
    const bytes = Buffer.byteLength(json, 'utf8');

    if (bytes > 16_384) {
      return {
        truncated: true,
        originalBytes: bytes,
        preview: json.slice(0, 1024)
      };
    }

    return JSON.parse(json);
  } catch {
    return {
      invalid: true
    };
  }
}

function displaySnapshot() {
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor
  }));
}

function cleanText(value, maxLength = 500) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replaceAll(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength);
}

function normalizeTask(settings) {
  const description = cleanText(settings?.task?.description ?? '', 240);

  return {
    description,
    label: description ? description.slice(0, 80) : ''
  };
}

function browserApplicationName(appName = '') {
  const browserNames = new Set([
    'Google Chrome',
    'Google Chrome Canary',
    'Brave Browser',
    'Microsoft Edge',
    'Chromium',
    'Safari'
  ]);

  return browserNames.has(appName) ? appName : null;
}

async function runAppleScript(script, timeout = 1400) {
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], {
    timeout,
    maxBuffer: 64 * 1024
  });

  return stdout.trim();
}

function appleScriptString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function contextError(error) {
  const message = error?.stderr || error?.message || String(error);
  const permissionNeeded = message.includes('-1743') || message.includes('Not authorized');

  return {
    platform: process.platform,
    capturedAt: new Date().toISOString(),
    ok: false,
    permissionNeeded,
    error: cleanText(message, 360)
  };
}

async function getBrowserContext(appName) {
  const browserName = browserApplicationName(appName);

  if (!browserName) {
    return null;
  }

  const script =
    browserName === 'Safari'
      ? `
    tell application "Safari"
      if (count of windows) is 0 then return ""
      set tabTitle to ""
      set tabUrl to ""
      try
        set tabTitle to name of front document
        set tabUrl to URL of front document
      end try
      return tabTitle & tab & tabUrl
    end tell
  `
      : `
    tell application ${appleScriptString(browserName)}
      if (count of windows) is 0 then return ""
      set tabTitle to ""
      set tabUrl to ""
      try
        set tabTitle to title of active tab of front window
        set tabUrl to URL of active tab of front window
      end try
      return tabTitle & tab & tabUrl
    end tell
  `;

  try {
    const output = await runAppleScript(script);
    const [title = '', url = ''] = output.split('\t');

    if (!title && !url) {
      return null;
    }

    return {
      title: cleanText(title, 300),
      url: cleanText(url, 1000),
      source: 'applescript'
    };
  } catch (error) {
    return {
      title: '',
      url: '',
      source: 'applescript',
      permissionNeeded: true,
      error: cleanText(error?.stderr || error?.message || String(error), 240)
    };
  }
}

async function getActiveContext() {
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      capturedAt: new Date().toISOString(),
      ok: false,
      unsupported: true
    };
  }

  const script = `
    tell application "System Events"
      set frontProcess to first application process whose frontmost is true
      set appName to name of frontProcess
      set appBundleId to ""
      set windowTitle to ""
      try
        set appBundleId to bundle identifier of frontProcess
      end try
      try
        set windowTitle to name of front window of frontProcess
      end try
      return appName & tab & appBundleId & tab & windowTitle
    end tell
  `;

  try {
    const output = await runAppleScript(script);
    const [appName = '', bundleId = '', windowTitle = ''] = output.split('\t');
    const browser = await getBrowserContext(appName);

    return {
      platform: process.platform,
      capturedAt: new Date().toISOString(),
      ok: true,
      app: {
        name: cleanText(appName, 160),
        bundleId: cleanText(bundleId, 240)
      },
      window: {
        title: cleanText(windowTitle, 500)
      },
      browser
    };
  } catch (error) {
    return contextError(error);
  }
}

async function capturePrimaryDisplay(trigger = 'manual') {
  if (!recorderStore?.isRecording()) {
    return {
      ok: false,
      reason: 'not-recording'
    };
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const thumbnailSize = {
    width: Math.round(primaryDisplay.bounds.width * primaryDisplay.scaleFactor),
    height: Math.round(primaryDisplay.bounds.height * primaryDisplay.scaleFactor)
  };

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize
  });

  const source =
    sources.find((candidate) => candidate.display_id === String(primaryDisplay.id)) ?? sources[0];

  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('No capturable screen source was returned by Electron.');
  }

  const png = source.thumbnail.toPNG();
  const size = source.thumbnail.getSize();
  const saved = await recorderStore.saveScreenshot(png, {
    trigger,
    displayId: source.display_id,
    sourceName: source.name,
    width: size.width,
    height: size.height
  });

  return {
    ok: true,
    ...saved,
    width: size.width,
    height: size.height
  };
}

function setupDisplayMediaHandler() {
  electronSession.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!request.videoRequested) {
      callback({});
      return;
    }

    desktopCapturer
      .getSources({
        types: ['screen'],
        thumbnailSize: {
          width: 0,
          height: 0
        }
      })
      .then((sources) => {
        const primaryDisplayId = String(screen.getPrimaryDisplay().id);
        const source =
          sources.find((candidate) => candidate.display_id === primaryDisplayId) ?? sources[0];

        if (!source) {
          callback({});
          return;
        }

        callback({
          video: source
        });
      })
      .catch(() => {
        callback({});
      });
  }, { useSystemPicker: true });
}

function latestScreenshotDataUrl(sessionRecord) {
  if (!sessionRecord?.latestScreenshot) {
    return null;
  }

  const imagePath = recorderStore.resolveSessionPath(
    sessionRecord.id,
    sessionRecord.latestScreenshot
  );

  if (!imagePath) {
    return null;
  }

  const image = nativeImage.createFromPath(imagePath);

  if (image.isEmpty()) {
    return null;
  }

  const resized = image.resize({
    width: 420,
    quality: 'good'
  });

  return resized.toDataURL();
}

function withSessionThumbnail(sessionRecord) {
  return {
    ...sessionRecord,
    thumbnailDataUrl: latestScreenshotDataUrl(sessionRecord),
    videoUrl: sessionRecord?.videoPath ? pathToFileURL(sessionRecord.videoPath).href : null
  };
}

function loadNativeKeyboardMonitor() {
  if (process.platform !== 'darwin') {
    return null;
  }

  if (nativeKeyboardMonitor) {
    return nativeKeyboardMonitor;
  }

  try {
    nativeKeyboardMonitor = require(nativeKeyboardMonitorPath);
    return nativeKeyboardMonitor;
  } catch (error) {
    console.warn(`Native keyboard monitor unavailable: ${error.message}`);
    return null;
  }
}

async function ensureKeyboardMonitorBinary() {
  if (process.platform !== 'darwin') {
    return null;
  }

  const helperDir = path.join(app.getPath('userData'), 'helpers');
  const binaryPath = path.join(helperDir, 'signaltrail-keyboard-monitor');

  if (keyboardMonitorBinaryPath === binaryPath) {
    return binaryPath;
  }

  await fs.mkdir(helperDir, { recursive: true });
  const [sourceStat, binaryStat] = await Promise.all([
    fs.stat(keyboardMonitorSourcePath),
    fs.stat(binaryPath).catch(() => null)
  ]);
  const needsCompile = !binaryStat || sourceStat.mtimeMs > binaryStat.mtimeMs;

  if (needsCompile) {
    await execFileAsync('/usr/bin/xcrun', ['swiftc', keyboardMonitorSourcePath, '-o', binaryPath], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
    await execFileAsync(
      '/usr/bin/codesign',
      ['--force', '--sign', '-', '--identifier', 'com.replayai.signaltrail.keyboard-monitor', binaryPath],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      }
    );
  }

  keyboardMonitorBinaryPath = binaryPath;
  return binaryPath;
}

async function appendKeyboardMonitorEvent(payload) {
  try {
    const record = await recorderStore.appendEvent('keyboard', payload);

    if (record && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recorder:event-appended', record);
    }

    if (payload?.kind === 'monitor-status' && payload.ok === false) {
      showKeyboardPermissionPrompt(payload);
    }
  } catch (error) {
    console.error(`Failed to append keyboard event: ${error.message}`);
  }
}

function showKeyboardPermissionPrompt(payload = {}) {
  if (keyboardPermissionPromptOpen || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  keyboardPermissionPromptOpen = true;
  dialog
    .showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Input Monitoring Needed',
      message: 'SignalTrail needs Input Monitoring permission for global keyboard capture.',
      detail:
        `${payload.message || payload.error || 'macOS is blocking global keyboard events.'}\n\n` +
        'Open Input Monitoring, enable SignalTrail, then stop and start recording again.',
      buttons: ['Open Input Monitoring', 'Reveal SignalTrail App', 'Later'],
      defaultId: 0,
      cancelId: 2
    })
    .then(({ response }) => {
      if (response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
      } else if (response === 1) {
        const appBundlePath =
          process.platform === 'darwin'
            ? path.dirname(path.dirname(path.dirname(process.execPath)))
            : process.execPath;
        shell.showItemInFolder(appBundlePath);
      }
    })
    .finally(() => {
      keyboardPermissionPromptOpen = false;
    });
}

function showBrowserPermissionPrompt(appName, error) {
  const browserName = browserApplicationName(appName);

  if (
    !browserName ||
    browserPermissionPromptOpen ||
    browserPermissionPromptsShown.has(browserName) ||
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return;
  }

  browserPermissionPromptOpen = true;
  browserPermissionPromptsShown.add(browserName);
  dialog
    .showMessageBox(mainWindow, {
      type: 'warning',
      title: `${browserName} Automation Permission Needed`,
      message: `SignalTrail needs macOS Automation permission to read the active ${browserName} tab title and URL.`,
      detail:
        `${error || 'Browser tab capture is currently blocked.'}\n\n` +
        `Open Automation settings and allow Electron/SignalTrail to control ${browserName}.`,
      buttons: ['Open Automation Settings', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    .then(({ response }) => {
      if (response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
      }
    })
    .finally(() => {
      browserPermissionPromptOpen = false;
    });
}

function processKeyboardMonitorLine(line) {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  try {
    appendKeyboardMonitorEvent(JSON.parse(trimmed));
  } catch {
    appendKeyboardMonitorEvent({
      kind: 'monitor-output',
      message: cleanText(trimmed, 1000)
    });
  }
}

async function startKeyboardMonitor() {
  if (keyboardMonitorProcess || nativeKeyboardMonitorRunning || !recorderStore?.isRecording()) {
    return;
  }

  if (process.platform !== 'darwin') {
    appendKeyboardMonitorEvent({
      kind: 'monitor-status',
      ok: false,
      unsupported: true,
      platform: process.platform
    });
    return;
  }

  try {
    const nativeMonitor = loadNativeKeyboardMonitor();

    if (nativeMonitor) {
      const result = nativeMonitor.start((payload) => {
        appendKeyboardMonitorEvent({
          ...payload,
          source: 'native-addon'
        });
      });

      if (result?.ok) {
        nativeKeyboardMonitorRunning = true;
        await appendKeyboardMonitorEvent({
          kind: 'monitor-status',
          ok: true,
          message: result.alreadyRunning
            ? 'Native keyboard monitor already running'
            : 'Native keyboard monitor requested',
          source: 'native-addon'
        });
        return;
      }

      await appendKeyboardMonitorEvent({
        kind: 'monitor-status',
        ok: false,
        message: result?.message || 'Input Monitoring permission needed for Electron/SignalTrail.',
        permissionNeeded: Boolean(result?.permissionNeeded),
        source: 'native-addon'
      });
      showKeyboardPermissionPrompt({
        message: result?.message || 'Input Monitoring permission needed for Electron/SignalTrail.'
      });
      return;
    }

    await appendKeyboardMonitorEvent({
      kind: 'monitor-status',
      ok: true,
      phase: 'starting'
    });
    const binaryPath = await ensureKeyboardMonitorBinary();
    await appendKeyboardMonitorEvent({
      kind: 'monitor-status',
      ok: true,
      phase: 'compiled',
      binaryPath
    });
    keyboardMonitorProcess = spawn(binaryPath, [], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    keyboardMonitorBuffer = '';

    await appendKeyboardMonitorEvent({
      kind: 'monitor-status',
      ok: true,
      phase: 'spawned'
    });

    keyboardMonitorProcess.stdout.on('data', (chunk) => {
      keyboardMonitorBuffer += chunk.toString('utf8');
      const lines = keyboardMonitorBuffer.split('\n');
      keyboardMonitorBuffer = lines.pop() ?? '';
      lines.forEach(processKeyboardMonitorLine);
    });

    keyboardMonitorProcess.stderr.on('data', (chunk) => {
      appendKeyboardMonitorEvent({
        kind: 'monitor-error',
        message: cleanText(chunk.toString('utf8'), 1000)
      });
    });

    keyboardMonitorProcess.on('error', (error) => {
      appendKeyboardMonitorEvent({
        kind: 'monitor-status',
        ok: false,
        phase: 'spawn-error',
        error: cleanText(error?.message || String(error), 1000)
      });
    });

    keyboardMonitorProcess.on('exit', (code, signal) => {
      if (keyboardMonitorBuffer) {
        processKeyboardMonitorLine(keyboardMonitorBuffer);
        keyboardMonitorBuffer = '';
      }

      keyboardMonitorProcess = null;

      if (recorderStore?.isRecording()) {
        appendKeyboardMonitorEvent({
          kind: 'monitor-exit',
          code,
          signal
        });
      }
    });
  } catch (error) {
    appendKeyboardMonitorEvent({
      kind: 'monitor-status',
      ok: false,
      error: cleanText(error?.message || String(error), 1000)
    });
  }
}

function stopKeyboardMonitor() {
  if (nativeKeyboardMonitorRunning && nativeKeyboardMonitor) {
    try {
      nativeKeyboardMonitor.stop();
    } catch (error) {
      console.warn(`Failed to stop native keyboard monitor: ${error.message}`);
    }

    nativeKeyboardMonitorRunning = false;
  }

  if (!keyboardMonitorProcess) {
    return;
  }

  keyboardMonitorProcess.kill('SIGTERM');
  keyboardMonitorProcess = null;
  keyboardMonitorBuffer = '';
}

function setupSecurityGuards() {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));

    contents.on('will-navigate', (event, navigationUrl) => {
      const protocol = new URL(navigationUrl).protocol;

      if (protocol !== 'file:') {
        event.preventDefault();
      }
    });
  });
}

function setupIpc() {
  ipcMain.handle('recorder:status', (event) => {
    assertTrustedSender(event);
    return {
      isRecording: recorderStore.isRecording(),
      session: recorderStore.getSessionInfo(),
      databasePath: recorderStore.getDatabasePath()
    };
  });

  ipcMain.handle('recorder:start', async (event, settings = {}) => {
    assertTrustedSender(event);
    const safeSettings = normalizePayload(settings);
    const task = normalizeTask(safeSettings);
    const initialContext = await getActiveContext();
    const session = await recorderStore.startSession({
      name: task.description || undefined,
      task,
      appVersion: app.getVersion(),
      platform: process.platform,
      displays: displaySnapshot(),
      initialContext,
      settings: safeSettings
    });
    await startKeyboardMonitor();

    return {
      isRecording: true,
      session,
      databasePath: recorderStore.getDatabasePath(),
      sessions: recorderStore.listSessions().map(withSessionThumbnail)
    };
  });

  ipcMain.handle('recorder:stop', async (event, summary = {}) => {
    assertTrustedSender(event);
    stopKeyboardMonitor();
    const session = await recorderStore.stopSession(normalizePayload(summary));

    return {
      isRecording: false,
      session,
      sessions: recorderStore.listSessions().map(withSessionThumbnail)
    };
  });

  ipcMain.handle('recorder:event', async (event, type, payload = {}) => {
    assertTrustedSender(event);
    const record = await recorderStore.appendEvent(normalizeType(type), normalizePayload(payload));

    return {
      ok: Boolean(record),
      record
    };
  });

  ipcMain.handle('recorder:capture-screenshot', async (event, options = {}) => {
    assertTrustedSender(event);
    const payload = normalizePayload(options);
    const trigger = typeof payload.trigger === 'string' ? payload.trigger.slice(0, 64) : 'manual';
    return capturePrimaryDisplay(trigger);
  });

  ipcMain.handle('recorder:screenshot-frame', async (event, frame, metadata = {}) => {
    assertTrustedSender(event);
    const safeMetadata = normalizePayload(metadata);
    const buffer = Buffer.from(frame);
    const saved = await recorderStore.saveScreenshot(buffer, {
      ...safeMetadata,
      trigger: typeof safeMetadata.trigger === 'string' ? safeMetadata.trigger.slice(0, 64) : 'preview'
    });

    return {
      ok: true,
      ...saved,
      width: safeMetadata.width,
      height: safeMetadata.height
    };
  });

  ipcMain.handle('recorder:cursor', (event) => {
    assertTrustedSender(event);
    const point = screen.getCursorScreenPoint();

    return {
      x: point.x,
      y: point.y,
      displays: displaySnapshot()
    };
  });

  ipcMain.handle('recorder:active-context', async (event) => {
    assertTrustedSender(event);
    const context = await getActiveContext();

    if (context?.browser?.permissionNeeded) {
      showBrowserPermissionPrompt(context.app?.name, context.browser.error);
    } else if (context?.permissionNeeded) {
      showKeyboardPermissionPrompt({
        message: 'Accessibility permission is needed to read the active app and window.',
        error: context.error
      });
    }

    return context;
  });

  ipcMain.handle('recorder:video-chunk', async (event, chunk, metadata = {}) => {
    assertTrustedSender(event);
    const safeMetadata = normalizePayload(metadata);
    return recorderStore.appendVideoChunk(chunk, safeMetadata);
  });

  ipcMain.handle('recorder:sessions', (event) => {
    assertTrustedSender(event);
    return recorderStore.listSessions().map(withSessionThumbnail);
  });

  ipcMain.handle('recorder:delete-sessions', async (event, ids = []) => {
    assertTrustedSender(event);
    const safeIds = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
    const result = await recorderStore.deleteSessions(safeIds);

    return {
      ...result,
      sessions: recorderStore.listSessions().map(withSessionThumbnail)
    };
  });

  ipcMain.handle('recorder:delete-all-sessions', async (event) => {
    assertTrustedSender(event);
    const ids = recorderStore
      .listSessions()
      .filter((session) => session.status !== 'recording')
      .map((session) => session.id);
    const result = await recorderStore.deleteSessions(ids);

    return {
      ...result,
      sessions: recorderStore.listSessions().map(withSessionThumbnail)
    };
  });

  ipcMain.handle('recorder:session-detail', async (event, id) => {
    assertTrustedSender(event);
    const detail = await recorderStore.getSessionDetail(id);

    if (!detail) {
      return null;
    }

    return withSessionThumbnail(detail);
  });

  ipcMain.handle('recorder:database', (event) => {
    assertTrustedSender(event);
    return {
      path: recorderStore.getDatabasePath(),
      database: recorderStore.getDatabase()
    };
  });

  ipcMain.handle('recorder:reveal-session', async (event, id) => {
    assertTrustedSender(event);
    const sessionRecord = recorderStore.getSession(id);

    if (!sessionRecord) {
      return {
        ok: false,
        reason: 'not-found'
      };
    }

    const error = await shell.openPath(sessionRecord.dir);

    return {
      ok: !error,
      error
    };
  });

  ipcMain.handle('recorder:reveal-session-file', async (event, id, fileKind) => {
    assertTrustedSender(event);
    const sessionRecord = recorderStore.getSession(id);

    if (!sessionRecord) {
      return {
        ok: false,
        reason: 'not-found'
      };
    }

    const filePath =
      fileKind === 'events'
        ? sessionRecord.eventsPath
        : fileKind === 'video'
          ? sessionRecord.videoPath
          : sessionRecord.dir;

    shell.showItemInFolder(filePath);

    return {
      ok: true,
      path: filePath
    };
  });

  ipcMain.handle('recorder:reveal-database', (event) => {
    assertTrustedSender(event);
    shell.showItemInFolder(recorderStore.getDatabasePath());

    return {
      ok: true,
      path: recorderStore.getDatabasePath()
    };
  });

  ipcMain.handle('recorder:reveal-data-folder', async (event) => {
    assertTrustedSender(event);
    const error = await shell.openPath(recorderStore.getRootDir());

    return {
      ok: !error,
      error,
      path: recorderStore.getRootDir()
    };
  });
}

setupSecurityGuards();

app.whenReady().then(async () => {
  setDockIcon();
  recorderStore = new RecorderStore(app.getPath('userData'));
  await recorderStore.ready();
  setupDisplayMediaHandler();
  setupIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopKeyboardMonitor();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
