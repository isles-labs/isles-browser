export interface ChromeDevToolsVersion {
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

export interface ChromeDevToolsResponse {
  status: number;
  data: ChromeDevToolsVersion;
}

interface WaitForChromeDevToolsOptions {
  port: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  request: (url: string, timeoutMs: number) => Promise<ChromeDevToolsResponse>;
  onRetry?: (error: unknown, attempt: number) => void;
}

const HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 5_000;

export async function waitForChromeDevTools({
  port,
  maxAttempts = 60,
  retryDelayMs = 500,
  request,
  onRetry,
}: WaitForChromeDevToolsOptions): Promise<ChromeDevToolsVersion> {
  const url = `http://${HOST}:${port}/json/version`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await request(url, REQUEST_TIMEOUT_MS);
      if (response.status === 200 && typeof response.data?.webSocketDebuggerUrl === 'string') {
        return response.data;
      }
      onRetry?.(new Error('DevTools endpoint has not exposed a WebSocket address yet'), attempt);
    } catch (error) {
      onRetry?.(error, attempt);
    }

    if (attempt < maxAttempts && retryDelayMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(
    `Chrome DevTools did not become ready on port ${port} within the startup timeout`,
  );
}
