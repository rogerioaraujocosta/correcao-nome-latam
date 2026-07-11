import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ConfigError,
  loadConfig,
  loadDefaultConfig,
  saveConfig,
  validateConfig,
} from '../src/config.js'
import { createPaths } from '../src/paths.js'

const TARGET_NUMBER = '5511999999999'

async function createTemporaryPaths(t) {
  const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'latam-bot-config-'))
  t.after(() => fs.rm(localDirectory, { recursive: true, force: true }))
  return createPaths({ localDirectory })
}

test('a configuração padrão descreve exatamente o fluxo atual', async () => {
  const config = await loadDefaultConfig(createPaths())

  assert.equal(config.schemaVersion, 1)
  assert.equal(config.tunnel.notifyWebhookUrl, '')
  assert.equal(config.whatsapp.monitoredNumber, '')
  assert.deepEqual(
    config.workflow.steps.map((step) => step.id),
    [
      'hello',
      'reason',
      'pnr',
      'current_name',
      'correct_name',
      'confirmation',
      'final_confirmation',
    ],
  )
  assert.equal(config.workflow.steps[0].await.mode, 'job_created')
  assert.equal(config.workflow.steps[0].send.value, 'Olá')
  assert.equal(config.workflow.steps[1].await.mode, 'contains')
  assert.equal(config.workflow.steps[1].await.anyOf[0], 'Como posso ajudá-lo hoje')
  assert.equal(config.workflow.steps[2].await.mode, 'contains')
  assert.equal(config.workflow.steps[2].await.anyOf[0], 'Para validar sua identidade')
  assert.equal(config.workflow.inboundRules[0].id, 'infant_agent_handoff')
  assert.deepEqual(config.workflow.inboundRules[0].match.allOf.length, 2)
  assert.equal(config.workflow.inboundRules[0].send.value, 'Sim')
  assert.equal(
    config.workflow.steps[1].send.value,
    'Preciso corrigir uma letra de um nome na reserva',
  )
  assert.equal(config.workflow.steps[5].send.value, 'SIM')
  assert.equal(config.workflow.steps.at(-1).terminal, 'success')
})

test('valida o webhook HTTPS opcional que recebe a URL do túnel', async () => {
  const config = structuredClone(await loadDefaultConfig(createPaths()))
  config.tunnel.notifyWebhookUrl = 'https://automacao.example/webhooks/tunnel'
  assert.doesNotThrow(() => validateConfig(config))

  config.tunnel.notifyWebhookUrl = 'http://automacao.example/inseguro'
  assert.throws(() => validateConfig(config), /URL HTTPS/)
})

test('o número é obrigatório ao iniciar e templates desconhecidos são recusados', async () => {
  const config = await loadDefaultConfig(createPaths())

  assert.throws(
    () => validateConfig(config, { requireNumber: true }),
    (error) => error instanceof ConfigError
      && error.message.includes('monitoredNumber ainda não foi configurado'),
  )

  const unknownTemplate = structuredClone(config)
  unknownTemplate.workflow.steps[1].send.value = 'Valor {{segredo}}'
  assert.throws(
    () => validateConfig(unknownTemplate),
    (error) => error instanceof ConfigError
      && error.message.includes('variável desconhecida {{segredo}}'),
  )

  const invalidRegex = structuredClone(config)
  invalidRegex.workflow.steps[1].await = { mode: 'regex', anyOf: ['('] }
  assert.throws(
    () => validateConfig(invalidRegex),
    (error) => error instanceof ConfigError && error.message.includes('regex inválida'),
  )

  const unsafeRegex = structuredClone(config)
  unsafeRegex.workflow.steps[1].await = { mode: 'regex', anyOf: ['(a+)+$'] }
  assert.throws(
    () => validateConfig(unsafeRegex),
    (error) => error instanceof ConfigError && error.message.includes('potencialmente excessiva'),
  )
})

test('uma edição persistida do texto e do número é usada no próximo carregamento', async (t) => {
  const appPaths = await createTemporaryPaths(t)
  const edited = structuredClone(await loadDefaultConfig(appPaths))
  edited.whatsapp.monitoredNumber = TARGET_NUMBER
  edited.workflow.steps.find((step) => step.id === 'reason').send.value = 'Motivo atualizado pelo usuário'

  await saveConfig(appPaths, edited)
  const loaded = await loadConfig(appPaths, { requireNumber: true })

  assert.equal(loaded.whatsapp.monitoredNumber, TARGET_NUMBER)
  assert.equal(
    loaded.workflow.steps.find((step) => step.id === 'reason').send.value,
    'Motivo atualizado pelo usuário',
  )
  assert.equal(loaded.server.port, 3000)
})
