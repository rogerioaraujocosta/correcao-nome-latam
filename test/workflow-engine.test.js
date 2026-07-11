import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadDefaultConfig } from '../src/config.js'
import { JobStore } from '../src/job-store.js'
import { createPaths } from '../src/paths.js'
import { WorkflowEngine } from '../src/workflow-engine.js'

const TARGET_NUMBER = '5511999999999'
const QUIET_LOGGER = { info() {}, warn() {}, error() {} }
const IDENTITY_REQUEST = 'Perfeito! Vou ajudá-lo a corrigir o nome na sua reserva. Para validar sua identidade, preciso de um dos seguintes dados:'

class MockWhatsApp {
  constructor() {
    this.texts = []
    this.documents = []
    this.sequence = 0
  }

  async sendText(text) {
    this.texts.push(text)
    this.sequence += 1
    return { key: { id: `out-${this.sequence}` } }
  }

  async sendDocument(source, options) {
    this.documents.push({ source, options })
    this.sequence += 1
    return { key: { id: `out-${this.sequence}` } }
  }
}

async function createHarness(t, mutateWorkflow) {
  const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'latam-bot-engine-'))
  const appPaths = createPaths({ localDirectory })
  const config = structuredClone(await loadDefaultConfig(appPaths))
  config.whatsapp.monitoredNumber = TARGET_NUMBER
  mutateWorkflow?.(config.workflow)

  const store = await new JobStore(appPaths).load()
  const attachmentPath = await store.savePdf('job-flow', Buffer.from('%PDF-1.7\nflow'))
  const { job } = await store.createJob({
    id: 'job-flow',
    requestId: 'request-flow',
    payload: {
      pnr: 'QWEBZI',
      currentName: 'JANDELA',
      correctName: 'DANIELA',
      ticketFileName: 'bilhete.pdf',
    },
    attachmentPath,
    workflow: config.workflow,
    targetNumber: TARGET_NUMBER,
  })

  const whatsapp = new MockWhatsApp()
  const engine = new WorkflowEngine({ store, whatsapp, config, logger: QUIET_LOGGER })
  await engine.initialize()

  t.after(async () => {
    await engine.stop()
    await fs.rm(localDirectory, { recursive: true, force: true })
  })
  return { appPaths, config, store, whatsapp, engine, job }
}

function inbound(id, fromNumber = TARGET_NUMBER, text = IDENTITY_REQUEST) {
  return { id, fromNumber, text, eligible: true }
}

async function waitForStatus(store, jobId, expected, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await store.getJob(jobId)
    if (job?.status === expected) return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return store.getJob(jobId)
}

test('executa o fluxo completo em ordem e conclui somente após a resposta final', async (t) => {
  const { store, whatsapp, engine } = await createHarness(t)
  await engine.setConnected(true)

  assert.deepEqual(whatsapp.texts, ['Olá'])

  for (let index = 1; index <= 5; index += 1) {
    const result = await engine.handleInbound(inbound(`in-${index}`))
    assert.equal(result.accepted, true)
    assert.equal(result.completed, false)
  }

  assert.deepEqual(whatsapp.texts, [
    'Olá',
    'Preciso corrigir uma letra de um nome na reserva',
    'QWEBZI',
    'JANDELA',
    'DANIELA',
    'SIM',
  ])
  assert.equal(whatsapp.documents.length, 0)

  const waiting = await store.getJob('job-flow')
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.workflow.steps[waiting.cursor].id, 'final_confirmation')

  const final = await engine.handleInbound(inbound('in-6', TARGET_NUMBER, 'protocolo criado'))
  assert.deepEqual(final, { accepted: true, completed: true, jobId: 'job-flow' })
  assert.equal((await store.getJob('job-flow')).status, 'completed')
})

