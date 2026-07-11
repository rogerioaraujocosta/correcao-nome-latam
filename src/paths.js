import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = path.resolve(sourceDirectory, '..')

export function defaultLocalDirectory() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'latam-name-correction-bot')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'latam-name-correction-bot')
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'latam-name-correction-bot')
}

export function createPaths(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT)
  const configuredLocalDirectory = options.localDirectory ?? process.env.LATAM_BOT_LOCAL_DIR
  if (configuredLocalDirectory && !path.isAbsolute(configuredLocalDirectory)) {
    throw new Error('LATAM_BOT_LOCAL_DIR deve ser um caminho absoluto.')
  }
  const localDirectory = path.resolve(configuredLocalDirectory ?? defaultLocalDirectory())
  const relativeToProject = path.relative(projectRoot, localDirectory)
  const isInsideProject = relativeToProject === '' || (!relativeToProject.startsWith('..') && !path.isAbsolute(relativeToProject))
  const portableDirectory = path.join(projectRoot, '.local')
  const isPortableDirectory = path.relative(portableDirectory, localDirectory) === ''
  if (isInsideProject && !isPortableDirectory) {
    throw new Error('O diretório privado não pode ficar dentro do projeto, exceto na pasta .local protegida pelo .gitignore.')
  }

  return Object.freeze({
    projectRoot,
    defaultConfig: path.join(projectRoot, 'config', 'default.json'),
    localDirectory,
    sentinel: path.join(localDirectory, '.latam-name-bot-data'),
    config: path.join(localDirectory, 'config.json'),
    auth: path.join(localDirectory, 'auth'),
    uploads: path.join(localDirectory, 'uploads'),
    jobs: path.join(localDirectory, 'jobs.json'),
    webhookToken: path.join(localDirectory, 'webhook-token'),
    pid: path.join(localDirectory, 'bot.pid'),
  })
}

export const paths = createPaths()
