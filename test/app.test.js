import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startBot } from '../src/app.js'
import { loadDefaultConfig, saveConfig } from '../src/config.js'
import { initializeLocalStorage } from '../src/local-storage.js'
import { createPaths } from '../src/paths.js'

const QUIET_LOGGER = { info() {}, warn() {}, error() {} }

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('npm start inicia e encerra o túnel junto com o webhook', async (t) => {
  const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'latam-bot-app-'))
  const appPaths = createPaths({ localDirectory })
  await initializeLocalStorage(appPaths)
  const config = structuredClone(await loadDefaultConfig(appPaths))
  config.whatsapp.monitoredNumber = '5511999999999'
  config.server.port = await availablePort()
  await saveConfig(appPaths, config)

  let tunnelStarted = false
  let tunnelClosed = false
  let whatsappStopped = false

  const controller = await startBot({
    appPaths,
    logger: QUIET_LOGGER,
    tunnelFactory: async ({ config: activeConfig, token }) => {
      const response = await fetch(`http://127.0.0.1:${activeConfig.server.port}/health`)
      assert.equal(response.status, 200)
      assert.match(token, /^[a-f0-9]{64}$/)
      tunnelStarted = true
      return { close: async () => { tunnelClosed = true } }
    },
    whatsappFactory: (options) => ({
      async start() { await options.onConnectionChange(true, { action: 'none', reason: 'test' }) },
      async stop() { whatsappStopped = true },
      async sendText() { return { key: { id: 'test-text' } } },
      async sendDocument() { return { key: { id: 'test-document' } } },
    }),
  })

  assert.equal(tunnelStarted, true)
  await controller.stop('test')
  assert.equal(tunnelClosed, true)
  assert.equal(whatsappStopped, true)

  t.after(async () => {
    await controller.stop('cleanup')
    await fs.rm(localDirectory, { recursive: true, force: true })
  })
})
