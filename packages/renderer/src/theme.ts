import type {ThemeConfig} from 'antd';
import {theme as antdTheme} from 'antd';
import type {SettingOptions} from '../../shared/types/common';

export type ThemePreset = NonNullable<NonNullable<SettingOptions['ui']>['themePreset']>;
export type ColorMode = NonNullable<NonNullable<SettingOptions['ui']>['colorMode']>;
export type UiSettings = {
  themePreset: ThemePreset;
  colorMode: ColorMode;
};

export const DEFAULT_UI_SETTINGS: UiSettings = {
  themePreset: 'a',
  colorMode: 'light',
};

export const THEME_UPDATED_EVENT = 'chrome-power-theme-updated';

export const normalizeUiSettings = (settings?: SettingOptions): UiSettings => ({
  themePreset: settings?.ui?.themePreset || DEFAULT_UI_SETTINGS.themePreset,
  colorMode: settings?.ui?.colorMode || DEFAULT_UI_SETTINGS.colorMode,
});

type ThemeTokens = {
  primary: string;
  success: string;
  warning: string;
  error: string;
  text: string;
  textSecondary: string;
  bgBase: string;
  bgContainer: string;
  border: string;
  tableHeader: string;
};

const tokens: Record<ThemePreset, Record<ColorMode, ThemeTokens>> = {
  a: {
    light: {
      primary: '#0369A1',
      success: '#16A34A',
      warning: '#D97706',
      error: '#DC2626',
      text: '#0F172A',
      textSecondary: '#475569',
      bgBase: '#F5F9FC',
      bgContainer: '#FFFFFF',
      border: '#DBE7EF',
      tableHeader: '#F1F8FC',
    },
    dark: {
      primary: '#7DD3FC',
      success: '#22C55E',
      warning: '#FBBF24',
      error: '#F87171',
      text: '#E6F1FB',
      textSecondary: '#94A3B8',
      bgBase: '#07111F',
      bgContainer: '#0D1C2E',
      border: '#263A4D',
      tableHeader: '#102033',
    },
  },
  b: {
    light: {
      primary: '#1F2937',
      success: '#16A34A',
      warning: '#B45309',
      error: '#DC2626',
      text: '#172033',
      textSecondary: '#5B6472',
      bgBase: '#F6F4EF',
      bgContainer: '#FFFDF8',
      border: '#E5DCCB',
      tableHeader: '#F6EFE2',
    },
    dark: {
      primary: '#D6B46A',
      success: '#22C55E',
      warning: '#FACC15',
      error: '#F87171',
      text: '#F4EFE6',
      textSecondary: '#B4A995',
      bgBase: '#15120D',
      bgContainer: '#1F1A13',
      border: '#3A3022',
      tableHeader: '#17130E',
    },
  },
  c: {
    light: {
      primary: '#111827',
      success: '#16A34A',
      warning: '#D97706',
      error: '#DC2626',
      text: '#111827',
      textSecondary: '#4B5563',
      bgBase: '#F4F6F8',
      bgContainer: '#FFFFFF',
      border: '#E5E7EB',
      tableHeader: '#FAFAFA',
    },
    dark: {
      primary: '#E5E7EB',
      success: '#22C55E',
      warning: '#FBBF24',
      error: '#F87171',
      text: '#E5E7EB',
      textSecondary: '#9CA3AF',
      bgBase: '#101113',
      bgContainer: '#181A1E',
      border: '#2A2D33',
      tableHeader: '#121316',
    },
  },
};

export const buildThemeConfig = (ui: ReturnType<typeof normalizeUiSettings>): ThemeConfig => {
  const token = tokens[ui.themePreset][ui.colorMode];
  const isDark = ui.colorMode === 'dark';
  const isMinimal = ui.themePreset === 'c';
  const radius = isMinimal ? 6 : 8;

  return {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: token.primary,
      colorInfo: token.primary,
      colorSuccess: token.success,
      colorWarning: token.warning,
      colorError: token.error,
      colorText: token.text,
      colorTextSecondary: token.textSecondary,
      colorBgBase: token.bgBase,
      colorBgContainer: token.bgContainer,
      colorBorder: token.border,
      borderRadius: radius,
      borderRadiusLG: radius,
      fontFamily:
        '"Plus Jakarta Sans", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      controlHeight: 36,
      motion: false,
    },
    components: {
      Button: {
        borderRadius: radius,
        controlHeight: 36,
        primaryShadow: isMinimal ? 'none' : `0 10px 22px ${isDark ? 'rgba(0, 0, 0, 0.22)' : 'rgba(15, 23, 42, 0.14)'}`,
      },
      Card: {
        borderRadiusLG: radius,
        boxShadowTertiary: isMinimal ? 'none' : `0 18px 50px ${isDark ? 'rgba(0, 0, 0, 0.28)' : 'rgba(15, 23, 42, 0.08)'}`,
      },
      Input: {
        borderRadius: radius,
        activeBorderColor: token.primary,
        hoverBorderColor: token.primary,
      },
      Layout: {
        bodyBg: 'transparent',
        headerBg: 'transparent',
        siderBg: 'transparent',
        lightSiderBg: 'transparent',
        headerHeight: ui.themePreset === 'c' ? 58 : 60,
      },
      Menu: {
        itemBg: 'transparent',
        itemBorderRadius: radius,
        itemHeight: 40,
        itemMarginInline: 10,
        itemSelectedBg: 'var(--cp-active-bg)',
        itemSelectedColor: 'var(--cp-active-text)',
        itemHoverBg: 'var(--cp-hover-bg)',
      },
      Modal: {
        borderRadiusLG: radius,
      },
      Select: {
        borderRadius: radius,
        controlHeight: 36,
      },
      Table: {
        borderColor: token.border,
        cellPaddingBlock: 10,
        cellPaddingInline: 14,
        headerBg: token.tableHeader,
        headerColor: token.text,
        rowHoverBg: 'var(--cp-row-hover)',
      },
    },
  };
};

export const applyThemeClass = (ui: ReturnType<typeof normalizeUiSettings>) => {
  const root = document.documentElement;
  root.classList.remove(
    'cp-theme-a',
    'cp-theme-b',
    'cp-theme-c',
    'cp-mode-light',
    'cp-mode-dark',
  );
  root.classList.add(`cp-theme-${ui.themePreset}`, `cp-mode-${ui.colorMode}`);
};
