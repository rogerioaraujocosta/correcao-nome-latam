import assert from 'node:assert/strict'
import test from 'node:test'

import { assertLocalWebhookReady, localServerUrl, publicWebhookUrl, startupSummary } from '../src/tunnel.js'

test('monta as URLs local e pública do webhook sem duplicar barras', () => {
  assert.equal(localServerUrl({ server: { host: '127.0.0.1', port: 3000 } }), 'http://127.0.0.1:3000')
  assert.equal(localServerUrl({ server: { host: '0.0.0.0', port: 4567 } }), 'http://127.0.0.1:4567')
  assert.equal(publicWebhookUrl('https://exemplo.trycloudflare.com/'), 'https://exemplo.trycloudflare.com/webhooks/name-correction')
})

test('recusa abrir o túnel quando o webhook local não está disponível', async () => {
  await assert.rejects(
    assertLocalWebhookReady('http://127.0.0.1:3000', async () => { throw new Error('offline') }),
    /Inicie-o primeiro com: npm start/,
  )
})

test('aceita o webhook local quando health responde com sucesso', async () => {
  let requestedUrl
  await assertLocalWebhookReady('http://127.0.0.1:3000', async (url) => {
    requestedUrl = url
    return { ok: true, status: 200 }
  })
  assert.equal(requestedUrl, 'http://127.0.0.1:3000/health')
})

test('mostra endpoint, token, número monitorado e payload sem PDF no terminal', () => {
  const token = 'a'.repeat(64)
  const summary = startupSummary({
    publicUrl: 'https://exemplo.trycloudflare.com',
    token,
    config: {
      server: { host: '127.0.0.1', port: 3000 },
      whatsapp: { monitoredNumber: '5511999999999' },
    },
  })

  assert.match(summary, /Número monitorado: 5511999999999/)
  assert.match(summary, /Método: POST/)
  assert.match(summary, /https:\/\/exemplo\.trycloudflare\.com\/webhooks\/name-correction/)
  assert.match(summary, new RegExp(`Authorization: Bearer ${token}`))
  assert.match(summary, /"pnr": "QWEBZI"/)
  assert.doesNotMatch(summary, /ticketPdf|ticketFileName|Idempotency-Key: /i)
})
