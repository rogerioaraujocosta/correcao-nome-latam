#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

import { runBot } from './app.js'
import { ConfigError, ensureUserConfig, loadConfig, loadDefaultConfig, saveConfig } from './config.js'
import { JobStore, isTerminalStatus } from './job-store.js'
import { assertSafeManagedChild, initializeLocalStorage } from './local-storage.js'
import { readRunningPid } from './pid-lock.js'
import { paths } from './paths.js'
import { ensureWebhookToken, readWebhookToken } from './token.js'
import { runTunnel } from './tunnel.js'
import {
  assertPathInside,
  maskPhoneNumber,
  normalizePhoneNumber,
  pathExists,
  redactError,
} from './utils.js'
import { WhatsAppClient } from './whatsapp-client.js'

let promptInterface
let promptIterator

function prompts() {
  promptInterface ??= createInterface({ input: process.stdin, output: process.stdout })
  return promptInterface
}

async function ask(question) {
  const prompt = prompts()
  if (!process.stdin.isTTY) {
    process.stdout.write(question)
    promptIterator ??= prompt[Symbol.asyncIterator]()
    const { value, done } = await promptIterator.next()
    if (done) throw new Error('Entrada encerrada antes do fim do assistente.')
    return value.trim()
  }
  return (await prompt.question(question)).trim()
}

async function confirm(question, defaultYes = false) {
  const suffix = defaultYes ? '[S/n]' : '[s/N]'
  while (true) {
    const answer = (await ask(`${question} ${suffix} `)).toLocaleLowerCase('pt-BR')
    if (!answer) return defaultYes
    if (['s', 'sim', 'y', 'yes'].includes(answer)) return true
    if (['n', 'não', 'nao', 'no'].includes(answer)) return false
    console.log('Digite s ou n.')
  }
}

async function requireTypedConfirmation(expected, message) {
  const answer = await ask(`${message}\nDigite ${expected} para confirmar: `)
  return answer === expected
}

async function ensureBotStopped() {
  const pid = await readRunningPid(paths)
  if (pid) throw new Error(`O bot está em execução (PID ${pid}). Encerre-o com Ctrl+C antes desta operação.`)
}

async function configuredNumber(config) {
  if (config.whatsapp.monitoredNumber) {
    const keep = await confirm(`Manter o número monitorado ${maskPhoneNumber(config.whatsapp.monitoredNumber)}?`, true)
    if (keep) return config.whatsapp.monitoredNumber
  }

  while (true) {
    const raw = await ask('Número da LATAM a monitorar, com DDI e DDD (somente dígitos): ')
    try {
      const number = normalizePhoneNumber(raw)
      if (await confirm(`Confirmar o número ${number}?`, false)) return number
    } catch (error) {
      console.log(error.message)
    }
  }
}

async function commandSetup() {
  console.log('\nAssistente do Bot de Correção de Nome via WhatsApp')
  console.log('Este projeto usa uma integração não oficial. Use apenas em uma conta autorizada, sem spam.')
  if (!(await confirm('Você leu o aviso e deseja continuar?', false))) {
    console.log('Configuração cancelada.')
    return
  }

  await ensureBotStopped()
  await initializeLocalStorage(paths)
  let config
  try {
    config = await ensureUserConfig(paths)
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    console.log(error.message)
    if (!(await requireTypedConfirmation('RESTAURAR', 'A configuração local está inválida. Restaurar o fluxo padrão?'))) return
    config = await loadDefaultConfig(paths)
  }
  const previousNumber = config.whatsapp.monitoredNumber
  const nextNumber = await configuredNumber(config)
  if (previousNumber && previousNumber !== nextNumber) {
    const store = await new JobStore(paths).load()
    if (await store.hasUnfinishedJobs()) {
      console.log('Há trabalhos não concluídos vinculados ao número anterior.')
      if (!(await requireTypedConfirmation('CANCELAR', 'Para cancelar esses trabalhos e trocar o número:'))) {
        console.log('Troca de número cancelada; nenhum trabalho foi alterado.')
        return
      }
      const count = await cancelUnfinishedJobs(store)
      console.log(`${count} trabalho(s) cancelado(s).`)
    }
  }
  config.whatsapp.monitoredNumber = nextNumber
  await saveConfig(paths, config)
  const token = await ensureWebhookToken(paths)

  console.log(`\nConfiguração salva somente nesta máquina: ${paths.config}`)
  console.log('Token do webhook (guarde como uma senha; ele não entra no Git):')
  console.log(token)
  console.log(`Fluxo editável: ${paths.config}`)

  if (await confirm('Iniciar o bot agora e mostrar o QR Code no terminal?', true)) {
    promptInterface?.close()
    promptInterface = undefined
    promptIterator = undefined
    await runBot()
  } else {
    console.log('Concluído. Quando quiser conectar, execute: npm start')
  }
}

