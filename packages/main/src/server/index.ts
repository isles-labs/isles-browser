import type {Express, NextFunction, Request, Response} from 'express';
import type {Server} from 'http';
import {app as electronApp} from 'electron';
import express from 'express';
import cors from 'cors';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {chmod, mkdir, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import IPRouter from './routes/ip';
import WindowRouter from './routes/window';
import ProfilesRouter from './routes/profiles';
import ProxyRouter from './routes/proxy';
import HumanizeRouter from './routes/humanize';
const HOST = '127.0.0.1';
let port = Number(process.env.CLOAK_API_PORT || 49156);
const configuredToken = process.env.CLOAK_LOCAL_API_TOKEN;
const token =
  configuredToken && configuredToken.length >= 32
    ? configuredToken
    : randomBytes(32).toString('hex');

const isTrustedOrigin = (origin?: string) => {
  if (!origin || origin === 'null') return true;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
      (Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === port ||
        (url.protocol === 'http:' && Number(url.port || 80) === 5173))
    );
  } catch {
    return false;
  }
};

export const apiToken = token;
export const getToken = () => token;
export const getPort = () => port;
export const getOrigin = () => `http://${HOST}:${port}`;
const auth = (req: Request, res: Response, next: NextFunction) => {
  const origin = req.get('origin');
  if (!isTrustedOrigin(origin)) {
    res.status(403).json({error: '不允许的请求来源'});
    return;
  }
  if (req.method === 'OPTIONS') {
    next();
    return;
  }
  const supplied = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.get('x-cloak-api-token') || '';
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.status(401).json({error: '本地 API token 无效'});
    return;
  }
  next();
};

export function createServer(): Express {
  const serverApp = express();
  serverApp.disable('x-powered-by');
  serverApp.use(cors({origin: (origin, callback) => callback(null, isTrustedOrigin(origin)), methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Cloak-Api-Token']}));
  serverApp.use(auth);
  serverApp.use(express.json({limit: '1mb'}));
  serverApp.use('/ip', IPRouter);
  serverApp.use('/window', WindowRouter);
  serverApp.use('/profiles', ProfilesRouter);
  serverApp.use('/proxy', ProxyRouter);
  serverApp.use('/humanize', HumanizeRouter);
  serverApp.get('/status', (_req, res) => res.send({status: 'ok', port}));
  serverApp.use((_err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (!res.headersSent) res.status(500).json({error: '服务内部错误'});
  });
  return serverApp;
}

export const app = createServer();
let server: Server;
const listen = () => {
  if (server) return;
  server = app.listen(port, HOST, () => undefined);
  server.on('error', error => {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      port += 1;
      server = undefined as unknown as Server;
      listen();
    }
  });
};

if (!process.env.VITEST) listen();
