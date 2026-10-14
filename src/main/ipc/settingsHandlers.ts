import { ipcMain } from 'electron'
import { getClientSetting, setClientSetting, getAllClientSettings, setAllClientSettings } from '../clientSettings'

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', async (_event, key: string) => {
    return getClientSetting(key as any)
  })

  ipcMain.handle('settings:set', async (_event, key: string, value: unknown) => {
    setClientSetting(key as any, value)
  })

  ipcMain.handle('settings:getAll', async () => {
    return getAllClientSettings()
  })

  ipcMain.handle('settings:setAll', async (_event, settings: Record<string, unknown>) => {
    setAllClientSettings(settings)
  })
}
