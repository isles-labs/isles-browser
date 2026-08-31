import {existsSync, mkdirSync} from 'fs';
import * as winston from 'winston';
import {join} from 'path';
import {app} from 'electron';

// const colorizer = winston.format.colorize();

const formatLogMeta = (item: unknown): string => {
  if (item instanceof Error) {
    return JSON.stringify({
      name: item.name,
      message: item.message,
      stack: item.stack,
      code: (item as NodeJS.ErrnoException).code,
    });
  }

  if (typeof item === 'string') {
    return item;
  }

  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(item, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });
  } catch (error) {
    return String(item);
  }
};

export function createLogger(label: string) {
  const isDevelopment = process.env.NODE_ENV !== 'production';

  if (!winston.loggers.has(label)) {
    const transports: winston.transport[] = [];

    if (isDevelopment) {
      // 开发环境: 同时输出到控制台和文件
      transports.push(new winston.transports.Console({level: 'debug'}));
    }

    // 文件输出（开发和生产环境都有）
    const logsPath = join(app.getPath('userData'), 'logs');
    if (!existsSync(logsPath)) {
      mkdirSync(logsPath, {recursive: true});
    }
    if (!existsSync(join(logsPath, label))) {
      mkdirSync(join(logsPath, label));
    }
    console.log('Logger path', logsPath);
    const date = new Date();

    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const formattedDate = `${year}-${month.toString().padStart(2, '0')}-${day
      .toString()
      .padStart(2, '0')}`;
    // 定义日志文件的位置，每天记录一个日志文件
    const logFile = join(logsPath, label, `${formattedDate}.log`);
    // 生产环境: 所有日志都输出到文件
    transports.push(new winston.transports.File({level: 'info', filename: logFile}));

    winston.loggers.add(label, {
      transports: transports,
      format: winston.format.combine(
        winston.format.label({label}),
        winston.format.timestamp({format: 'YYYY-MM-DD HH:mm:ss'}),
        winston.format.printf(info => {
          const {timestamp, level, message, [Symbol.for('splat')]: splat} = info;
          const metaString =
            splat && Array.isArray(splat) && splat.length
              ? splat.map(item => formatLogMeta(item)).join(' ')
              : '';
          const formattedMessage = `${message} ${metaString}`.trim();
          return `${label} | ${timestamp} - ${level}: ${formattedMessage}`;
        }),
      ),
    });
  }
  return winston.loggers.get(label);
}
