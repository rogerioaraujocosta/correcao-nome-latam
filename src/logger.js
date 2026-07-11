import pino from 'pino'

const allowedLevels = new Set(['silent', 'fatal', 'error', 'warn', 'info', 'debug'])

export function createLogger() {
  const requested = String(process.env.LOG_LEVEL ?? 'info').toLowerCase()
  const level = allowedLevels.has(requested) ? requested : 'info'
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'token',
        'authorization',
        'headers',
        '*.message',
        '*.text',
        '*.qr',
        '*.jid',
        '*.remoteJid',
        '*.remoteJidAlt',
        '*.payload',
        '*.token',
        '*.authorization',
        '*.headers',
      ],
      censor: '[oculto]',
    },
  })
}
