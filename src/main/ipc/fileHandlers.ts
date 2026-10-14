import { ipcMain, dialog, shell } from 'electron'
import fs from 'node:fs'

export function registerFileHandlers(): void {
  ipcMain.handle('file:openExternal', async (_event, url: string) => {
    // External references open in the system browser; http(s) only.
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http/https links can be opened')
    }
    await shell.openExternal(url)
  })

  ipcMain.handle('file:openPemFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'PEM files', extensions: ['pem', 'key'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, content: '' }
    }
    const content = fs.readFileSync(result.filePaths[0]!, 'utf-8')
    return { canceled: false, content }
  })

  ipcMain.handle('file:saveTextFile', async (_event, defaultName: string, content: string) => {
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [
        { name: 'Text files', extensions: ['txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePath) {
      return { canceled: true }
    }
    fs.writeFileSync(result.filePath, content, 'utf-8')
    return { canceled: false, path: result.filePath }
  })
}
