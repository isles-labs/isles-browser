import {ipcRenderer} from 'electron';
import type {IpcRendererEvent} from 'electron';
import type {AppUpdateStatus} from '../../../shared/types/update';

export const UpdateBridge = {
  getCurrentVersion: () => ipcRenderer.invoke('app-version') as Promise<string>,
  getStatus: () => ipcRenderer.invoke('app-update-status') as Promise<AppUpdateStatus>,
  check: () => ipcRenderer.invoke('app-update-check') as Promise<void>,
  download: () => ipcRenderer.invoke('app-update-download') as Promise<AppUpdateStatus>,
  install: () => ipcRenderer.invoke('app-update-install') as Promise<boolean>,
  onStatus: (callback: (event: IpcRendererEvent, status: AppUpdateStatus) => void) =>
    ipcRenderer.on('app-update-status', callback),
  offStatus: (callback: (event: IpcRendererEvent, status: AppUpdateStatus) => void) =>
    ipcRenderer.off('app-update-status', callback),
};
