import fs from 'node:fs/promises'
import safeRegex from 'safe-regex2'

import { atomicWriteJson, normalizePhoneNumber, pathExists, readJson, templateVariables } from './utils.js'

const ALLOWED_TEMPLATE_VARIABLES = new Set([
  'pnr',
  'currentName',
  'correctName',
  'ticketFileName',
])

const MATCH_MODES = new Set(['job_created', 'any_inbound', 'contains', 'regex'])
const SEND_KINDS = new Set(['text', 'document'])

export class ConfigError extends Error {
  constructor(problems) {
    super(`Configuração inválida:\n- ${problems.join('\n- ')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mergeDefaults(defaultValue, localValue) {
  if (!isPlainObject(defaultValue) || !isPlainObject(localValue)) {
    return localValue === undefined ? structuredClone(defaultValue) : structuredClone(localValue)
  }

  const result = structuredClone(defaultValue)
  for (const [key, value] of Object.entries(localValue)) {
    result[key] = key in defaultValue ? mergeDefaults(defaultValue[key], value) : structuredClone(value)
  }
  return result
}

function validateTemplate(template, location, problems) {
  for (const variable of templateVariables(template)) {
    if (!ALLOWED_TEMPLATE_VARIABLES.has(variable)) {
      problems.push(`${location} usa a variável desconhecida {{${variable}}}.`)
    }
  }
}

export function validateConfig(config, options = {}) {
  const problems = []
  const requireNumber = options.requireNumber ?? false

  if (!isPlainObject(config)) throw new ConfigError(['O arquivo deve conter um objeto JSON.'])
  if (config.schemaVersion !== 1) problems.push('schemaVersion deve ser 1.')

  if (!isPlainObject(config.server)) {
    problems.push('server deve ser um objeto.')
  } else {
    if (typeof config.server.host !== 'string' || config.server.host.trim() === '') {
      problems.push('server.host deve ser um endereço válido.')
    }
    if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65_535) {
      problems.push('server.port deve estar entre 1 e 65535.')
    }
    if (!Number.isInteger(config.server.maxUploadMb) || config.server.maxUploadMb < 1 || config.server.maxUploadMb > 100) {
      problems.push('server.maxUploadMb deve ser um inteiro entre 1 e 100.')
    }
  }

  if (!isPlainObject(config.tunnel)) {
    problems.push('tunnel deve ser um objeto.')
  } else {
    const notifyWebhookUrl = config.tunnel.notifyWebhookUrl
    if (typeof notifyWebhookUrl !== 'string' || notifyWebhookUrl.length > 2048) {
      problems.push('tunnel.notifyWebhookUrl deve ser um texto de até 2048 caracteres.')
    } else if (notifyWebhookUrl) {
      try {
        const parsed = new URL(notifyWebhookUrl)
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
          problems.push('tunnel.notifyWebhookUrl deve ser uma URL HTTPS sem usuário ou senha.')
        }
      } catch {
        problems.push('tunnel.notifyWebhookUrl deve ser uma URL HTTPS válida.')
      }
    }
  }

  if (!isPlainObject(config.whatsapp)) {
    problems.push('whatsapp deve ser um objeto.')
  } else {
    const monitoredNumber = String(config.whatsapp.monitoredNumber ?? '')
    if (requireNumber && monitoredNumber === '') {
      problems.push('whatsapp.monitoredNumber ainda não foi configurado.')
    } else if (monitoredNumber !== '') {
      try {
        if (normalizePhoneNumber(monitoredNumber) !== monitoredNumber) {
          problems.push('whatsapp.monitoredNumber deve conter somente dígitos, incluindo o DDI.')
        }
      } catch (error) {
        problems.push(`whatsapp.monitoredNumber: ${error.message}`)
      }
    }
    const reconnect = config.whatsapp.reconnect
    if (!isPlainObject(reconnect)) {
      problems.push('whatsapp.reconnect deve ser um objeto.')
    } else {
      if (typeof reconnect.enabled !== 'boolean') {
        problems.push('whatsapp.reconnect.enabled deve ser booleano.')
      }
      if (!Number.isInteger(reconnect.maxAttempts) || reconnect.maxAttempts < 0 || reconnect.maxAttempts > 100) {
        problems.push('whatsapp.reconnect.maxAttempts deve estar entre 0 (ilimitado) e 100.')
      }
      if (!Number.isInteger(reconnect.baseDelayMs) || reconnect.baseDelayMs < 250 || reconnect.baseDelayMs > 60_000) {
        problems.push('whatsapp.reconnect.baseDelayMs deve estar entre 250 e 60000.')
      }
      if (!Number.isInteger(reconnect.maxDelayMs) || reconnect.maxDelayMs < 1_000 || reconnect.maxDelayMs > 300_000) {
        problems.push('whatsapp.reconnect.maxDelayMs deve estar entre 1000 e 300000.')
      }
      if (reconnect.jitterRatio !== undefined && (!Number.isFinite(reconnect.jitterRatio) || reconnect.jitterRatio < 0 || reconnect.jitterRatio > 1)) {
        problems.push('whatsapp.reconnect.jitterRatio deve estar entre 0 e 1.')
      }
      if (Number.isInteger(reconnect.baseDelayMs) && Number.isInteger(reconnect.maxDelayMs) && reconnect.maxDelayMs < reconnect.baseDelayMs) {
        problems.push('whatsapp.reconnect.maxDelayMs não pode ser menor que baseDelayMs.')
      }
    }
  }

  if (!isPlainObject(config.storage)) {
    problems.push('storage deve ser um objeto.')
  } else if (!Number.isInteger(config.storage.retentionDays) || config.storage.retentionDays < 0 || config.storage.retentionDays > 3650) {
    problems.push('storage.retentionDays deve ser um inteiro entre 0 e 3650.')
  }

  if (!isPlainObject(config.workflow)) {
    problems.push('workflow deve ser um objeto.')
  } else {
    if (!Number.isInteger(config.workflow.stepTimeoutMinutes) || config.workflow.stepTimeoutMinutes < 1 || config.workflow.stepTimeoutMinutes > 1440) {
      problems.push('workflow.stepTimeoutMinutes deve ser um inteiro entre 1 e 1440.')
    }
    if (!Number.isInteger(config.workflow.jobTimeoutMinutes) || config.workflow.jobTimeoutMinutes < 1 || config.workflow.jobTimeoutMinutes > 10080) {
      problems.push('workflow.jobTimeoutMinutes deve ser um inteiro entre 1 e 10080.')
    }

    const inboundRules = config.workflow.inboundRules ?? []
    if (!Array.isArray(inboundRules)) {
      problems.push('workflow.inboundRules deve ser uma lista.')
    } else {
      const ruleIds = new Set()
      inboundRules.forEach((rule, index) => {
        const location = `workflow.inboundRules[${index}]`
        if (!isPlainObject(rule)) {
          problems.push(`${location} deve ser um objeto.`)
          return
        }
        if (typeof rule.id !== 'string' || !/^[a-z][a-z0-9_-]{1,49}$/.test(rule.id)) {
          problems.push(`${location}.id deve usar letras minúsculas, números, _ ou -.`)
        } else if (ruleIds.has(rule.id)) {
          problems.push(`${location}.id está duplicado: ${rule.id}.`)
        } else {
          ruleIds.add(rule.id)
        }
        if (!Array.isArray(rule.match?.allOf) || rule.match.allOf.length === 0 || rule.match.allOf.some((item) => typeof item !== 'string' || item.trim() === '')) {
          problems.push(`${location}.match.allOf deve conter textos não vazios.`)
        }
        if (rule.send?.kind !== 'text' || typeof rule.send?.value !== 'string' || rule.send.value.trim() === '' || rule.send.value.length > 4096) {
          problems.push(`${location}.send deve definir um texto não vazio.`)
        } else {
          validateTemplate(rule.send.value, `${location}.send.value`, problems)
        }
        if (rule.terminal !== 'success') problems.push(`${location}.terminal deve ser success.`)
      })
    }

    const steps = config.workflow.steps
    if (!Array.isArray(steps) || steps.length < 2) {
      problems.push('workflow.steps deve conter pelo menos dois passos.')
    } else {
      const ids = new Set()
      let terminalCount = 0

      steps.forEach((step, index) => {
        const location = `workflow.steps[${index}]`
        if (!isPlainObject(step)) {
          problems.push(`${location} deve ser um objeto.`)
          return
        }
        if (typeof step.id !== 'string' || !/^[a-z][a-z0-9_-]{1,49}$/.test(step.id)) {
          problems.push(`${location}.id deve usar letras minúsculas, números, _ ou -.`)
        } else if (ids.has(step.id)) {
          problems.push(`${location}.id está duplicado: ${step.id}.`)
        } else {
          ids.add(step.id)
        }

        const mode = step.await?.mode
        if (!MATCH_MODES.has(mode)) {
          problems.push(`${location}.await.mode deve ser job_created, any_inbound, contains ou regex.`)
        }
        if (index === 0 && mode !== 'job_created') {
          problems.push('O primeiro passo deve usar await.mode = job_created.')
        }
        if (index > 0 && mode === 'job_created') {
          problems.push(`${location} não pode usar job_created fora do primeiro passo.`)
        }
        if (mode === 'contains' || mode === 'regex') {
          if (!Array.isArray(step.await?.anyOf) || step.await.anyOf.length === 0 || step.await.anyOf.some((item) => typeof item !== 'string' || item.trim() === '')) {
            problems.push(`${location}.await.anyOf deve conter textos não vazios.`)
          } else if (mode === 'regex') {
            for (const pattern of step.await.anyOf) {
              try {
                new RegExp(pattern, 'iu')
                if (pattern.length > 500 || !safeRegex(pattern)) {
                  problems.push(`${location} contém regex potencialmente excessiva ou insegura.`)
                }
              } catch (error) {
                problems.push(`${location} contém regex inválida: ${error.message}`)
              }
            }
          }
        }

        if (step.terminal !== undefined) {
          terminalCount += 1
          if (step.terminal !== 'success') problems.push(`${location}.terminal deve ser success.`)
          if (step.send !== undefined) problems.push(`${location} terminal não deve conter send.`)
        } else if (!isPlainObject(step.send)) {
          problems.push(`${location}.send é obrigatório em passos não terminais.`)
        } else if (!SEND_KINDS.has(step.send.kind)) {
          problems.push(`${location}.send.kind deve ser text ou document.`)
        } else if (step.send.kind === 'text') {
          if (typeof step.send.value !== 'string' || step.send.value.trim() === '' || step.send.value.length > 4096) {
            problems.push(`${location}.send.value deve ter entre 1 e 4096 caracteres.`)
          } else {
            validateTemplate(step.send.value, `${location}.send.value`, problems)
          }
        } else {
          if (step.send.sourceField !== 'ticketPdf') {
            problems.push(`${location}.send.sourceField deve ser ticketPdf.`)
          }
          if (typeof step.send.fileName !== 'string' || step.send.fileName.trim() === '') {
            problems.push(`${location}.send.fileName é obrigatório.`)
          } else {
            validateTemplate(step.send.fileName, `${location}.send.fileName`, problems)
          }
          if (step.send.caption !== undefined) {
            if (typeof step.send.caption !== 'string' || step.send.caption.length > 1024) {
              problems.push(`${location}.send.caption deve ter no máximo 1024 caracteres.`)
            } else {
              validateTemplate(step.send.caption, `${location}.send.caption`, problems)
            }
          }
        }
      })

      if (terminalCount !== 1 || steps.at(-1)?.terminal !== 'success') {
        problems.push('O fluxo deve terminar com exatamente um passo terminal success.')
      }
    }
  }

  if (problems.length > 0) throw new ConfigError(problems)
  return config
}

export async function loadDefaultConfig(appPaths) {
  return validateConfig(await readJson(appPaths.defaultConfig))
}

export async function loadConfig(appPaths, options = {}) {
  const defaults = await loadDefaultConfig(appPaths)
  const local = await pathExists(appPaths.config) ? await readJson(appPaths.config) : {}
  return validateConfig(mergeDefaults(defaults, local), options)
}

export async function ensureUserConfig(appPaths) {
  if (await pathExists(appPaths.config)) return loadConfig(appPaths)
  const defaults = await loadDefaultConfig(appPaths)
  await atomicWriteJson(appPaths.config, defaults)
  return defaults
}

export async function saveConfig(appPaths, config) {
  validateConfig(config)
  await atomicWriteJson(appPaths.config, config)
}

export async function readRawLocalConfig(appPaths) {
  if (!(await pathExists(appPaths.config))) return null
  return JSON.parse(await fs.readFile(appPaths.config, 'utf8'))
}
