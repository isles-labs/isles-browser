import WebSocket from 'ws';
import type {SafeAny} from '../../../shared/types/db';
import api from '../../../shared/api/api';

const HOST = '127.0.0.1';
const CONNECT_TIMEOUT_MS = 10000;
const COMMAND_TIMEOUT_MS = 15000;
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

interface PendingCommand {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: SafeAny) => void;
  timer: NodeJS.Timeout;
}

/**
 * Minimal browser-scoped CDP client.
 *
 * Deliberately avoids `puppeteer.connect()`: puppeteer attaches a session to every
 * page target and enables the Runtime/Page/Network domains on them. Anti-bot
 * services (Cloudflare Turnstile, reCAPTCHA) probe for exactly that, so an
 * attached session on a tab the user is browsing in raises the challenge rate.
 *
 * Cookie sync only needs the browser-scoped `Storage` domain, which is served by
 * the root session and never touches a page target.
 */
export class BrowserCdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', raw => this.handleMessage(raw));
    socket.on('close', () => this.failAll(new Error('CDP socket closed')));
    socket.on('error', error => this.failAll(error as Error));
  }

  static async connect(port: number) {
    const {data} = await api.get(`http://${HOST}:${port}/json/version`);
    const endpoint = data?.webSocketDebuggerUrl;
    if (!endpoint) {
      throw new Error(`Browser on port ${port} exposed no webSocketDebuggerUrl`);
    }

    const socket = new WebSocket(endpoint, {
      perMessageDeflate: false,
      maxPayload: MAX_PAYLOAD_BYTES,
    });

    try {
      await waitForOpen(socket);
    } catch (error) {
      socket.terminate();
      throw error;
    }

    socket.removeAllListeners('open');
    socket.removeAllListeners('error');
    return new BrowserCdpClient(socket);
  }

  send<T = SafeAny>(method: string, params: Record<string, SafeAny> = {}): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP socket is not open (${method})`));
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, {method, resolve: resolve as PendingCommand['resolve'], reject, timer});
      this.socket.send(JSON.stringify({id, method, params}), error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('CDP client closed'));
    try {
      this.socket.close();
    } catch {
      this.socket.terminate();
    }
  }

  private handleMessage(raw: WebSocket.RawData) {
    let message: SafeAny;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Browser-scoped commands are the only thing sent, so anything without an id
    // is an event we never subscribed to and can be dropped.
    if (typeof message?.id !== 'number') return;

    const command = this.pending.get(message.id);
    if (!command) return;

    this.pending.delete(message.id);
    clearTimeout(command.timer);

    if (message.error) {
      command.reject(new Error(`${command.method} failed: ${message.error.message || 'unknown error'}`));
      return;
    }

    command.resolve(message.result || {});
  }

  private failAll(error: Error) {
    for (const [id, command] of this.pending) {
      this.pending.delete(id);
      clearTimeout(command.timer);
      command.reject(error);
    }
  }
}

export const withBrowserCdp = async <T>(port: number, run: (client: BrowserCdpClient) => Promise<T>) => {
  const client = await BrowserCdpClient.connect(port);
  try {
    return await run(client);
  } finally {
    client.close();
  }
};

const waitForOpen = (socket: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connect timed out')), CONNECT_TIMEOUT_MS);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error as Error);
    });
  });
