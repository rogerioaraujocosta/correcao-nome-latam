import { loadConfig } from './config.js'
import { paths } from './paths.js'
import { readWebhookToken } from './token.js'

export function localServerUrl(config) {
  const host = ['0.0.0.0', '::'].includes(config.server.host) ? '127.0.0.1' : config.server.host
  return `http://${host}:${config.server.port}`
}

export function publicWebhookUrl(publicUrl) {
  return `${String(publicUrl).replace(/\/+$/, '')}/webhooks/name-correction`
}

export function startupSummary({ publicUrl, token, config }) {
  const webhookUrl = publicWebhookUrl(publicUrl)
  const examplePayload = {
    pnr: 'QWEBZI',
    currentName: 'NOME ATUAL DO PASSAGEIRO',
    correctName: 'NOME CORRETO DO PASSAGEIRO',
  }
  return [
    '',
    '============================================================',
    'BOT LATAM PRONTO',
    '============================================================',
    `Número monitorado: ${config.whatsapp.monitoredNumber}`,
    `Servidor local: ${localServerUrl(config)}`,
    'Método: POST',
    `Webhook público: ${webhookUrl}`,
    'Content-Type: application/json',
    `Token: ${token}`,
    `Authorization: Bearer ${token}`,
    '',
    'Payload de exemplo (sem PDF e sem Idempotency-Key):',
    JSON.stringify(examplePayload, null, 2),
    '============================================================',
    'Mantenha este terminal aberto. Para encerrar, pressione Ctrl+C.',
    '',
  ].join('\n')
}

export async function assertLocalWebhookReady(url, fetchImplementation = fetch) {
  let response
  try {
    response = await fetchImplementation(`${url}/health`, {
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    throw new Error(`O servidor local não respondeu em ${url}. Inicie-o primeiro com: npm start`)
  }
  if (!response.ok) {
    throw new Error(`O servidor local respondeu HTTP ${response.status} em ${url}/health.`)
  }
}

export async function notifyTunnelWebhook({ notifyUrl, publicUrl, fetchImplementation = fetch }) {
  if (!notifyUrl) return { sent: false }
  const body = {
    event: 'tunnel_ready',
    webhookUrl: publicWebhookUrl(publicUrl),
    publicBaseUrl: String(publicUrl).replace(/\/+$/, ''),
    generatedAt: new Date().toISOString(),
  }
  let response
  try {
    response = await fetchImplementation(notifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error(`Não foi possível avisar o webhook cadastrado: ${notifyUrl}`)
  }
  if (!response.ok) throw new Error(`O webhook cadastrado respondeu HTTP ${response.status}: ${notifyUrl}`)
  return { sent: true, body }
}

export async function runTunnel(options = {}) {
  const config = options.config ?? await loadConfig(paths, { requireNumber: true })
  const token = options.token ?? await readWebhookToken(paths)
  const localUrl = localServerUrl(config)
  await assertLocalWebhookReady(localUrl, options.fetchImplementation)

  console.log(`Servidor local confirmado em ${localUrl}.`)
  console.log('Na primeira execução, confirme os termos exibidos para baixar o cloudflared oficial.')

  const startTunnel = options.startTunnel ?? (await import('untun')).startTunnel
  const tunnel = await startTunnel({ url: localUrl })
  if (!tunnel) throw new Error('A criação do túnel foi cancelada.')

  const publicUrl = await tunnel.getURL()
  const notifyUrl = config.tunnel?.notifyWebhookUrl
  if (notifyUrl) {
    try {
      await notifyTunnelWebhook({ notifyUrl, publicUrl, fetchImplementation: options.fetchImplementation })
      console.log(`URL atual do túnel enviada para: ${notifyUrl}`)
    } catch (error) {
      console.warn(`Aviso: ${error.message}`)
    }
  }
  console.log(startupSummary({ publicUrl, token, config }))
  return tunnel
}
