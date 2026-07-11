import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { initializeLocalStorage } from './local-storage.js'
import { assertPathInside, atomicWriteJson, ensurePrivateDirectory, pathExists, readJson } from './utils.js'

const TERMINAL_STATUSES = new Set(['completed', 'cancelled'])
const BLOCKING_STATUSES = new Set([
  'sending',
  'waiting',
  'timed_out',
  'send_uncertain',
  'failed',
  'manual_intervention',
])

function nowIso() {
  return new Date().toISOString()
}

function clone(value) {
  return structuredClone(value)
}

export class JobStore {
  constructor(appPaths) {
    this.paths = appPaths
    this.state = { schemaVersion: 1, jobs: [], consumedInboundMessages: [] }
    this.operation = Promise.resolve()
  }

  async load() {
    await initializeLocalStorage(this.paths)
    await ensurePrivateDirectory(this.paths.uploads)
    if (await pathExists(this.paths.jobs)) {
      const state = await readJson(this.paths.jobs)
      if (state?.schemaVersion !== 1 || !Array.isArray(state.jobs)) {
        throw new Error(`O banco local de trabalhos é incompatível: ${this.paths.jobs}`)
      }
      state.consumedInboundMessages ??= []
      if (!Array.isArray(state.consumedInboundMessages)) {
        throw new Error(`O ledger local de mensagens é incompatível: ${this.paths.jobs}`)
      }
      this.state = state
    } else {
      await this.#persist()
    }
    return this
  }

  #serialize(callback) {
    const run = this.operation.then(callback)
    this.operation = run.catch(() => {})
    return run
  }

  async #persist() {
    await atomicWriteJson(this.paths.jobs, this.state)
  }

  async transact(mutator) {
    return this.#serialize(async () => {
      const result = await mutator(this.state)
      await this.#persist()
      return clone(result)
    })
  }

  async snapshot() {
    await this.operation
    return clone(this.state)
  }

  async listJobs() {
    const { jobs } = await this.snapshot()
    return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async getJob(id) {
    const { jobs } = await this.snapshot()
    return jobs.find((job) => job.id === id) ?? null
  }

  async findByRequestId(requestId) {
    const { jobs } = await this.snapshot()
    return jobs.find((job) => job.requestId === requestId) ?? null
  }

  async hasConsumedInbound(targetNumber, messageId) {
    const { consumedInboundMessages } = await this.snapshot()
    return consumedInboundMessages.some((entry) => entry.targetNumber === targetNumber && entry.messageId === messageId)
  }

  async consumeInbound(jobId, { messageId, targetNumber, observedAt, sourceTimestamp, stepId }) {
    return this.transact((state) => {
      const duplicate = state.consumedInboundMessages.some(
        (entry) => entry.targetNumber === targetNumber && entry.messageId === messageId,
      )
      if (duplicate) return false

      const job = state.jobs.find((candidate) => candidate.id === jobId)
      if (!job) throw new Error(`Trabalho não encontrado: ${jobId}`)
      state.consumedInboundMessages.push({
        targetNumber,
        messageId,
        observedAt,
        sourceTimestamp: sourceTimestamp ?? null,
      })
      if (state.consumedInboundMessages.length > 2_000) {
        state.consumedInboundMessages = state.consumedInboundMessages.slice(-2_000)
      }
      job.consumedInboundIds.push(messageId)
      job.lastInboundAt = observedAt
      job.updatedAt = nowIso()
      job.history.push({
        at: observedAt,
        event: 'inbound_consumed',
        stepId,
        messageId,
        sourceTimestamp: sourceTimestamp ?? null,
      })
      return true
    })
  }

  async createJob({ id, requestId, payload, attachmentPath, workflow, targetNumber }) {
    return this.transact((state) => {
      const existing = state.jobs.find((job) => job.requestId === requestId)
      if (existing) return { job: existing, created: false }

      const timestamp = nowIso()
      const job = {
        id: id ?? crypto.randomUUID(),
        requestId,
        status: 'queued',
        cursor: 0,
        targetNumber,
        payload: clone(payload),
        attachmentPath,
        workflow: clone(workflow),
        createdAt: timestamp,
        updatedAt: timestamp,
        waitingSince: null,
        lastInboundAt: null,
        lastOutboundAt: null,
        pendingStepId: null,
        outboundMessageIds: [],
        consumedInboundIds: [],
        history: [{ at: timestamp, event: 'created' }],
        error: null,
      }
      state.jobs.push(job)
      return { job, created: true }
    })
  }

  async updateJob(id, updater) {
    return this.transact((state) => {
      const job = state.jobs.find((candidate) => candidate.id === id)
      if (!job) throw new Error(`Trabalho não encontrado: ${id}`)
      const result = updater(job) ?? job
      job.updatedAt = nowIso()
      if (job.history.length > 200) job.history = job.history.slice(-200)
      if (job.outboundMessageIds.length > 200) job.outboundMessageIds = job.outboundMessageIds.slice(-200)
      if (job.consumedInboundIds.length > 200) job.consumedInboundIds = job.consumedInboundIds.slice(-200)
      return result
    })
  }

  async getBlockingJob() {
    const { jobs } = await this.snapshot()
    return jobs.find((job) => BLOCKING_STATUSES.has(job.status)) ?? null
  }

  async getNextQueuedJob() {
    const { jobs } = await this.snapshot()
    return jobs
      .filter((job) => job.status === 'queued')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0] ?? null
  }

  async hasUnfinishedJobs() {
    const { jobs } = await this.snapshot()
    return jobs.some((job) => !TERMINAL_STATUSES.has(job.status))
  }

  async cleanup(retentionDays) {
    if (retentionDays < 0) return { removed: 0 }
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const ledgerCutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000
    const pathsToRemove = []

    const result = await this.transact((state) => {
      const before = state.jobs.length
      state.consumedInboundMessages = state.consumedInboundMessages.filter(
        (entry) => Date.parse(entry.observedAt) >= ledgerCutoff,
      )
      state.jobs = state.jobs.filter((job) => {
        const removable = TERMINAL_STATUSES.has(job.status) && Date.parse(job.updatedAt) < cutoff
        if (removable && job.attachmentPath) pathsToRemove.push(job.attachmentPath)
        return !removable
      })
      return { removed: before - state.jobs.length }
    })

    for (const filePath of pathsToRemove) {
      try {
        const safePath = assertPathInside(this.paths.uploads, filePath)
        await fs.rm(safePath, { force: true })
      } catch {
        // Nunca deixe uma falha de limpeza interromper o bot.
      }
    }
    return result
  }

  async savePdf(jobId, buffer) {
    const filePath = assertPathInside(this.paths.uploads, path.join(this.paths.uploads, `${jobId}.pdf`))
    await fs.writeFile(filePath, buffer, { mode: 0o600, flag: 'wx' })
    if (process.platform !== 'win32') await fs.chmod(filePath, 0o600).catch(() => {})
    return filePath
  }
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status)
}
