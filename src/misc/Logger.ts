import * as winston from 'winston';
import { config } from '../config/config';

const timestampFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
);

const logger = winston.createLogger({
  level: config.log.level,
  format: timestampFormat,
  defaultMeta: {},
  transports: [new winston.transports.Console()]
});

export { logger };