test('ignora remetente errado e não consome o próximo passo', async (t) => {
  const { store, whatsapp, engine } = await createHarness(t)
  await engine.setConnected(true)

  const result = await engine.handleInbound(inbound('wrong-1', '5511888888888'))

  assert.deepEqual(result, { accepted: false, reason: 'sender' })
  assert.deepEqual(whatsapp.texts, ['Olá'])
  assert.equal((await store.getJob('job-flow')).cursor, 1)
})

test('ignora aviso de processamento e só envia o motivo após a solicitação de identidade', async (t) => {
  const { store, whatsapp, engine } = await createHarness(t)
  await engine.setConnected(true)

  const ignored = await engine.handleInbound({
    id: 'processing-notice',
    fromNumber: TARGET_NUMBER,
    text: 'Obrigado por aguardar na linha. Estou processando sua solicitação e isso pode levar alguns segundos.',
  })
  assert.deepEqual(ignored, { accepted: false, reason: 'matcher' })
  assert.deepEqual(whatsapp.texts, ['Olá'])
  assert.equal((await store.getJob('job-flow')).cursor, 1)

  const accepted = await engine.handleInbound({
    id: 'identity-request',
    fromNumber: TARGET_NUMBER,
    text: `Perfeito! Vou ajudá-lo a corrigir o nome na sua reserva. Para validar sua identidade, preciso de um dos seguintes dados:

- Endereço de email
- Número de viajante frequente (LATAM Pass)
- Número do pedido ou código de reserva (PNR)`,
  })
  assert.equal(accepted.accepted, true)
  assert.deepEqual(whatsapp.texts, ['Olá', 'Preciso corrigir uma letra de um nome na reserva'])
})

test('responde Sim e finaliza ao detectar encaminhamento por passageiro bebê com dados variáveis', async (t) => {
  const { store, whatsapp, engine } = await createHarness(t)
  await engine.setConnected(true)
  await engine.handleInbound(inbound('identity'))
  await engine.handleInbound(inbound('after-reason', TARGET_NUMBER, 'Informe seu código de reserva'))

  const result = await engine.handleInbound(inbound('infant-handoff', TARGET_NUMBER, `Perfeito! Validei sua reserva ZX9K2P.

Nome atual: Maria de Souza Silva
Status: Solicitação em análise
Motivo: Esta reserva inclui um passageiro menor de 2 anos (bebê). Para corrigir o nome em reservas com bebês, você precisará da ajuda de um agente.

Gostaria que eu conecte você com um agente especializado para ajudá-lo com a alteração da reserva?`))

  assert.deepEqual(result, {
    accepted: true,
    completed: true,
    jobId: 'job-flow',
    ruleId: 'infant_agent_handoff',
  })
  assert.deepEqual(whatsapp.texts, [
    'Olá',
    'Preciso corrigir uma letra de um nome na reserva',
    'QWEBZI',
    'Sim',
  ])
  const completed = await store.getJob('job-flow')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.pendingStepId, null)
  assert.equal(completed.history.at(-1).event, 'conditional_rule_completed')

  const later = await engine.handleInbound(inbound('after-completion', TARGET_NUMBER, 'Qual é o nome correto?'))
  assert.deepEqual(later, { accepted: false, reason: 'no_waiting_job' })
  assert.equal(whatsapp.texts.at(-1), 'Sim')
})

test('deduplica uma mensagem recebida mesmo após avançar de passo', async (t) => {
  const { store, whatsapp, engine } = await createHarness(t)
  await engine.setConnected(true)

  assert.equal((await engine.handleInbound(inbound('same-id'))).accepted, true)
  const duplicate = await engine.handleInbound(inbound('same-id'))

  assert.deepEqual(duplicate, { accepted: false, reason: 'duplicate' })
  assert.deepEqual(whatsapp.texts, [
    'Olá',
    'Preciso corrigir uma letra de um nome na reserva',
  ])
  assert.deepEqual((await store.getJob('job-flow')).consumedInboundIds, ['same-id'])
})

