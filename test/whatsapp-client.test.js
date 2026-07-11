import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import test from 'node:test'

import { DisconnectReason } from '@whiskeysockets/baileys'

import {
  WhatsAppClient,
  calculateReconnectDelay,
  classifyDisconnect,
  getDisconnectStatusCode,
  messageMatchesTarget,
  normalizePhoneNumber,
  phoneNumberToJid,
} from '../src/whatsapp-client.js'

const TARGET_NUMBER = '5511999999999'
const TARGET_JID = `${TARGET_NUMBER}@s.whatsapp.net`

function createMessage({
  id = 'message-1',
  remoteJid = TARGET_JID,
  remoteJidAlt,
  fromMe = false,
  message = { conversation: 'Resposta da LATAM' },
} = {}) {
  return {
    key: { id, remoteJid, remoteJidAlt, fromMe },
    message,
  }
}

function createFakeSocket({ mappedPhoneJid, logoutError } = {}) {
  const calls = {
    end: 0,
    logout: 0,
    mappings: [],
    sent: [],
  }

  const socket = {
    ev: new EventEmitter(),
    signalRepository: {
      lidMapping: {
        async getPNForLID(lid) {
          calls.mappings.push(lid)
          return typeof mappedPhoneJid === 'function'
            ? mappedPhoneJid(lid)
            : mappedPhoneJid
        },
      },
    },
    async sendMessage(jid, content) {
      calls.sent.push({ jid, content })
      return { key: { id: `outbound-${calls.sent.length}` } }
    },
    async end() {
      calls.end += 1
    },
    async logout() {
      calls.logout += 1
      if (logoutError) throw logoutError
    },
  }

  return { calls, socket }
}

function createHarness(options = {}) {
  const fake = options.fake ?? createFakeSocket()
  const authState = { creds: { registered: true }, keys: {} }
  const authCalls = []
  const socketConfigs = []
  const output = []
  let savedCredentials = 0

  const client = new WhatsAppClient({
    authDirectory: options.authDirectory ?? path.resolve('.local', 'whatsapp-client-test-auth'),
    targetNumber: options.targetNumber ?? TARGET_NUMBER,
    reconnect: {
      enabled: false,
      maxAttempts: 0,
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitterRatio: 0,
      ...options.reconnect,
    },
    output: options.output ?? { write: (value) => output.push(value) },
    qrRenderer: options.qrRenderer ?? (async () => 'QR-MOCK'),
    onQr: options.onQr,
    onConnectionChange: options.onConnectionChange,
    onMessage: options.onMessage,
    onError: options.onError,
    authStateFactory: async (directory) => {
      authCalls.push(directory)
      return {
        state: authState,
        saveCreds: async () => {
          savedCredentials += 1
        },
      }
    },
    socketFactory: (config) => {
      socketConfigs.push(config)
      return fake.socket
    },
  })

  return {
    authCalls,
    authState,
    client,
    fake,
    output,
    savedCredentials: () => savedCredentials,
    socketConfigs,
  }
}

async function drainClient(client) {
  await new Promise((resolve) => setImmediate(resolve))
  await client._connectionOperation
  await client._messageOperation
  await client._credentialsSavePromise
  await new Promise((resolve) => setImmediate(resolve))
}

test('normaliza numero, classifica desconexoes e calcula backoff deterministico', () => {
  assert.equal(normalizePhoneNumber('+55 (11) 99999-9999'), TARGET_NUMBER)
  assert.equal(normalizePhoneNumber('005511999999999'), TARGET_NUMBER)
  assert.equal(phoneNumberToJid(TARGET_NUMBER), TARGET_JID)
  assert.throws(() => normalizePhoneNumber('123'), /8 e 15 digitos/)

  assert.equal(
    getDisconnectStatusCode({ output: { statusCode: DisconnectReason.connectionLost } }),
    DisconnectReason.connectionLost,
  )
  assert.equal(getDisconnectStatusCode({ cause: { status: '503' } }), 503)
  assert.equal(getDisconnectStatusCode(new Error('sem codigo')), undefined)

  assert.equal(classifyDisconnect(DisconnectReason.restartRequired), 'restart')
  assert.equal(classifyDisconnect(DisconnectReason.loggedOut), 'stop')
  assert.equal(classifyDisconnect(DisconnectReason.connectionReplaced), 'stop')
  assert.equal(classifyDisconnect(DisconnectReason.connectionLost), 'retry')
  assert.equal(classifyDisconnect(undefined), 'retry')

  assert.equal(calculateReconnectDelay(0, {
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    jitterRatio: 0,
    random: () => 0.5,
  }), 100)
  assert.equal(calculateReconnectDelay(3, {
    baseDelayMs: 100,
    maxDelayMs: 500,
    jitterRatio: 0,
    random: () => 0.5,
  }), 500)
  assert.equal(calculateReconnectDelay(0, {
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    jitterRatio: 0.2,
    random: () => 0,
  }), 80)
})

