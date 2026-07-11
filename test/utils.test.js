import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertPathInside,
  atomicWriteJson,
  isPdfBuffer,
  normalizeMatchText,
  normalizePhoneNumber,
  phoneFromJid,
  readJson,
  renderTemplate,
  sanitizeFileName,
  timingSafeTokenEqual,
} from '../src/utils.js'

test('normaliza números e extrai somente JIDs individuais válidos', () => {
  assert.equal(normalizePhoneNumber('+55 (11) 99999-9999'), '5511999999999')
  assert.equal(normalizePhoneNumber('005511999999999'), '5511999999999')
  assert.throws(() => normalizePhoneNumber('123'), /8 a 15 dígitos/)

  assert.equal(phoneFromJid('5511999999999:4@s.whatsapp.net'), '5511999999999')
  assert.equal(phoneFromJid('5511999999999@g.us'), null)
  assert.equal(phoneFromJid('status@broadcast'), null)
})

test('normaliza texto e renderiza apenas valores presentes', () => {
  assert.equal(normalizeMatchText('  LOCALIZÁDOR\n do   VÔO  '), 'localizador do voo')
  assert.equal(
    renderTemplate('Bilhete {{pnr}}: {{currentName}}', {
      pnr: 'QWEBZI',
      currentName: 'JANDELA',
    }),
    'Bilhete QWEBZI: JANDELA',
  )
  assert.throws(
    () => renderTemplate('{{correctName}}', {}),
    /Variável ausente no template: correctName/,
  )
})

test('valida assinatura de PDF, nomes de arquivo e tokens sem coerção insegura', () => {
  assert.equal(isPdfBuffer(Buffer.from('%PDF-1.7\nobj')), true)
  assert.equal(isPdfBuffer(Buffer.from('arquivo falso')), false)

  const safeName = sanitizeFileName('../nome:inválido?.pdf')
  assert.equal(safeName.includes('..'), false)
  assert.equal(/[<>:"/\\|?*]/.test(safeName), false)

  assert.equal(timingSafeTokenEqual('segredo', 'segredo'), true)
  assert.equal(timingSafeTokenEqual('segredo', 'outro'), false)
})

test('escrita JSON atômica fica no diretório temporário permitido', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'latam-bot-utils-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))

  const filePath = assertPathInside(directory, path.join(directory, 'state', 'dados.json'))
  await atomicWriteJson(filePath, { ok: true, count: 2 })

  assert.deepEqual(await readJson(filePath), { ok: true, count: 2 })
  assert.throws(
    () => assertPathInside(directory, path.resolve(directory, '..', 'fora.json')),
    /fora da área local permitida/,
  )
})