test('deduplica globalmente uma mensagem reapresentada em um trabalho posterior', async (t) => {
  const { appPaths, config, store, whatsapp, engine } = await createHarness(t)
  await engine.setConnected(true)

  for (let index = 1; index <= 6; index += 1) {
    await engine.handleInbound(inbound(`global-${index}`))
  }
  assert.equal((await store.getJob('job-flow')).status, 'completed')

  const attachmentPath = await store.savePdf('job-second', Buffer.from('%PDF-1.7\nsecond'))
  const { job: second } = await store.createJob({
    id: 'job-second',
    requestId: 'request-second',
    payload: {
      pnr: 'ABC123',
      currentName: 'NOME UM',
      correctName: 'NOME DOIS',
      ticketFileName: 'segundo.pdf',
    },
    attachmentPath,
    workflow: config.workflow,
    targetNumber: TARGET_NUMBER,
  })
  await engine.enqueue(second)
  const before = whatsapp.texts.length

  const duplicate = await engine.handleInbound(inbound('global-6'))

  assert.deepEqual(duplicate, { accepted: false, reason: 'duplicate' })
  assert.equal(whatsapp.texts.length, before)
  assert.equal((await store.getJob('job-second')).cursor, 1)
  assert.equal(path.dirname(attachmentPath), appPaths.uploads)
})

test('bloqueia envio quando o número ativo diverge do snapshot do trabalho', async (t) => {
  const { config, store, whatsapp, engine } = await createHarness(t)
  config.whatsapp.monitoredNumber = '5511888888888'

  await engine.setConnected(true)

  assert.deepEqual(whatsapp.texts, [])
  const job = await store.getJob('job-flow')
  assert.equal(job.status, 'failed')
  assert.match(job.error, /não corresponde/)
})

test('trabalho vencido na fila não envia a saudação', async (t) => {
  const { store, whatsapp, engine } = await createHarness(t)
  await store.transact((state) => {
    state.jobs[0].createdAt = '2000-01-01T00:00:00.000Z'
  })

  await engine.setConnected(true)

  assert.deepEqual(whatsapp.texts, [])
  assert.equal((await store.getJob('job-flow')).status, 'timed_out')
})

test('mensagem própria com ID registrado pelo bot não pausa o trabalho', async (t) => {
  const { store, engine } = await createHarness(t)
  await engine.setConnected(true)

  const result = await engine.handleOwnOutbound({ id: 'out-1' })

  assert.deepEqual(result, { paused: false, reason: 'bot_message' })
  assert.equal((await store.getJob('job-flow')).status, 'waiting')
})

test('mensagem própria desconhecida pausa e resume-waiting restaura a espera', async (t) => {
  const { store, whatsapp, engine } = await createHarness(t)
  await engine.setConnected(true)

  const intervention = await engine.handleOwnOutbound({ id: 'manual-out-1' })
  assert.deepEqual(intervention, { paused: true, jobId: 'job-flow' })
  assert.equal((await store.getJob('job-flow')).status, 'manual_intervention')

  const resumed = await engine.resolveJob('job-flow', 'resume-waiting')
  assert.equal(resumed.status, 'waiting')
  assert.equal(resumed.error, null)
  assert.equal(resumed.cursor, 1)
  assert.deepEqual(whatsapp.texts, ['Olá'])
})

test('pausa em timed_out sem reenviar o passo', async (t) => {
  const { store, whatsapp, engine } = await createHarness(t, (workflow) => {
    workflow.stepTimeoutMinutes = 0.0002
    workflow.jobTimeoutMinutes = 1
  })
  await engine.setConnected(true)

  const timedOut = await waitForStatus(store, 'job-flow', 'timed_out')

  assert.equal(timedOut.status, 'timed_out')
  assert.match(timedOut.error, /Tempo de espera excedido/)
  assert.deepEqual(whatsapp.texts, ['Olá'])
})
