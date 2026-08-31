export interface OperationResult {
  success: boolean;
  message: string;
  data?: SafeAny;
}

export interface SettingOptions {
  profileCachePath: string;
  useLocalChrome: boolean;
  localChromePath: string;
  chromiumBinPath: string;
  avatarPath?: string;
  runtimeDownload?: {
    /** Optional HTTP(S) or SOCKS proxy used for browser runtime and extension downloads. */
    proxyUrl?: string;
  };
  cloudSync?: {
    enabled?: boolean;
    apiBaseUrl?: string;
    accessToken?: string;
    workspaceId?: string;
    userId?: string;
    deviceId?: string;
    deviceName?: string;
    protocolVersion?: 1 | 2;
  };
  ui?: {
    themePreset?: 'a' | 'b' | 'c';
    colorMode?: 'light' | 'dark';
  };
  automationConnect: boolean;
}

export type NoticeType = 'info' | 'success' | 'error' | 'warning' | 'loading';

export interface BridgeMessage {
  type: NoticeType;
  text: string;
}