test('filtra PN, remoteJidAlt e LID sem aceitar grupo, remetente errado ou mensagem propria', async () => {
  assert.equal(await messageMatchesTarget(createMessage(), TARGET_NUMBER), true)
  assert.equal(await messageMatchesTarget(createMessage({
    remoteJid: '777777777777@lid',
    remoteJidAlt: TARGET_JID,
  }), TARGET_NUMBER), true)

  const mapped = createFakeSocket({ mappedPhoneJid: TARGET_JID })
  assert.equal(await messageMatchesTarget(createMessage({
    remoteJid: '777777777777@lid',
  }), TARGET_NUMBER, mapped.socket), true)
  assert.deepEqual(mapped.calls.mappings, ['777777777777@lid'])

  const wrongMapping = createFakeSocket({ mappedPhoneJid: '5511888888888@s.whatsapp.net' })
  assert.equal(await messageMatchesTarget(createMessage({
    remoteJid: '777777777777@lid',
  }), TARGET_NUMBER, wrongMapping.socket), false)

  assert.equal(await messageMatchesTarget(createMessage({
    remoteJid: '5511888888888@s.whatsapp.net',
  }), TARGET_NUMBER), false)
  assert.equal(await messageMatchesTarget(createMessage({
    remoteJid: '123456-789@g.us',
    remoteJidAlt: TARGET_JID,
  }), TARGET_NUMBER), false)
  assert.equal(await messageMatchesTarget(createMessage({ fromMe: true }), TARGET_NUMBER), false)
})

test('processa somente notify elegivel do alvo e entrega o envelope do engine', async () => {
  const received = []
  const emitted = []
  const harness = createHarness({
    onMessage: async (message) => received.push(message),
  })
  harness.client.on('message', (message) => emitted.push(message))

  await harness.client.start()
  harness.fake.socket.ev.emit('connection.update', { connection: 'open' })
  await drainClient(harness.client)

  harness.fake.socket.ev.emit('messages.upsert', {
    type: 'append',
    messages: [createMessage({ id: 'history' })],
  })
  harness.fake.socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [createMessage({ id: 'own', fromMe: true })],
  })
  harness.fake.socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [createMessage({
      id: 'wrong-sender',
      remoteJid: '5511888888888@s.whatsapp.net',
    })],
  })
  harness.fake.socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [createMessage({
      id: 'protocol',
      message: { protocolMessage: { type: 0 } },
    })],
  })
  harness.fake.socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [createMessage({
      id: 'eligible',
      message: {
        ephemeralMessage: {
          message: { extendedTextMessage: { text: '  Resposta elegivel  ' } },
        },
      },
    })],
  })
  await drainClient(harness.client)

  assert.equal(received.length, 1)
  assert.equal(received[0].id, 'eligible')
  assert.equal(received[0].fromNumber, TARGET_NUMBER)
  assert.equal(received[0].text, '  Resposta elegivel  ')
  assert.equal(received[0].eligible, true)
  assert.equal(Number.isNaN(Date.parse(received[0].observedAt)), false)
  assert.deepEqual(emitted, received)

  await harness.client.stop()
})

test('carimba mensagens do mesmo lote com o mesmo instante local', async () => {
  const received = []
  const harness = createHarness({ onMessage: (message) => received.push(message) })
  await harness.client.start()
  harness.fake.socket.ev.emit('connection.update', { connection: 'open' })
  await drainClient(harness.client)

  harness.fake.socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [createMessage({ id: 'batch-1' }), createMessage({ id: 'batch-2' })],
  })
  await drainClient(harness.client)

  assert.equal(received.length, 2)
  assert.equal(received[0].observedAt, received[1].observedAt)
  await harness.client.stop()
})

