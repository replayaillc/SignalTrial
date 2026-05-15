import { execFile } from 'node:child_process';
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

app.setName('SignalTrail');

let mainWindow;
let recorderStore;

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

    return {
      isRecording: true,
      session,
      databasePath: recorderStore.getDatabasePath(),
      sessions: recorderStore.listSessions().map(withSessionThumbnail)
    };
  });

  ipcMain.handle('recorder:stop', async (event, summary = {}) => {
    assertTrustedSender(event);
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
    return getActiveContext();
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
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
