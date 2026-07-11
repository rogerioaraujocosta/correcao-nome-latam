import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export function normalizePhoneNumber(value) {
  const raw = String(value ?? '').trim()
  if (!raw || raw.includes('@') || /[a-z]/i.test(raw)) {
    throw new Error('Informe um número de WhatsApp válido.')
  }
  const withoutInternationalPrefix = raw.startsWith('00') ? raw.slice(2) : raw
  const digits = withoutInternationalPrefix.replace(/\D/g, '')

  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Informe o número com DDI, contendo de 8 a 15 dígitos.')
  }

  return digits
}

export function phoneFromJid(jid) {
  if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return null
  const user = jid.slice(0, jid.indexOf('@')).split(':')[0]
  return /^\d{8,15}$/.test(user) ? user : null
}

export function maskPhoneNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (digits.length < 6) return '***'
  return `${digits.slice(0, 2)}${'*'.repeat(Math.max(4, digits.length - 6))}${digits.slice(-4)}`
}

export function normalizeMatchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim()
}

export function renderTemplate(template, values) {
  if (typeof template !== 'string') throw new TypeError('Template deve ser texto.')

  return template.replace(/{{\s*([a-zA-Z][\w.]*)\s*}}/g, (_match, key) => {
    const value = key.split('.').reduce((current, part) => current?.[part], values)
    if (value === undefined || value === null) {
      throw new Error(`Variável ausente no template: ${key}`)
    }
    return String(value)
  })
}

export function templateVariables(template) {
  if (typeof template !== 'string') return []
  return [...template.matchAll(/{{\s*([a-zA-Z][\w.]*)\s*}}/g)].map((match) => match[1])
}

export function isPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false
  return buffer.subarray(0, 5).toString('ascii') === '%PDF-'
}

export function sanitizeFileName(value, fallback = 'bilhete.pdf') {
  const base = path.basename(String(value ?? fallback))
  const sanitized = base
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return sanitized || fallback
}

export function assertPathInside(baseDirectory, candidate) {
  const base = path.resolve(baseDirectory)
  const target = path.resolve(candidate)
  const relative = path.relative(base, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Caminho fora da área local permitida: ${target}`)
  }
  return target
}

export async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    await fs.chmod(directory, 0o700).catch(() => {})
  }
}

export async function atomicWriteFile(filePath, contents, options = {}) {
  await ensurePrivateDirectory(path.dirname(filePath))
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const mode = options.mode ?? 0o600
  await fs.writeFile(temporary, contents, { ...options, mode })
  try {
    await fs.rename(temporary, filePath)
  } catch (error) {
    if (process.platform !== 'win32') throw error
    await fs.rm(filePath, { force: true })
    await fs.rename(temporary, filePath)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
  if (process.platform !== 'win32') {
    await fs.chmod(filePath, mode).catch(() => {})
  }
}

export async function atomicWriteJson(filePath, data) {
  await atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8' })
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function redactError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [token oculto]')
    .replace(/\b[a-f0-9]{64}\b/gi, '[token oculto]')
    .replace(/\b\d{8,15}\b/g, '[número oculto]')
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, '[dado oculto]')
}

export function timingSafeTokenEqual(received, expected) {
  const left = Buffer.from(String(received ?? ''))
  const right = Buffer.from(String(expected ?? ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}