test('usa auth mock, salva creds e renderiza QR sem expor o valor bruto na saida', async () => {
  const qrCalls = []
  const onQrArguments = []
  const authDirectory = path.resolve('.local', 'isolated-auth')
  const harness = createHarness({
    authDirectory,
    qrRenderer: async (...arguments_) => {
      qrCalls.push(arguments_)
      return 'ARTE-QR-SEGURA'
    },
    onQr: (...arguments_) => onQrArguments.push(arguments_),
  })

  await harness.client.start()
  assert.deepEqual(harness.authCalls, [authDirectory])
  assert.equal(harness.socketConfigs.length, 1)
  assert.equal(harness.socketConfigs[0].auth, harness.authState)
  assert.equal(harness.socketConfigs[0].logger.level, 'silent')
  assert.equal('printQRInTerminal' in harness.socketConfigs[0], false)
  assert.equal(harness.socketConfigs[0].syncFullHistory, false)
  assert.equal(harness.socketConfigs[0].shouldSyncHistoryMessage({}), false)

  harness.fake.socket.ev.emit('creds.update', {})
  harness.fake.socket.ev.emit('creds.update', {})
  harness.fake.socket.ev.emit('connection.update', { qr: 'SEGREDO-DO-QR' })
  await drainClient(harness.client)

  assert.equal(harness.savedCredentials(), 2)
  assert.deepEqual(qrCalls, [['SEGREDO-DO-QR', { type: 'terminal' }]])
  assert.equal(onQrArguments.length, 1)
  assert.equal(onQrArguments[0].length, 0)
  assert.match(harness.output.join(''), /ARTE-QR-SEGURA/)
  assert.doesNotMatch(harness.output.join(''), /SEGREDO-DO-QR/)

  await harness.client.stop()
})

test('envia texto e PDF apenas ao numero configurado', async () => {
  const harness = createHarness()
  await harness.client.start()
  await assert.rejects(() => harness.client.sendText('antes de conectar'), /ainda nao esta conectado/)

  harness.fake.socket.ev.emit('connection.update', { connection: 'open' })
  await drainClient(harness.client)

  const textResult = await harness.client.sendText('Ola')
  const documentResult = await harness.client.sendDocument('fixtures/ticket.pdf', {
    fileName: '../Bilhete Final',
    caption: 'Documento solicitado',
  })

  assert.equal(textResult.key.id, 'outbound-1')
  assert.equal(documentResult.key.id, 'outbound-2')
  assert.deepEqual(harness.fake.calls.sent[0], {
    jid: TARGET_JID,
    content: { text: 'Ola' },
  })
  assert.equal(harness.fake.calls.sent[1].jid, TARGET_JID)
  assert.deepEqual(harness.fake.calls.sent[1].content.document, {
    url: path.resolve('fixtures/ticket.pdf'),
  })
  assert.equal(harness.fake.calls.sent[1].content.mimetype, 'application/pdf')
  assert.equal(harness.fake.calls.sent[1].content.fileName, 'Bilhete Final.pdf')
  assert.equal(harness.fake.calls.sent[1].content.caption, 'Documento solicitado')

  await harness.client.stop()
})

test('logout bem-sucedido encerra a sessao e falha e propagada sem dado sensivel', async (context) => {
  await context.test('sucesso', async () => {
    const changes = []
    const harness = createHarness({
      onConnectionChange: async (connected, status) => changes.push({ connected, status }),
    })
    await harness.client.start()
    harness.fake.socket.ev.emit('connection.update', { connection: 'open' })
    await drainClient(harness.client)

    await harness.client.logout()

    assert.equal(harness.fake.calls.logout, 1)
    assert.equal(harness.fake.calls.end, 1)
    assert.equal(harness.client.started, false)
    assert.equal(changes.at(-1).connected, false)
    assert.equal(changes.at(-1).status.action, 'stopped')
  })

  await context.test('falha', async () => {
    const errors = []
    const fake = createFakeSocket({
      logoutError: new Error(`credencial-secreta-${TARGET_NUMBER}`),
    })
    const harness = createHarness({
      fake,
      onError: ({ code }) => errors.push(code),
    })
    await harness.client.start()
    fake.socket.ev.emit('connection.update', { connection: 'open' })
    await drainClient(harness.client)

    await assert.rejects(
      () => harness.client.logout(),
      (error) => {
        assert.match(error.message, /desvinculacao remota/)
        assert.doesNotMatch(error.message, /credencial-secreta|5511999999999/)
        return true
      },
    )

    assert.deepEqual(errors, ['logout_failed'])
    assert.equal(fake.calls.logout, 1)
    assert.equal(fake.calls.end, 1)
    assert.equal(harness.client.started, false)
  })
})
