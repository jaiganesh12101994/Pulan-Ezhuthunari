/**
 * Electron entry point for the packaged Pulan Tamil OCR desktop app.
 *
 * The app itself is unchanged: the same Express server, the same React UI. What this
 * file adds is what a browser cannot provide -
 *
 *   - a window, with working minimise / maximise / close (exposed to the UI as
 *     window.pulanDesktop, which src/components/WindowControls.tsx picks up)
 *   - a place for the server's data that is not inside Program Files
 *   - the bundled Python, Tesseract and Poppler, wired up by environment variable so
 *     the app can never silently fall back to a system install
 *
 * The server runs as a child process rather than inside this one, so a failed OCR
 * cannot take the window down with it.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

// extraResources land next to the executable in a packaged build; in development they
// are simply build/app, so the app can be run from the repo after staging.
const APP_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..', 'build', 'app');

const SERVER_ENTRY = path.join(APP_DIR, 'server.mjs');
const WINDOW_TITLE = 'Pulan Tamil OCR 1.0';

let serverProcess = null;
let mainWindow = null;

/** First free port in a small range, so two copies or an unrelated app cannot clash. */
function findFreePort(start = 3917, attempts = 12) {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryPort = () => {
      if (port >= start + attempts) {
        reject(new Error(`no free port between ${start} and ${start + attempts - 1}`));
        return;
      }
      const probe = net.createServer();
      probe.unref();
      probe.once('error', () => {
        port += 1;
        tryPort();
      });
      probe.once('listening', () => {
        const chosen = probe.address().port;
        probe.close(() => resolve(chosen));
      });
      probe.listen(port, '127.0.0.1');
    };
    tryPort();
  });
}

function startServer(port) {
  const diagnosticsDir = path.join(app.getPath('userData'), 'diagnostics');
  fs.mkdirSync(diagnosticsDir, { recursive: true });

  const env = {
    ...process.env,
    // Make this Electron binary behave as plain Node for the child.
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    PORT: String(port),

    // Every external tool, pointed at the copy that shipped with the app. Left to PATH
    // the app would work on the build machine and fail on a clean one, which is the
    // exact failure this bundling exists to prevent.
    PYTHON_BIN: path.join(APP_DIR, 'python', 'python.exe'),
    TESSERACT_CMD: path.join(APP_DIR, 'engines', 'tesseract', 'tesseract.exe'),
    PDFTOPPM_BIN: path.join(APP_DIR, 'bin', 'pdftoppm.exe'),
    PDFINFO_BIN: path.join(APP_DIR, 'bin', 'pdfinfo.exe'),

    // Writable state: diagnostics records and image artifacts. Program Files is
    // read-only for a standard user, so this has to live under the user's own data.
    PULAN_DIAGNOSTICS_DIR: diagnosticsDir,
    PULAN_TEMP_DIR: path.join(os.tmpdir(), 'pulan-ocr'),
    // A user-installed Claude Code or Antigravity CLI is still reachable, because those
    // are account-bound tools the user signs in to themselves.
    PATH: process.env.PATH,
  };

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.on('exit', (code) => {
    if (!app.isQuitting) {
      dialog.showErrorBox(
        'Pulan Tamil OCR stopped',
        `The OCR service exited unexpectedly (code ${code}).`
      );
      app.quit();
    }
  });

  child.port = port;
  return child;
}

/** Poll the server until it answers, so the window never opens on a blank page. */
async function waitForServer(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`the OCR service exited with code ${serverProcess.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/samples`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the OCR service did not answer on port ${port} within ${timeoutMs / 1000}s`);
}

function sendMaximizedState(win) {
  if (win && !win.isDestroyed()) win.webContents.send('pulan:window:maximized', win.isMaximized());
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: WINDOW_TITLE,
    backgroundColor: '#f1f5f9',
    show: false,
    // No native frame: the app draws its own title bar in the top panel, so Electron's
    // own minimise / maximise / close buttons would be a second, redundant set sitting
    // above the ones the UI already provides.
    frame: false,
    // A frameless window loses its resize borders unless this stays on (it is the
    // WS_THICKFRAME style, and measured: it is what the 8px invisible edge is). Turning
    // it off makes the window flush with the page but no longer resizable by dragging.
    thickFrame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('maximize', () => sendMaximizedState(mainWindow));
  mainWindow.on('unmaximize', () => sendMaximizedState(mainWindow));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links (the gnana70 repository in the Help menu) belong in the user's own
  // browser, not in a window with no address bar and no way back.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  return mainWindow;
}

// One window, one server: a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      // No native menu. Electron would otherwise put File / Edit / View / Window / Help
      // above the app's own panel, and the app already has those menus in the panel
      // itself. Chromium still handles the editing shortcuts (Ctrl+C/V/X/A/Z) in the
      // text editor without them.
      Menu.setApplicationMenu(null);

      if (!fs.existsSync(SERVER_ENTRY)) {
        throw new Error(
          `the app was not staged at ${APP_DIR}\n\nRun:\n` +
            '  powershell -ExecutionPolicy Bypass -File scripts\\build-desktop.ps1'
        );
      }

      // The window controls. 'pulan:window' is fire-and-forget; the maximised state is
      // asked for once and then pushed whenever the window changes.
      ipcMain.on('pulan:window', (event, action) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return;
        if (action === 'minimize') win.minimize();
        else if (action === 'toggle-maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
        else if (action === 'close') win.close();
      });
      ipcMain.handle('pulan:window:is-maximized', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return win ? win.isMaximized() : false;
      });

      const port = await findFreePort();
      serverProcess = startServer(port);
      await waitForServer(port);
      createWindow(port);
    } catch (err) {
      dialog.showErrorBox(
        'Pulan Tamil OCR could not start',
        String(err && err.message ? err.message : err)
      );
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverProcess) {
      createWindow(serverProcess.port);
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    app.isQuitting = true;
    // Leave no orphaned Python or Tesseract behind.
    if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
  });
}
