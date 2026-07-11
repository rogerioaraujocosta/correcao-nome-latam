import { loadConfig } from './config.js'
import { JobStore } from './job-store.js'
import { initializeLocalStorage } from './local-storage.js'
import { createLogger } from './logger.js'
import { acquirePidLock } from './pid-lock.js'
import { paths as defaultPaths } from './paths.js'
import { ensureWebhookToken } from './token.js'
import { runTunnel } from './tunnel.js'
import { ensurePrivateDirectory, redactError } from './utils.js'
import { createWebhookApp, listenWebhook } from './webhook-server.js'
import { WhatsAppClient } from './whatsapp-client.js'
import { WorkflowEngine } from './workflow-engine.js'

function closeServer(server) {
  if (!server) return Promise.resolve()
  return new Promise((resolve) => {
    server.close(() => resolve())
    setTimeout(() => {
      server.closeAllConnections?.()
      resolve()
    }, 5_000).unref?.()
  })
}

export async function startBot({
  appPaths = defaultPaths,
  logger = createLogger(),
  tunnelFactory = runTunnel,
  whatsappFactory = (options) => new WhatsAppClient(options),
} = {}) {
  await initializeLocalStorage(appPaths)
  const releasePid = await acquirePidLock(appPaths)
  let server
  let whatsapp
  let engine
  let cleanupInterval
  let publicTunnel
  let stopped = false
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })

  try {
    const config = await loadConfig(appPaths, { requireNumber: true })
    const token = await ensureWebhookToken(appPaths)
    const store = await new JobStore(appPaths).load()
    await store.cleanup(config.storage.retentionDays)
    cleanupInterval = setInterval(() => {
      void store.cleanup(config.storage.retentionDays).catch((error) => {
        logger.warn({ error: redactError(error) }, 'Falha na limpeza periódica de dados concluídos')
      })
    }, 6 * 60 * 60 * 1000)
    cleanupInterval.unref?.()
    await ensurePrivateDirectory(appPaths.auth)

    whatsapp = whatsappFactory({
      authDirectory: appPaths.auth,
      targetNumber: config.whatsapp.monitoredNumber,
      reconnect: config.whatsapp.reconnect,
      onConnectionChange: async (connected, status) => {
        if (connected) {
          logger.info({ event: 'whatsapp_connected' }, 'WhatsApp conectado')
        } else {
          logger.warn({ event: 'whatsapp_disconnected', action: status.action, reason: status.reason }, 'WhatsApp desconectado')
        }
        await engine?.setConnected(connected)
      },
      onMessage: async (message) => {
        try {
          const result = await engine?.handleInbound(message)
          if (result?.accepted) {
            logger.info({ event: 'inbound_accepted', stepId: result.stepId, ruleId: result.ruleId }, 'Resposta da LATAM aceita pelo fluxo')
          } else if (result?.reason === 'processing_notice') {
            logger.info({ event: 'processing_notice_ignored', stepId: result.stepId }, 'Aviso de processamento ignorado conforme a regra; aguardando validacao de identidade')
          } else {
            logger.info({ event: 'inbound_ignored', reason: result?.reason }, 'Resposta da LATAM recebida, mas o matcher nao liberou o passo')
          }
        } catch (error) {
          logger.error({ error: redactError(error) }, 'Falha ao avançar o fluxo; o trabalho foi preservado')
        }
      },
      onOwnMessage: async (message) => {
        try {
          await engine?.handleOwnOutbound(message)
        } catch (error) {
          logger.error({ error: redactError(error) }, 'Falha ao registrar intervenção manual')
        }
      },
      onError: ({ code }) => logger.warn({ code }, 'Evento interno do transporte WhatsApp'),
      onDiagnostic: ({ reason }) => logger.info({ event: 'whatsapp_message_ignored', reason }, 'Evento do WhatsApp ignorado antes do workflow'),
    })

    engine = new WorkflowEngine({ store, whatsapp, config, logger })
    await engine.initialize()

    const webhookApp = createWebhookApp({ config, token, store, engine, logger })
    server = await listenWebhook(webhookApp, config)

    logger.info(
      { host: config.server.host, port: config.server.port },
      'Webhook pronto em /webhooks/name-correction e /api/jobs',
    )
    if (!['127.0.0.1', '::1', 'localhost'].includes(config.server.host)) {
      logger.warn('O servidor não está limitado ao computador local. Use firewall, TLS e rotação do token.')
    }

    publicTunnel = await tunnelFactory({ config, token })

    await whatsapp.start()

    const stop = async (reason = 'requested') => {
      if (stopped) return done
      stopped = true
      logger.info({ reason }, 'Encerrando o bot')
      if (cleanupInterval) clearInterval(cleanupInterval)
      await engine.stop().catch(() => {})
      await publicTunnel?.close().catch(() => {})
      await closeServer(server)
      await whatsapp.stop().catch(() => {})
      await releasePid().catch(() => {})
      resolveDone()
      return done
    }

    return { config, token, store, engine, whatsapp, server, publicTunnel, stop, done }
  } catch (error) {
    if (cleanupInterval) clearInterval(cleanupInterval)
    await publicTunnel?.close().catch(() => {})
    await closeServer(server).catch(() => {})
    await whatsapp?.stop().catch(() => {})
    await releasePid().catch(() => {})
    throw error
  }
}

export async function runBot(options = {}) {
  const controller = await startBot(options)
  const handleSignal = (signal) => {
    void controller.stop(signal)
  }
  process.once('SIGINT', handleSignal)
  process.once('SIGTERM', handleSignal)
  await controller.done
  process.removeListener('SIGINT', handleSignal)
  process.removeListener('SIGTERM', handleSignal)
}
