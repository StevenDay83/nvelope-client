import { ipcMain } from 'electron'
import { manualScan, startAutoScan, stopAutoScan, stopAllScans, getScanStatus } from '../relay/scanner'

let mainWindow: Electron.BrowserWindow | null = null

export function setMainWindowForRelay(win: Electron.BrowserWindow | null): void {
  mainWindow = win
}

export function registerRelayHandlers(): void {
  ipcMain.handle('relay:manualScan', async (_event, identityId: string) => {
    return manualScan(identityId, mainWindow)
  })

  ipcMain.handle('relay:startAutoScan', async (_event, identityId: string) => {
    startAutoScan(identityId, mainWindow)
    return { started: true }
  })

  ipcMain.handle('relay:stopAutoScan', async (_event, identityId: string) => {
    stopAutoScan(identityId)
    return { stopped: true }
  })

  ipcMain.handle('relay:stopAllScans', async () => {
    stopAllScans()
    return { stopped: true }
  })

  ipcMain.handle('relay:getScanStatus', async () => {
    return getScanStatus()
  })
}
