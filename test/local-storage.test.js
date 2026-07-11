import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  assertSafeManagedChild,
  initializeLocalStorage,
  SENTINEL_CONTENT,
} from '../src/local-storage.js'
import { createPaths } from '../src/paths.js'

const executeFile = promisify(execFile)

function assertSafeAclTestDirectory(localDirectory) {
  const temporaryRoot = path.resolve(os.tmpdir())
  const target = path.resolve(localDirectory)
  const relative = path.relative(temporaryRoot, target)
  assert.ok(relative)
  assert.ok(!relative.startsWith('..'))
  assert.ok(!path.isAbsolute(relative))
  assert.match(path.basename(target), /^latam-bot-acl-/)
  return target
}

async function createUnreadableWindowsMarker(t, contents) {
  const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'latam-bot-acl-'))
  const appPaths = createPaths({ localDirectory })
  t.after(async () => {
    const target = assertSafeAclTestDirectory(localDirectory)
    await executeFile('icacls.exe', [target, '/reset', '/T', '/C', '/Q'], {
      windowsHide: true,
    })
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  await fs.writeFile(appPaths.sentinel, contents, 'utf8')
  await executeFile('icacls.exe', [appPaths.sentinel, '/inheritance:r', '/Q'], {
    windowsHide: true,
  })
  await assert.rejects(
    fs.readFile(appPaths.sentinel, 'utf8'),
    (error) => error?.code === 'EACCES' || error?.code === 'EPERM',
  )
  return appPaths
}

test('cria marcador e autoriza somente filhos da área gerenciada', async (t) => {
  const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'latam-bot-storage-'))
  t.after(() => fs.rm(localDirectory, { recursive: true, force: true }))
  const appPaths = createPaths({ localDirectory })

  await initializeLocalStorage(appPaths)
  await initializeLocalStorage(appPaths)

  assert.equal(await fs.readFile(appPaths.sentinel, 'utf8'), SENTINEL_CONTENT)
  assert.equal(await assertSafeManagedChild(appPaths, appPaths.auth), appPaths.auth)
  await assert.rejects(
    assertSafeManagedChild(appPaths, path.join(localDirectory, '..', 'auth')),
    /fora da área local permitida/,
  )
})

test('recusa adotar diretório não vazio sem marcador do aplicativo', async (t) => {
  const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'latam-bot-unmanaged-'))
  t.after(() => fs.rm(localDirectory, { recursive: true, force: true }))
  await fs.writeFile(path.join(localDirectory, 'arquivo-alheio.txt'), 'não apagar', 'utf8')
  const appPaths = createPaths({ localDirectory })

  await assert.rejects(initializeLocalStorage(appPaths), /já contém arquivos/)
})

test('recusa diretório privado dentro do projeto fora da pasta .local', () => {
  const projectRoot = path.resolve('projeto-ficticio')
  assert.throws(
    () => createPaths({ projectRoot, localDirectory: path.join(projectRoot, 'dados-privados') }),
    /não pode ficar dentro do projeto/,
  )
})

test('recusa marcador com hard link antes de inicializar ou autorizar exclusões', async (t) => {
  const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'latam-bot-hardlink-'))
  t.after(() => fs.rm(localDirectory, { recursive: true, force: true }))
  const appPaths = createPaths({ localDirectory })
  const source = path.join(localDirectory, 'marcador-origem')
  await fs.writeFile(source, SENTINEL_CONTENT, 'utf8')
  await fs.link(source, appPaths.sentinel)

  await assert.rejects(initializeLocalStorage(appPaths), /arquivo regular sem links/)
  await assert.rejects(
    assertSafeManagedChild(appPaths, appPaths.auth),
    /marcador de segurança ausente/,
  )
})

test('repara no Windows o marcador legado sem permissão de leitura', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const appPaths = await createUnreadableWindowsMarker(t, SENTINEL_CONTENT)

  await initializeLocalStorage(appPaths)

  assert.equal(await fs.readFile(appPaths.sentinel, 'utf8'), SENTINEL_CONTENT)
})

test('continua recusando no Windows um marcador inválido após reparar a permissão', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const invalidContents = 'marcador-inválido\n'
  const appPaths = await createUnreadableWindowsMarker(t, invalidContents)

  await assert.rejects(initializeLocalStorage(appPaths), /marcador do diretório privado é inválido/)
  assert.equal(await fs.readFile(appPaths.sentinel, 'utf8'), invalidContents)
})
