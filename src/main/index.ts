import { app, BrowserWindow, ipcMain, shell, Menu, MenuItem, nativeTheme, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { registerVaultHandlers, getAllUnlockedSessions } from './ipc/vaultHandlers'
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
import { registerSubscriptionHandlers } from './ipc/subscriptionHandlers'
import { registerRelayListHandlers } from './ipc/relayListHandlers'
import { registerBlossomHandlers } from './ipc/blossomHandlers'
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
let aboutWindow: BrowserWindow | null = null

// The UI is always dark — pin window chrome (and native dialogs where the
// toolkit honors it) to dark instead of following the OS light/dark setting.
nativeTheme.themeSource = 'dark'

// Linux windows get no icon from the AppImage — it must be set per-window.
// Harmless on macOS/Windows, which take the icon from the bundle/exe.
function windowIcon(): string {
  return path.join(app.getAppPath(), 'assets', 'icon.png')
}

// External links (mail bodies, iframe popups) open in the system browser,
// never in an Electron window. Everything else is denied.
function guardExternalNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  // In-page navigation (plain <a href> clicks) is never allowed to replace
  // the app window; external http(s) targets go to the system browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
  })
}

// Native-style edit context menu: spelling suggestions on misspellings,
// Cut/Copy/Paste/Select All in editable fields, Copy/Select All elsewhere.
function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu()

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menu.append(new MenuItem({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        }))
      }
      if (params.dictionarySuggestions.length > 0) menu.append(new MenuItem({ type: 'separator' }))
    }

    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'cut', enabled: params.editFlags.canCut }))
      menu.append(new MenuItem({ role: 'copy', enabled: params.editFlags.canCopy }))
      menu.append(new MenuItem({ role: 'paste', enabled: params.editFlags.canPaste }))
      menu.append(new MenuItem({ role: 'pasteAndMatchStyle', enabled: params.editFlags.canPaste }))
      menu.append(new MenuItem({ role: 'selectAll', enabled: params.editFlags.canSelectAll }))
    } else {
      if (params.selectionText) {
        menu.append(new MenuItem({ role: 'copy' }))
      }
      menu.append(new MenuItem({ role: 'selectAll' }))
    }

    if (menu.items.length > 0) menu.popup({ window: win })
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
    icon: windowIcon(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  setMainWindowForRelay(mainWindow)
  guardExternalNavigation(mainWindow)
  attachContextMenu(mainWindow)

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
    icon: windowIcon(),
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
  attachContextMenu(win)
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
  }  const preloadPath = resolvePreload()
  const win = new BrowserWindow({
    width: 700,
    height: 520,
    minWidth: 500,
    minHeight: 360,
    title: 'Address Book',
    parent: mainWindow ?? undefined,
    icon: windowIcon(),
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
  attachContextMenu(win)
  win.on('closed', () => {
    contactsWindow = null
  })

  win.loadURL(getRendererUrl())
  return win
}

// Custom About window (replaces the macOS-only native about panel). Carries
// the first unlocked session's account so the page can offer "message the
// nVelope team" compose without knowing session state itself.
function createAboutWindow(): void {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus()
    return
  }
  const data: Record<string, unknown> = { mode: 'about', version: app.getVersion() }
  const session = getAllUnlockedSessions()[0]
  const account = session?.payload.accounts[0]
  if (session && account) {
    data.identityId = session.identityId
    data.accountId = account.pubkey
    if (account.displayName) data.accountDisplayName = account.displayName
  }
  // Content keeps the about-bg.jpg aspect (660x465) at 2/3 scale.
  const win = new BrowserWindow({
    width: 440,
    height: 310,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'About nVelope',
    autoHideMenuBar: true,
    parent: mainWindow ?? undefined,
    icon: windowIcon(),
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--window-data=${JSON.stringify(data)}`],
    },
  })
  aboutWindow = win
  guardExternalNavigation(win)
  attachContextMenu(win)
  win.on('closed', () => {
    aboutWindow = null
  })
  win.loadURL(getRendererUrl())
}

// Real application menu (previously the Electron default, which only exposes
// About on macOS). Edit menu stays so copy/paste accelerators keep working.
function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const aboutItem: MenuItemConstructorOptions = { label: 'About nVelope', click: () => createAboutWindow() }
  const template: MenuItemConstructorOptions[] = []
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        aboutItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }
  template.push({ label: 'File', submenu: [isMac ? { role: 'close' as const } : { role: 'quit' as const }] })
  template.push({ role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' })
  const helpSubmenu: MenuItemConstructorOptions[] = []
  if (!isMac) helpSubmenu.push(aboutItem)
  helpSubmenu.push(
    { label: 'nVelope Website', click: () => void shell.openExternal('https://nvelope.messagepush.io') },
    { label: 'nVelope on GitHub', click: () => void shell.openExternal('https://github.com/StevenDay83/nvelope-client') },
  )
  template.push({ label: 'Help', submenu: helpSubmenu })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  installApplicationMenu()
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
  registerSubscriptionHandlers()
  registerRelayListHandlers()
  registerBlossomHandlers()

  ipcMain.handle('compose:open', (_event, data: Record<string, unknown>) => {
    createComposeWindow(data)
    return { ok: true }
  })

  ipcMain.handle('contactsWindow:open', (_event, data: Record<string, unknown>) => {
    createContactsWindow(data)
    return { ok: true }
  })

  ipcMain.handle('app:openAbout', () => {
    createAboutWindow()
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
