import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'

import { loadDefaultConfig } from '../src/config.js'
import { JobStore } from '../src/job-store.js'
import { createPaths } from '../src/paths.js'
import { createWebhookApp } from '../src/webhook-server.js'
import { WorkflowEngine } from '../src/workflow-engine.js'

const TARGET_NUMBER = '5511999999999'
const TOKEN = 'a'.repeat(64)
const AUTHORIZATION = `Bearer ${TOKEN}`
const QUIET_LOGGER = { info() {}, warn() {}, error() {} }
const VALID_PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF')

class MockWhatsApp {
  constructor() {
    this.texts = []
    this.documents = []
    this.sequence = 0
  }

  async sendText(text) {
    this.texts.push(text)
    this.sequence += 1
    return { key: { id: `webhook-out-${this.sequence}` } }
  }

  async sendDocument(source, options) {
    this.documents.push({ source, options })
    this.sequence += 1
    return { key: { id: `webhook-out-${this.sequence}` } }
  }
}

async function createHarness(t) {
  const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'latam-bot-webhook-'))
  const appPaths = createPaths({ localDirectory })
  const config = structuredClone(await loadDefaultConfig(appPaths))
  config.whatsapp.monitoredNumber = TARGET_NUMBER
  const store = await new JobStore(appPaths).load()
  const whatsapp = new MockWhatsApp()
  const engine = new WorkflowEngine({ store, whatsapp, config, logger: QUIET_LOGGER })
  await engine.initialize()
  await engine.setConnected(true)
  const app = createWebhookApp({ config, token: TOKEN, store, engine, logger: QUIET_LOGGER })

  t.after(async () => {
    await engine.stop()
    await fs.rm(localDirectory, { recursive: true, force: true })
  })
  return { appPaths, config, store, whatsapp, engine, app }
}

function validJobRequest(app, requestId = 'webhook-request-0001') {
  return request(app)
    .post('/api/jobs')
    .set('Authorization', AUTHORIZATION)
    .set('Idempotency-Key', requestId)
    .field('pnr', 'qwebzi')
    .field('currentName', 'JANDELA')
    .field('correctName', 'DANIELA')
    .attach('ticket', VALID_PDF, { filename: 'bilhete.pdf', contentType: 'application/pdf' })
}

test('protege toda a API por token e mantém health público', async (t) => {
  const { app } = await createHarness(t)

  await request(app).get('/health').expect(200, {
    status: 'ok',
    whatsapp: 'connected',
  })
  await request(app).get('/api/jobs').expect(401, { error: 'Token ausente ou inválido.' })
  await request(app)
    .get('/api/jobs')
    .set('Authorization', 'Bearer incorreto')
    .expect(401, { error: 'Token ausente ou inválido.' })
  await request(app)
    .get('/api/jobs')
    .set('Authorization', AUTHORIZATION)
    .expect(200, { jobs: [] })
})

test('cria um trabalho, envia Olá e trata repetição idempotente sem novo envio', async (t) => {
  const { appPaths, store, whatsapp, app } = await createHarness(t)

  const first = await validJobRequest(app).expect(202)
  assert.equal(first.body.created, true)
  assert.equal(first.body.job.status, 'waiting')
  assert.equal(first.body.job.currentStepId, 'reason')
  assert.deepEqual(whatsapp.texts, ['Olá'])

  const second = await validJobRequest(app).expect(200)
  assert.equal(second.body.created, false)
  assert.equal(second.body.job.id, first.body.job.id)
  assert.deepEqual(whatsapp.texts, ['Olá'])
  assert.equal((await store.listJobs()).length, 1)
  assert.equal((await fs.readdir(appPaths.uploads)).length, 1)
})

test('recusa PDF inválido ou ausente sem persistir trabalho', async (t) => {
  const { appPaths, store, app } = await createHarness(t)

  const invalid = await request(app)
    .post('/api/jobs')
    .set('Authorization', AUTHORIZATION)
    .set('Idempotency-Key', 'webhook-invalid-pdf')
    .field('pnr', 'QWEBZI')
    .field('currentName', 'JANDELA')
    .field('correctName', 'DANIELA')
    .attach('ticket', Buffer.from('isto não é PDF'), {
      filename: 'bilhete.pdf',
      contentType: 'application/pdf',
    })
    .expect(400)
  assert.match(invalid.body.error, /PDF válido/)

  const missing = await request(app)
    .post('/api/jobs')
    .set('Authorization', AUTHORIZATION)
    .set('Idempotency-Key', 'webhook-missing-pdf')
    .send({ pnr: 'QWEBZI', currentName: 'JANDELA', correctName: 'DANIELA' })
    .expect(400)
  assert.match(missing.body.error, /Envie o PDF/)

  assert.equal((await store.listJobs()).length, 0)
  assert.deepEqual(await fs.readdir(appPaths.uploads), [])
})
