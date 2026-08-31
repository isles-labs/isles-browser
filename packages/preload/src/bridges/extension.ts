import {ipcRenderer} from 'electron';
import type {DB} from '../../../shared/types/db';

export const ExtensionBridge = {
  import: (filePath: string) => ipcRenderer.invoke('extension-import', filePath),
  getAll: () => ipcRenderer.invoke('extension-get-all'),
  installFromWebStore: (sourceUrl: string) =>
    ipcRenderer.invoke('extension-install-from-web-store', sourceUrl),
  installFromDirectory: (directoryPath: string) =>
    ipcRenderer.invoke('extension-install-from-directory', directoryPath),
  applyToWindows: (extensionId: number, windowIds: number[]) =>
    ipcRenderer.invoke('extension-apply-to-windows', extensionId, windowIds),
  deleteExtensionWindows: (extensionId: number, windowIds: number[]) =>
    ipcRenderer.invoke('delete-extension-windows', extensionId, windowIds),
  getExtensionWindows: (extensionId: number) =>
    ipcRenderer.invoke('extension-get-windows', extensionId),
  createExtension: (extension: DB.Extension) => ipcRenderer.invoke('extension-create', extension),
  uploadPackage: (filePath: string, extensionId?: number) =>
    ipcRenderer.invoke('extension-upload-package', filePath, extensionId),
  manualUpdate: (extensionId: number) =>
    ipcRenderer.invoke('extension-manual-update', extensionId),
  updateExtension: (extensionId: number, extension: Partial<DB.Extension>) =>
    ipcRenderer.invoke('extension-update', extensionId, extension),
  deleteExtension: (extensionId: number) => ipcRenderer.invoke('extension-delete', extensionId),
  syncWindowExtensions: (extensionId: number, windowIds: number[]) =>
    ipcRenderer.invoke('extension-sync-windows', extensionId, windowIds),
};
