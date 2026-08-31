import axios, {type AxiosInstance} from 'axios';
import type {Readable} from 'node:stream';
import {Agent as HttpsAgent} from 'node:https';
import {createLogger} from '../../../shared/utils/logger';
import {SERVICE_LOGGER_LABEL} from '../constants';
import {getCloudSyncConfig} from './config';
import {encodeCloudHeaderValue} from './header-value';
import {isMissingOptionalAccountEndpoint} from './optional-account-endpoint';
import type {CloudSyncConfig} from './types';

const logger = createLogger(SERVICE_LOGGER_LABEL);
const READ_RETRY_DELAYS_MS = [500, 1_500, 3_500];
const sleep = (milliseconds: number) =>
  new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const httpsAgent = new HttpsAgent({
  keepAlive: true,
  maxSockets: 16,
  maxFreeSockets: 8,
  timeout: 30_000,
});

const isTransientNetworkFailure = (error: unknown) => axios.isAxiosError(error) && !error.response;

export class CloudApiClient {
  private config?: CloudSyncConfig;
  private http?: AxiosInstance;

  async getConfig() {
    if (!this.config) {
      this.config = await getCloudSyncConfig();
    }
    return this.config;
  }

  async isEnabled() {
    const config = await this.getConfig();
    return config.enabled;
  }

  async request<T>(
    method: 'get' | 'post' | 'delete' | 'patch',
    path: string,
    data?: unknown,
    options?: {timeout?: number},
  ) {
    const http = await this.getHttp(path.startsWith('/account/'));
    if (!http) {
      return undefined;
    }

    const attempts = method === 'get' ? READ_RETRY_DELAYS_MS.length + 1 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await http.request<T>({
          method,
          url: path,
          data,
          timeout: options?.timeout,
        });
        return response.data;
      } catch (error) {
        if (attempt < attempts && isTransientNetworkFailure(error)) {
          await sleep(READ_RETRY_DELAYS_MS[attempt - 1]);
          continue;
        }
        const config = await this.getConfig();
        if (
          axios.isAxiosError(error) &&
          isMissingOptionalAccountEndpoint(path, error.response?.status)
        ) {
          logger.info(
            `Optional cloud account endpoint is unavailable: ${method.toUpperCase()} ${path}`,
          );
        } else if (axios.isAxiosError(error)) {
          logger.error(`Cloud request failed: ${method.toUpperCase()} ${path}`, {
            status: error.response?.status,
            response: error.response?.data,
            message: error.message,
            workspaceId: config.workspaceId,
            deviceId: config.deviceId,
            hasAccessToken: Boolean(config.accessToken),
          });
        } else {
          logger.error(`Cloud request failed: ${method.toUpperCase()} ${path}`, error);
        }
        throw error;
      }
    }
    throw new Error('Cloud request retry loop ended unexpectedly');
  }

  async refreshConfig() {
    this.config = await getCloudSyncConfig();
    this.http = undefined;
    return this.config;
  }

  async requestStream(
    path: string,
    data?: unknown,
  ): Promise<{stream: Readable; headers: Record<string, string>} | undefined> {
    const http = await this.getHttp();
    if (!http) return undefined;
    const response = await http.post<Readable>(path, data, {
      responseType: 'stream',
      timeout: 60_000,
    });
    return {stream: response.data, headers: response.headers as Record<string, string>};
  }

  async requestBuffer(path: string): Promise<Buffer | undefined> {
    const http = await this.getHttp();
    if (!http) return undefined;
    const response = await http.get<ArrayBuffer>(path, {
      responseType: 'arraybuffer',
      timeout: 60_000,
    });
    return Buffer.from(response.data);
  }

  async uploadBinary(path: string, data: Buffer, headers: Record<string, string>) {
    const http = await this.getHttp();
    if (!http) return undefined;
    const response = await http.put(path, data, {
      headers: {'Content-Type': 'application/octet-stream', ...headers},
      timeout: 60_000,
      maxBodyLength: 4 * 1024 * 1024,
    });
    return response.data as {success?: boolean; complete?: boolean; expected_offset?: number};
  }

  private async getHttp(allowAccountRequest = false) {
    const config = await this.getConfig();
    if (!config.enabled && !(allowAccountRequest && config.apiBaseUrl && config.accessToken)) {
      return undefined;
    }

    if (!this.http) {
      this.http = axios.create({
        baseURL: config.apiBaseUrl,
        timeout: 15000,
        // Cloud sync must talk to the configured service directly. System proxy
        // variables often point to local ports that are not available in the app.
        proxy: false,
        httpsAgent,
        headers: {
          ...(config.accessToken ? {Authorization: `Bearer ${config.accessToken}`} : {}),
          'x-workspace-id': config.workspaceId || '',
          'x-device-id': config.deviceId,
          'x-device-name': encodeCloudHeaderValue(config.deviceName),
          'x-cloak-sync-protocol': String(config.protocolVersion),
          'x-cloak-client-build': process.env.npm_package_version || 'desktop',
        },
      });
    }

    return this.http;
  }
}

export const cloudApiClient = new CloudApiClient();
