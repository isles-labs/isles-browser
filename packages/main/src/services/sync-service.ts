import {app, ipcMain, systemPreferences, shell} from 'electron';
import path from 'path';
import type {SafeAny} from '../../../shared/types/db';
import { createLogger } from '../../../shared/utils/logger';
import { MAIN_LOGGER_LABEL } from '../constants';
import { dialog } from 'electron';
const logger = createLogger(MAIN_LOGGER_LABEL);
let addon: unknown;
if (!app.isPackaged) {
  // 开发环境：直接从构建目录加载
  addon = require(path.join(__dirname, '../src/native-addon/build/Release/', 'window-addon.node'));
} else {
  // 生产环境：根据平台和架构选择正确路径
  // const addonDir = `${process.platform}-${process.arch}`;
  
  const addonPath = path.join(
    process.resourcesPath,
    'app.asar.unpacked/node_modules/window-addon/',
    'window-addon.node',
  );

  try {
    addon = require(addonPath);
  } catch (error) {
    logger.error('Failed to load addon:', error);
    logger.error('Attempted path:', addonPath);
    logger.error('Platform and arch:', process.platform, process.arch);
  }
}

export const initSyncService = () => {
  if (!addon) {
    logger.error('Window addon not loaded properly', process.resourcesPath);
    return;
  }
  
  // 检查辅助功能权限（仅macOS）
  if (process.platform === 'darwin') {
    const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
    logger.info(`Accessibility permission: ${hasPermission ? 'granted' : 'denied'}`);
    
    if (!hasPermission) {
      // 在应用启动时提示用户授予权限
      logger.warn('应用需要辅助功能权限来排列窗口');
      dialog.showMessageBox({
        type: 'warning',
        title: '需要辅助功能权限',
        message: '请在系统偏好设置中为应用授予辅助功能权限，以启用窗口排列功能。',
        buttons: ['前往设置', '稍后再说'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          // 打开辅助功能设置
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
        }
      });
    }
  }
  
  const windowManager = new (addon as SafeAny).WindowManager();
  const getBoundsWithFallback = (pid: number) => {
    const bounds = windowManager.getWindowBounds(pid);
    if (bounds?.success) return bounds;

    try {
      const windows = (windowManager.getAllWindows(pid) || []) as Array<{
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
      if (!windows.length) return bounds;

      const largest = windows.reduce((best, current) => {
        const bestArea = (best.width || 0) * (best.height || 0);
        const currentArea = (current.width || 0) * (current.height || 0);
        return currentArea > bestArea ? current : best;
      });

      if (largest.width > 0 && largest.height > 0) {
        return {
          success: true,
          x: largest.x,
          y: largest.y,
          width: largest.width,
          height: largest.height,
        };
      }
    } catch (error) {
      logger.warn('[WindowDebug] getBoundsWithFallback failed', {pid, error});
    }

    return bounds;
  };
  const boundsMatch = (
    actual: {x: number; y: number; width: number; height: number} | undefined,
    expected: {x: number; y: number; width: number; height: number} | undefined,
    tolerance = 4,
  ) => {
    if (!actual || !expected) return false;
    const close = (a: number, b: number) => Math.abs(a - b) <= tolerance;
    return (
      close(actual.x, expected.x) &&
      close(actual.y, expected.y) &&
      close(actual.width, expected.width) &&
      close(actual.height, expected.height)
    );
  };
  const computeExpectedGridBounds = (args: {
    screenX: number;
    screenY: number;
    screenWidth: number;
    screenHeight: number;
    columns: number;
    spacing: number;
    size: {width: number; height: number};
    childCount: number;
  }) => {
    const {screenX, screenY, screenWidth, screenHeight, columns, spacing, size, childCount} = args;
    const totalWindows = childCount + 1;
    const rows = Math.ceil(totalWindows / columns);
    const availableWidth = screenWidth - spacing * (columns + 1);
    const availableHeight = screenHeight - spacing * (rows + 1);
    const effectiveWidth = size.width > 0 ? size.width : Math.floor(availableWidth / columns);
    const effectiveHeight = size.height > 0 ? size.height : Math.floor(availableHeight / rows);

    const main = {
      x: screenX + spacing,
      y: screenY + spacing,
      width: effectiveWidth - spacing * 2,
      height: effectiveHeight - spacing * 2,
    };

    const children = Array.from({length: childCount}).map((_, i) => {
      const row = Math.floor((i + 1) / columns);
      const col = (i + 1) % columns;
      return {
        x: screenX + col * effectiveWidth + spacing * (col + 1),
        y: screenY + row * effectiveHeight + spacing * (row + 1),
        width: effectiveWidth - spacing,
        height: effectiveHeight - spacing,
      };
    });

    return {main, children};
  };
  const logWindowsByPid = (pid: number, reason: string) => {
    try {
      const windows = windowManager.getAllWindows(pid) || [];
      logger.warn(`[WindowDebug] ${reason}`, {pid, windowCount: windows.length, windows});
    } catch (error) {
      logger.warn(`[WindowDebug] ${reason} (getAllWindows failed)`, {pid, error});
    }
  };

  logger.info('WindowManager initialized');

  ipcMain.handle('window-arrange', async (_, args) => {
    const {mainPid, childPids, columns, size, spacing, monitorIndex} = args;
    logger.info('Arranging windows', {mainPid, childPids, columns, size, spacing, monitorIndex});
    try {
      if (!windowManager) {
        logger.error('WindowManager not initialized');
        throw new Error('WindowManager not initialized');
      }
      const mainBounds = getBoundsWithFallback(mainPid);
      if (!mainBounds?.success) {
        logWindowsByPid(mainPid, 'Main window bounds lookup failed');
        throw new Error(`Main window not found or inaccessible (PID: ${mainPid})`);
      }
      if (!Array.isArray(childPids) || childPids.length === 0) {
        throw new Error('No child windows provided for arrangement');
      }
      const validChildPids = childPids.filter((pid: number) => {
        const bounds = getBoundsWithFallback(pid);
        if (!bounds?.success) {
          logWindowsByPid(pid, 'Child window bounds lookup failed');
        }
        return Boolean(bounds?.success);
      });
      if (validChildPids.length === 0) {
        throw new Error('No valid child windows found for arrangement');
      }
      logger.info('arrangeWindows', windowManager.arrangeWindows.toString());
      const beforeMainBounds = getBoundsWithFallback(mainPid);
      const beforeChildBounds = validChildPids.map((pid: number) => ({pid, bounds: getBoundsWithFallback(pid)}));

      const effectiveMonitorIndex = monitorIndex ?? 0;
      const monitors = windowManager.getMonitors?.() || [];
      if (!Array.isArray(monitors) || monitors.length === 0) {
        throw new Error('No monitors found');
      }
      if (effectiveMonitorIndex < 0 || effectiveMonitorIndex >= monitors.length) {
        throw new Error(`Invalid monitor index: ${effectiveMonitorIndex}`);
      }
      const selectedMonitor = monitors[effectiveMonitorIndex] as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      const expected = computeExpectedGridBounds({
        screenX: selectedMonitor.x,
        screenY: selectedMonitor.y,
        screenWidth: selectedMonitor.width,
        screenHeight: selectedMonitor.height,
        columns,
        spacing,
        size,
        childCount: validChildPids.length,
      });
      try {
        // Pass monitorIndex if provided, otherwise let native addon use default (0)
        if (monitorIndex !== undefined) {
          windowManager.arrangeWindows(mainPid, validChildPids, columns, size, spacing, monitorIndex);
        } else {
          windowManager.arrangeWindows(mainPid, validChildPids, columns, size, spacing);
        }
      } catch (e) {
        logger.error('Native function execution error:', e);
        throw e;
      }

      // Post-check: verify whether bounds changed after native arrange call
      const afterMainBounds = getBoundsWithFallback(mainPid);
      const afterChildBounds = validChildPids.map((pid: number) => ({
        pid,
        bounds: getBoundsWithFallback(pid),
      }));
      logger.info('[ArrangeVerify] Bounds before/after', {
        mainPid,
        beforeMainBounds,
        afterMainBounds,
        beforeChildBounds,
        afterChildBounds,
      });

      const expectedMainOk = Boolean(afterMainBounds?.success) && boundsMatch(afterMainBounds, expected.main);
      const expectedChildrenOk = afterChildBounds.every((entry, i) => {
        const bounds = entry.bounds;
        return Boolean(bounds?.success) && boundsMatch(bounds, expected.children[i]);
      });
      if (!expectedMainOk || !expectedChildrenOk) {
        logger.warn('[ArrangeVerify] Arrange had no effect or mismatched expected layout', {
          mainPid,
          expected,
          afterMainBounds,
          afterChildBounds,
        });
        return {
          success: false,
          error:
            'Arrange call did not reach expected bounds. Ensure target windows are not minimized/maximized/snap-locked and run with matching privileges.',
        };
      }

      return {success: true};
    } catch (error) {
      logger.error('Window arrangement failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  ipcMain.handle('window-get-monitors', async () => {
    logger.info('Getting available monitors');
    try {
      if (!windowManager) {
        logger.error('WindowManager not initialized');
        throw new Error('WindowManager not initialized');
      }

      const monitors = windowManager.getMonitors();
      logger.info('Available monitors:', monitors);
      return {success: true, monitors};
    } catch (error) {
      logger.error('Failed to get monitors:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        monitors: [],
      };
    }
  });
};
