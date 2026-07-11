import crypto from 'node:crypto'
import fs from 'node:fs/promises'

import { atomicWriteFile, pathExists } from './utils.js'

export async function ensureWebhookToken(appPaths) {
  if (!(await pathExists(appPaths.webhookToken))) {
    await atomicWriteFile(appPaths.webhookToken, `${crypto.randomBytes(32).toString('hex')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  }
  return readWebhookToken(appPaths)
}

export async function readWebhookToken(appPaths) {
  const token = (await fs.readFile(appPaths.webhookToken, 'utf8')).trim()
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('O token local do webhook é inválido. Execute novamente o assistente de configuração.')
  }
  return token
}

export function bearerTokenFromRequest(request) {
  const authorization = request.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(authorization)
  return match?.[1]?.trim() ?? ''
}