async function cancelUnfinishedJobs(store) {
  const jobs = (await store.listJobs()).filter((job) => !isTerminalStatus(job.status))
  for (const job of jobs) {
    await store.updateJob(job.id, (mutable) => {
      mutable.status = 'cancelled'
      mutable.waitingSince = null
      mutable.pendingStepId = null
      mutable.history.push({ at: new Date().toISOString(), event: 'cancelled_before_number_change' })
    })
  }
  return jobs.length
}

async function commandNumber(numberArgument) {
  await ensureBotStopped()
  await initializeLocalStorage(paths)
  const config = await ensureUserConfig(paths)
  const store = await new JobStore(paths).load()
  const currentNumber = config.whatsapp.monitoredNumber

  let number
  if (numberArgument) {
    number = normalizePhoneNumber(numberArgument)
    if (!(await confirm(`Trocar o monitoramento para ${number}?`, false))) return
  } else {
    const promptConfig = structuredClone(config)
    promptConfig.whatsapp.monitoredNumber = ''
    number = await configuredNumber(promptConfig)
  }
  if (number === currentNumber) {
    console.log('O número informado já está configurado. Nenhuma alteração foi necessária.')
    return
  }
  if (await store.hasUnfinishedJobs()) {
    console.log('Há trabalhos não concluídos. Trocar o número agora pode misturar conversas.')
    if (!(await requireTypedConfirmation('CANCELAR', 'Para cancelar todos os trabalhos pendentes e confirmar a troca:'))) {
      console.log('Troca de número cancelada; nenhum trabalho foi alterado.')
      return
    }
    const count = await cancelUnfinishedJobs(store)
    console.log(`${count} trabalho(s) cancelado(s).`)
  }
  config.whatsapp.monitoredNumber = number
  await saveConfig(paths, config)
  console.log(`Número monitorado alterado para ${maskPhoneNumber(number)}. A autenticação do WhatsApp foi preservada.`)
}

async function removeLocalAuth() {
  const authPath = await assertSafeManagedChild(paths, paths.auth)
  await fs.rm(authPath, { recursive: true, force: true })
}

async function commandReconnect() {
  await ensureBotStopped()
  const config = await loadConfig(paths, { requireNumber: true })
  if (await pathExists(paths.auth)) {
    console.log('Existe uma sessão local salva. O bot pode tentar reutilizá-la sem um novo QR.')
    const reset = await confirm('Apagar a sessão local e forçar a leitura de um novo QR?', false)
    if (reset) {
      if (!(await requireTypedConfirmation('NOVO QR', `Isso remove as credenciais locais em: ${paths.auth}`))) return
      await assertSafeManagedChild(paths, paths.auth)
      console.log('Tentando desvincular a sessão atual antes de gerar outro QR...')
      const remotelyLoggedOut = await tryRemoteLogout(config)
      await removeLocalAuth()
      console.log('Sessão local removida. Um novo QR será exibido.')
      if (!remotelyLoggedOut) {
        console.log('Não foi possível confirmar a desvinculação remota; confira WhatsApp > Dispositivos conectados no celular.')
      }
    }
  }
  promptInterface?.close()
  promptInterface = undefined
  promptIterator = undefined
  await runBot()
}

async function tryRemoteLogout(config) {
  let finish
  const outcome = new Promise((resolve) => {
    finish = resolve
  })
  const client = new WhatsAppClient({
    authDirectory: paths.auth,
    targetNumber: config.whatsapp.monitoredNumber,
    reconnect: { ...config.whatsapp.reconnect, enabled: false },
    output: { write() {} },
    onQr: () => finish(false),
    onConnectionChange: (connected) => finish(connected),
  })

  try {
    await client.start()
    const connected = await Promise.race([
      outcome,
      new Promise((resolve) => setTimeout(() => resolve(false), 15_000)),
    ])
    if (!connected) {
      await client.stop()
      return false
    }
    await client.logout()
    return true
  } catch {
    await client.stop().catch(() => {})
    return false
  }
}

