import pino from 'pino'
import { config } from './config.js'

// stdout → journald on the VPS. Never log message bodies, OTPs, QR strings or secrets.
export const log = pino({ level: config.logLevel, base: undefined })
