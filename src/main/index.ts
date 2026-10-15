import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { registerVaultHandlers } from './ipc/vaultHandlers'
import { registerDbHandlers } from './ipc/dbHandlers'
import { registerFileHandlers } from './ipc/fileHandlers'
import { registerCertHandlers } from './ipc/certHandlers'
import { registerBenchmarkHandlers } from './ipc/benchmarkHandlers'
import { registerRelayHandlers, setMainWindowForRelay } from './ipc/relayHandlers'
import { registerSettingsHandlers } from './ipc/settingsHandlers'
import { registerSendHandlers } from './ipc/sendHandlers'
import { registerOutboxHandlers } from './outbox/processor'
import { registerNip05Handlers } from './ipc/nip05Handlers'
import { registerContactSyncHandlers } from './ipc/contactSyncHandlers'
import { stopAllScans } from './relay/scanner'
import { closeAllDbs } from './ipc/dbHandlers'

function resolvePreload(): string {
  // electron-vite places built artifacts under out/main/ (main) and out/preload/ (preload).
  // __dirname is out/main/ when this file is the compiled main entry.
  const candidates = [
    path.join(__dirname, '../preload/index.js'), // standard out/preload/index.js
    path.join(__dirname, '../preload/preload.js'),
    path.join(__dirname, '../../preload/index.js'),
    path.join(__dirname, 'preload.js'),          // if ever co-located
  ]

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      // sanity: don't accidentally return the main bundle (which contains app.getPath etc.)
      const basename = path.basename(p)
      if (basename === 'index.js' && p.includes('/main/')) continue
      return p
    }
  }
  // fallback: let Electron report the exact missing file
  return candidates[0]!
}

let mainWindow: BrowserWindow | null = null
const composeWindows = new Set<BrowserWindow>()
let contactsWindow: BrowserWindow | null = null

// External links (mail bodies, iframe popups) open in the system browser,
// never in an Electron window. Everything else is denied.
function guardExternalNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
}

function getRendererUrl(): string {
  if (process.env['ELECTRON_RENDERER_URL']) {
    return process.env['ELECTRON_RENDERER_URL']
  }
  return `file://${path.join(__dirname, '../renderer/index.html')}`
}

const createWindow = (): void => {
  const preloadPath = resolvePreload()
  console.log('[main] preload path:', preloadPath)

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'nVelope Beta',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  setMainWindowForRelay(mainWindow)
  guardExternalNavigation(mainWindow)

  mainWindow.on('closed', () => {
    mainWindow = null
    setMainWindowForRelay(null)
  })

  mainWindow.loadURL(getRendererUrl())

  // Open DevTools in development
  if (process.env['NODE_ENV'] === 'development' || !!process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.webContents.openDevTools()
  }
}

function createComposeWindow(data: Record<string, unknown>): BrowserWindow {
  const preloadPath = resolvePreload()
  const win = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 600,
    minHeight: 400,
    title: 'Write: ' + (data.subject || '(no subject)'),
    parent: mainWindow ?? undefined,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--compose-data=${JSON.stringify(data)}`],
    },
  })

  composeWindows.add(win)
  guardExternalNavigation(win)
  win.on('closed', () => {
    composeWindows.delete(win)
  })

  win.loadURL(getRendererUrl())
  return win
}

function createContactsWindow(data: Record<string, unknown>): BrowserWindow {
  // Singleton: focus the existing address book instead of opening duplicates.
  // Still forward the data so an already-open window can show a prefill.
  if (contactsWindow && !contactsWindow.isDestroyed()) {
    contactsWindow.webContents.send('contacts:prefill', data)
    contactsWindow.focus()
    return contactsWindow
  }
  const preloadPath = resolvePreload()
  const win = new BrowserWindow({
    width: 700,
    height: 520,
    minWidth: 500,
    minHeight: 360,
    title: 'Address Book',
    parent: mainWindow ?? undefined,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--window-data=${JSON.stringify({ ...data, mode: 'contacts' })}`],
    },
  })

  contactsWindow = win
  guardExternalNavigation(win)
  win.on('closed', () => {
    contactsWindow = null
  })

  win.loadURL(getRendererUrl())
  return win
}

app.whenReady().then(() => {
  registerVaultHandlers()
  registerDbHandlers()
  registerFileHandlers()
  registerCertHandlers()
  registerBenchmarkHandlers()
  registerRelayHandlers()
  registerSettingsHandlers()
  registerSendHandlers()
  registerOutboxHandlers()
  registerNip05Handlers()
  registerContactSyncHandlers()

  ipcMain.handle('compose:open', (_event, data: Record<string, unknown>) => {
    createComposeWindow(data)
    return { ok: true }
  })

  ipcMain.handle('contactsWindow:open', (_event, data: Record<string, unknown>) => {
    createContactsWindow(data)
    return { ok: true }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopAllScans()
  closeAllDbs()
})
