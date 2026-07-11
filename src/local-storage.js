import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'

import {
  assertPathInside,
  atomicWriteFile,
  ensurePrivateDirectory,
  pathExists,
} from './utils.js'

const executeFile = promisify(execFile)
const SENTINEL_CONTENT = 'latam-name-correction-bot-data-v1\n'

async function assertRealDirectory(directory) {
  const stats = await fs.lstat(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`O diretório privado não pode ser link ou arquivo: ${directory}`)
  }
}

async function currentWindowsSid() {
  const { stdout } = await executeFile('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
  })
  const sid = stdout.match(/S-1-5-(?:\d+-)+\d+/i)?.[0]
  if (!sid) throw new Error('Não foi possível identificar o usuário do Windows para proteger os dados locais.')
  return sid
}

export async function restrictWindowsAcl(directory) {
  if (process.platform !== 'win32') return
  const sid = await currentWindowsSid()
  await executeFile('icacls.exe', [
    directory,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(OI)(CI)F`,
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F',
    '/Q',
  ], { windowsHide: true })
  await executeFile('icacls.exe', [
    directory,
    '/grant:r',
    `*${sid}:F`,
    '*S-1-5-18:F',
    '*S-1-5-32-544:F',
    '/T',
    '/C',
    '/Q',
  ], { windowsHide: true })
}

export async function initializeLocalStorage(appPaths) {
  await ensurePrivateDirectory(appPaths.localDirectory)
  await assertRealDirectory(appPaths.localDirectory)

  if (await pathExists(appPaths.sentinel)) {
    const value = await fs.readFile(appPaths.sentinel, 'utf8')
    if (value !== SENTINEL_CONTENT) {
      throw new Error(`O marcador do diretório privado é inválido: ${appPaths.sentinel}`)
    }
  } else {
    const existingEntries = (await fs.readdir(appPaths.localDirectory)).filter((entry) => entry !== '.gitkeep')
    if (existingEntries.length > 0) {
      throw new Error(`O diretório informado já contém arquivos e não possui o marcador deste aplicativo: ${appPaths.localDirectory}`)
    }
    await atomicWriteFile(appPaths.sentinel, SENTINEL_CONTENT, { encoding: 'utf8', mode: 0o600 })
  }

  if (process.platform === 'win32') {
    await restrictWindowsAcl(appPaths.localDirectory)
  } else {
    await fs.chmod(appPaths.localDirectory, 0o700)
  }
}

export async function assertManagedLocalStorage(appPaths) {
  const root = assertPathInside(appPaths.localDirectory, appPaths.localDirectory)
  await assertRealDirectory(root)
  const marker = await fs.readFile(appPaths.sentinel, 'utf8').catch(() => '')
  if (marker !== SENTINEL_CONTENT) {
    throw new Error(`Exclusão recusada: marcador de segurança ausente em ${appPaths.localDirectory}`)
  }
  return root
}

export async function assertSafeManagedChild(appPaths, childPath) {
  await assertManagedLocalStorage(appPaths)
  const target = assertPathInside(appPaths.localDirectory, childPath)
  if (await pathExists(target)) {
    const stats = await fs.lstat(target)
    if (stats.isSymbolicLink()) {
      throw new Error(`Exclusão recusada: o caminho é um link simbólico ou junção: ${target}`)
    }
  }
  return target
}

export { SENTINEL_CONTENT }
