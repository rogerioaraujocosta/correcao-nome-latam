import fs from 'node:fs/promises'

import { ensurePrivateDirectory } from './utils.js'

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export async function readRunningPid(appPaths) {
  try {
    const pid = Number.parseInt((await fs.readFile(appPaths.pid, 'utf8')).trim(), 10)
    return processIsAlive(pid) ? pid : null
  } catch {
    return null
  }
}

export async function acquirePidLock(appPaths) {
  await ensurePrivateDirectory(appPaths.localDirectory)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(appPaths.pid, 'wx', 0o600)
      await handle.writeFile(`${process.pid}\n`, 'utf8')
      await handle.close()
      return async () => {
        try {
          const current = Number.parseInt((await fs.readFile(appPaths.pid, 'utf8')).trim(), 10)
          if (current === process.pid) await fs.rm(appPaths.pid, { force: true })
        } catch {
          // O lock já foi removido.
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const pid = await readRunningPid(appPaths)
      if (pid) throw new Error(`O bot já está em execução (PID ${pid}). Encerre-o antes de iniciar outra instância.`)
      await fs.rm(appPaths.pid, { force: true })
    }
  }
  throw new Error('Não foi possível adquirir o bloqueio de execução do bot.')
}

export { processIsAlive }