async function commandConnectionDelete() {
  await ensureBotStopped()
  if (!(await pathExists(paths.auth))) {
    console.log('Não existe autenticação local para excluir.')
    return
  }
  await assertSafeManagedChild(paths, paths.auth)

  let config
  try {
    config = await loadConfig(paths)
  } catch {
    config = {
      whatsapp: {
        monitoredNumber: '10000000000',
        reconnect: { enabled: false, maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 1_000 },
      },
    }
  }

  console.log(`Esta operação tenta desvincular o dispositivo e apaga as credenciais locais em: ${paths.auth}`)
  if (!(await requireTypedConfirmation('EXCLUIR', 'A configuração do fluxo, o token e os trabalhos serão preservados.'))) return

  console.log('Tentando desvincular a sessão no WhatsApp...')
  const logoutConfig = structuredClone(config)
  logoutConfig.whatsapp.monitoredNumber ||= '10000000000'
  const remotelyLoggedOut = await tryRemoteLogout(logoutConfig)
  await removeLocalAuth()
  if (remotelyLoggedOut) {
    console.log('Conexão desvinculada e credenciais locais excluídas.')
  } else {
    console.log('Credenciais locais excluídas, mas não foi possível confirmar a desvinculação remota.')
    console.log('No celular, abra WhatsApp > Dispositivos conectados e remova este computador manualmente.')
  }
}

async function commandStatus() {
  let config
  try {
    config = await loadConfig(paths)
  } catch (error) {
    console.log(`Configuração: inválida (${error.message})`)
  }
  const pid = await readRunningPid(paths)
  const auth = await pathExists(path.join(paths.auth, 'creds.json'))
  const token = await pathExists(paths.webhookToken)
  let counts = {}
  if (await pathExists(paths.jobs)) {
    const store = await new JobStore(paths).load()
    counts = (await store.listJobs()).reduce((result, job) => {
      result[job.status] = (result[job.status] ?? 0) + 1
      return result
    }, {})
  }

  console.log(`Bot: ${pid ? `em execução (PID ${pid})` : 'parado'}`)
  console.log(`Diretório privado: ${paths.localDirectory}`)
  console.log(`Número monitorado: ${config?.whatsapp.monitoredNumber ? maskPhoneNumber(config.whatsapp.monitoredNumber) : 'não configurado'}`)
  console.log(`Autenticação local: ${auth ? 'presente' : 'ausente'}`)
  console.log(`Token do webhook: ${token ? 'presente' : 'ausente'}`)
  console.log(`Trabalhos: ${Object.keys(counts).length ? JSON.stringify(counts) : 'nenhum'}`)
}

async function commandJobs() {
  const store = await new JobStore(paths).load()
  const jobs = await store.listJobs()
  if (!jobs.length) {
    console.log('Nenhum trabalho registrado.')
    return
  }
  console.table(jobs.map((job) => ({
    id: job.id,
    status: job.status,
    passo: job.workflow.steps[job.cursor]?.id ?? '-',
    criado: job.createdAt,
    atualizado: job.updatedAt,
  })))
}

async function commandDoctor() {
  const checks = []
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10)
  checks.push({ item: 'Node.js >= 22', ok: nodeMajor >= 22, detail: process.version })
  try {
    const config = await loadConfig(paths, { requireNumber: true })
    checks.push({ item: 'Configuração', ok: true, detail: paths.config })
    checks.push({
      item: 'Webhook local',
      ok: ['127.0.0.1', '::1', 'localhost'].includes(config.server.host),
      detail: `${config.server.host}:${config.server.port}`,
    })
  } catch (error) {
    checks.push({ item: 'Configuração', ok: false, detail: error.message.split('\n')[0] })
  }
  let validToken = false
  try {
    await readWebhookToken(paths)
    validToken = true
  } catch {
    // O diagnóstico mostra apenas o estado, sem expor o token.
  }
  checks.push({ item: 'Token', ok: validToken, detail: paths.webhookToken })
  checks.push({
    item: 'Autenticação WhatsApp',
    ok: await pathExists(path.join(paths.auth, 'creds.json')),
    detail: paths.auth,
  })
  console.table(checks.map((check) => ({
    resultado: check.ok ? 'OK' : 'ATENÇÃO',
    item: check.item,
    detalhe: check.detail,
  })))
  if (checks.some((check) => !check.ok && check.item !== 'Autenticação WhatsApp')) process.exitCode = 1
}

async function commandTokenShow() {
  const token = await readWebhookToken(paths)
  console.log(token)
}

