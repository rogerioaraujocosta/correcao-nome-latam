import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadDefaultConfig } from '../src/config.js'
import { JobStore } from '../src/job-store.js'
import { createPaths } from '../src/paths.js'

const TARGET_NUMBER = '5511999999999'

async function createHarness(t) {
  const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'latam-bot-store-'))
  t.after(() => fs.rm(localDirectory, { recursive: true, force: true }))
  const appPaths = createPaths({ localDirectory })
  const config = await loadDefaultConfig(appPaths)
  const store = await new JobStore(appPaths).load()
  return { appPaths, config, store }
}

function jobInput(workflow, overrides = {}) {
  return {
    id: overrides.id ?? 'job-1',
    requestId: overrides.requestId ?? 'request-0001',
    payload: {
      pnr: 'QWEBZI',
      currentName: 'JANDELA',
      correctName: 'DANIELA',
      ticketFileName: 'bilhete.pdf',
    },
    attachmentPath: overrides.attachmentPath ?? null,
    workflow,
    targetNumber: TARGET_NUMBER,
  }
}

test('criação concorrente com o mesmo requestId é idempotente e persiste', async (t) => {
  const { appPaths, config, store } = await createHarness(t)

  const [left, right] = await Promise.all([
    store.createJob(jobInput(config.workflow, { id: 'job-a' })),
    store.createJob(jobInput(config.workflow, { id: 'job-b' })),
  ])

  assert.equal([left, right].filter((result) => result.created).length, 1)
  assert.equal((await store.listJobs()).length, 1)
  assert.equal((await store.findByRequestId('request-0001')).requestId, 'request-0001')

  const reloaded = await new JobStore(appPaths).load()
  const jobs = await reloaded.listJobs()
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].workflow.steps[0].send.value, 'Olá')
})

test('trabalho bloqueante impede a seleção do próximo item da fila', async (t) => {
  const { config, store } = await createHarness(t)
  await store.createJob(jobInput(config.workflow, { id: 'job-first', requestId: 'request-first' }))
  await store.createJob(jobInput(config.workflow, { id: 'job-second', requestId: 'request-second' }))

  await store.updateJob('job-first', (job) => {
    job.status = 'waiting'
    job.waitingSince = new Date().toISOString()
  })

  assert.equal((await store.getBlockingJob()).id, 'job-first')
  assert.equal((await store.getNextQueuedJob()).id, 'job-second')
  assert.equal(await store.hasUnfinishedJobs(), true)
})

test('limpeza remove trabalho terminal antigo e seu PDF local', async (t) => {
  const { appPaths, config, store } = await createHarness(t)
  const attachmentPath = await store.savePdf('job-old', Buffer.from('%PDF-1.7\nold'))
  await store.createJob(jobInput(config.workflow, {
    id: 'job-old',
    requestId: 'request-old',
    attachmentPath,
  }))
  await store.transact((state) => {
    const job = state.jobs.find((candidate) => candidate.id === 'job-old')
    job.status = 'completed'
    job.updatedAt = '2000-01-01T00:00:00.000Z'
  })

  assert.deepEqual(await store.cleanup(1), { removed: 1 })
  assert.equal((await store.listJobs()).length, 0)
  await assert.rejects(fs.access(attachmentPath))
  assert.equal(path.dirname(attachmentPath), appPaths.uploads)
})
