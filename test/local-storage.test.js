import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertSafeManagedChild,
  initializeLocalStorage,
  SENTINEL_CONTENT,
} from '../src/local-storage.js'
import { createPaths } from '../src/paths.js'

test('cria marcador e autoriza somente filhos da área gerenciada', async (t) => {
  const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'latam-bot-storage-'))
  t.after(() => fs.rm(localDirectory, { recursive: true, force: true }))
  const appPaths = createPaths({ localDirectory })

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