function workflowAction(step) {
  if (step.terminal === 'success') return 'Concluir trabalho'
  if (step.send?.kind === 'document') return `Enviar PDF (${step.send.fileName})`
  if (step.send?.kind === 'text') return `Enviar: ${step.send.value}`
  return '-'
}

async function commandWorkflowShow() {
  const config = await loadConfig(paths)
  console.log(`Configuração ativa: ${paths.config}`)
  console.log(`Timeout por resposta: ${config.workflow.stepTimeoutMinutes} min | Timeout total: ${config.workflow.jobTimeoutMinutes} min`)
  console.table(config.workflow.steps.map((step, index) => ({
    ordem: index + 1,
    id: step.id,
    aguarda: step.await.mode,
    ação: workflowAction(step),
  })))
  console.log('Para editar: npm run workflow:edit')
}

function editorCommand(filePath) {
  if (process.platform === 'win32') return { command: 'notepad.exe', arguments: [filePath] }
  if (process.platform === 'darwin') return { command: 'open', arguments: ['-W', '-t', filePath] }
  return { command: process.env.EDITOR || 'nano', arguments: [filePath] }
}

async function commandWorkflowEdit() {
  await ensureBotStopped()
  await initializeLocalStorage(paths)
  await ensureUserConfig(paths)
  const editor = editorCommand(paths.config)
  console.log(`Abrindo a configuração ativa: ${paths.config}`)
  await new Promise((resolve, reject) => {
    const child = spawn(editor.command, editor.arguments, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`O editor terminou com código ${code}.`)))
  })
  await loadConfig(paths, { requireNumber: true })
  console.log('Configuração válida. As mudanças serão usadas nos novos trabalhos ao executar npm start.')
  await commandWorkflowShow()
}

function localHttpHost(configuredHost) {
  if (configuredHost === '0.0.0.0') return '127.0.0.1'
  if (configuredHost === '::') return '[::1]'
  return configuredHost.includes(':') ? `[${configuredHost}]` : configuredHost
}

async function commandJobAction(jobId, action) {
  if (!jobId || !action) throw new Error('Uso: node src/cli.js job-action <id> <ação>')
  const config = await loadConfig(paths, { requireNumber: true })
  const token = await readWebhookToken(paths)
  const url = `http://${localHttpHost(config.server.host)}:${config.server.port}/api/jobs/${encodeURIComponent(jobId)}/actions`
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  console.log(`Trabalho ${body.job.id}: ${body.job.status}`)
}

function printHelp() {
  console.log(`
Uso: node src/cli.js <comando>

  setup                         Assistente inicial
  start                         Inicia o webhook e o WhatsApp
  tunnel                        Publica o webhook local em uma URL HTTPS temporária
  workflow-show                 Mostra a sequência ativa de mensagens
  workflow-edit                 Abre e valida a sequência ativa no editor
  number [DDI+DDD+número]       Altera o número monitorado
  reconnect                     Reconecta e permite forçar novo QR
  connection-delete             Desvincula e exclui a autenticação local
  status                        Mostra o estado local
  jobs                          Lista trabalhos sem exibir dados pessoais
  job-action <id> <ação>        cancel | resume-waiting | retry-send | assume-sent
  token-show                    Exibe o token local do webhook
  doctor                        Valida a instalação e a configuração
`)
}

async function main() {
  const [command = 'help', ...arguments_] = process.argv.slice(2)
  switch (command) {
    case 'setup': return commandSetup()
    case 'start': return runBot()
    case 'tunnel': return runTunnel()
    case 'workflow-show': return commandWorkflowShow()
    case 'workflow-edit': return commandWorkflowEdit()
    case 'number': return commandNumber(arguments_[0])
    case 'reconnect': return commandReconnect()
    case 'connection-delete': return commandConnectionDelete()
    case 'status': return commandStatus()
    case 'jobs': return commandJobs()
    case 'job-action': return commandJobAction(arguments_[0], arguments_[1])
    case 'token-show': return commandTokenShow()
    case 'doctor': return commandDoctor()
    case 'help':
    case '--help':
    case '-h': return printHelp()
    default:
      printHelp()
      throw new Error(`Comando desconhecido: ${command}`)
  }
}

try {
  await main()
} catch (error) {
  const prefix = error instanceof ConfigError ? '' : 'Erro: '
  console.error(`${prefix}${redactError(error)}`)
  process.exitCode = 1
} finally {
  promptInterface?.close()
}
