import { normalizeMatchText, redactError, renderTemplate, sanitizeFileName } from './utils.js'
import safeRegex from 'safe-regex2'

const RESUMABLE_STATUSES = new Set(['timed_out', 'manual_intervention'])
const PROCESSING_NOTICE = 'estou processando sua solicitacao'

function isoNow() {
  return new Date().toISOString()
}

function messageMatches(awaitRule, message) {
  if (!message || message.eligible === false) return false
  if (awaitRule.mode === 'any_inbound') return true

  const text = normalizeMatchText(String(message.text ?? '').slice(0, 4096))
  if (!text) return false
  if (awaitRule.mode === 'contains') {
    return awaitRule.anyOf.some((candidate) => text.includes(normalizeMatchText(candidate)))
  }
  if (awaitRule.mode === 'regex') {
    return awaitRule.anyOf.some((pattern) => (
      pattern.length <= 500 && safeRegex(pattern) && new RegExp(pattern, 'iu').test(text)
    ))
  }
  return false
}

function inboundRuleMatches(rule, message) {
  if (!message || message.eligible === false) return false
  const text = normalizeMatchText(String(message.text ?? '').slice(0, 4096))
  return Boolean(text) && rule.match.allOf.every((candidate) => text.includes(normalizeMatchText(candidate)))
}

export class WorkflowEngine {
  constructor({ store, whatsapp, config, logger = console }) {
    this.store = store
    this.whatsapp = whatsapp
    this.config = config
    this.logger = logger
    this.connected = false
    this.operation = Promise.resolve()
    this.timeout = null
    this.stopping = false
  }

  #serialize(callback) {
    const run = this.operation.then(callback)
    this.operation = run.catch(() => {})
    return run
  }

  async initialize() {
    const snapshot = await this.store.snapshot()
    for (const job of snapshot.jobs.filter((candidate) => candidate.status === 'sending')) {
      await this.store.updateJob(job.id, (mutable) => {
        mutable.status = 'send_uncertain'
        mutable.error = 'O processo anterior terminou durante um envio. É necessária revisão manual.'
        mutable.history.push({ at: isoNow(), event: 'recovered_as_send_uncertain', stepId: mutable.pendingStepId })
      })
    }
  }

  async setConnected(connected) {
    return this.#serialize(async () => {
      this.connected = connected
      if (!connected) {
        this.#clearTimeout()
        return
      }

      const blocking = await this.store.getBlockingJob()
      if (blocking?.status === 'waiting') {
        await this.store.updateJob(blocking.id, (job) => {
          job.waitingSince = isoNow()
          job.history.push({ at: job.waitingSince, event: 'waiting_resumed_after_connection' })
        })
        await this.#scheduleCurrentTimeout()
        return
      }
      await this.#kick()
    })
  }

  async enqueue(job) {
    return this.#serialize(async () => {
      if (job.status !== 'queued') return job
      await this.#kick()
      return this.store.getJob(job.id)
    })
  }

  async handleInbound(message) {
    return this.#serialize(async () => {
      if (!this.connected || this.stopping) return { accepted: false, reason: 'disconnected' }
      if (!message?.id || message.fromNumber !== this.config.whatsapp.monitoredNumber) {
        return { accepted: false, reason: 'sender' }
      }

      const job = await this.store.getBlockingJob()
      if (!job || job.status !== 'waiting') return { accepted: false, reason: 'no_waiting_job' }
      if (job.targetNumber !== message.fromNumber) return { accepted: false, reason: 'job_sender' }
      if (
        job.consumedInboundIds.includes(message.id)
        || await this.store.hasConsumedInbound(message.fromNumber, message.id)
      ) return { accepted: false, reason: 'duplicate' }

      const observedAt = Date.parse(message.observedAt ?? isoNow())
      if (job.waitingSince && Number.isFinite(observedAt) && observedAt < Date.parse(job.waitingSince)) {
        return { accepted: false, reason: 'old_message' }
      }

      const inboundRule = (job.workflow.inboundRules ?? []).find((rule) => inboundRuleMatches(rule, message))
      const step = job.workflow.steps[job.cursor]
      if (inboundRule) {
        this.#clearTimeout()
        const consumed = await this.store.consumeInbound(job.id, {
          messageId: message.id,
          targetNumber: message.fromNumber,
          observedAt: message.observedAt ?? isoNow(),
          sourceTimestamp: message.sourceTimestamp,
          stepId: `rule:${inboundRule.id}`,
        })
        if (!consumed) return { accepted: false, reason: 'duplicate' }
        await this.#sendTerminalRule(job.id, inboundRule)
        return { accepted: true, completed: true, jobId: job.id, ruleId: inboundRule.id }
      }
      if (!step || step.await?.mode === 'job_created' || !messageMatches(step.await, message)) {
        if (normalizeMatchText(message.text).includes(PROCESSING_NOTICE)) {
          return { accepted: false, reason: 'processing_notice', jobId: job.id, stepId: step.id }
        }
        return { accepted: false, reason: 'matcher' }
      }

      this.#clearTimeout()
      const consumed = await this.store.consumeInbound(job.id, {
        messageId: message.id,
        targetNumber: message.fromNumber,
        observedAt: message.observedAt ?? isoNow(),
        sourceTimestamp: message.sourceTimestamp,
        stepId: step.id,
      })
      if (!consumed) return { accepted: false, reason: 'duplicate' }

      if (step.terminal === 'success') {
        await this.store.updateJob(job.id, (mutable) => {
          mutable.status = 'completed'
          mutable.cursor += 1
          mutable.waitingSince = null
          mutable.pendingStepId = null
          mutable.error = null
          mutable.history.push({ at: isoNow(), event: 'completed' })
        })
        this.logger.info?.({ jobId: job.id }, 'Trabalho concluído')
        await this.#kick()
        return { accepted: true, completed: true, jobId: job.id }
      }

      await this.#sendStep(job.id, step)
      return { accepted: true, completed: false, jobId: job.id, stepId: step.id }
    })
  }

  async handleOwnOutbound(message) {
    return this.#serialize(async () => {
      if (!message?.id) return { paused: false, reason: 'missing_id' }
      const job = await this.store.getBlockingJob()
      if (!job || !['waiting', 'sending'].includes(job.status)) {
        return { paused: false, reason: 'no_active_job' }
      }
      if (job.outboundMessageIds.includes(message.id)) {
        return { paused: false, reason: 'bot_message' }
      }

      this.#clearTimeout()
      await this.store.updateJob(job.id, (mutable) => {
        mutable.status = 'manual_intervention'
        mutable.error = 'Foi detectada uma mensagem manual nesta conversa. Revise antes de continuar.'
        mutable.history.push({
          at: message.observedAt ?? isoNow(),
          event: 'manual_intervention',
          messageId: message.id,
        })
      })
      this.logger.warn?.({ jobId: job.id }, 'Trabalho pausado por intervenção manual')
      return { paused: true, jobId: job.id }
    })
  }

  async resolveJob(jobId, action) {
    return this.#serialize(async () => {
      const job = await this.store.getJob(jobId)
      if (!job) throw new Error('Trabalho não encontrado.')

      if (action === 'cancel') {
        if (job.status === 'completed' || job.status === 'cancelled') return job
        this.#clearTimeout()
        await this.store.updateJob(job.id, (mutable) => {
          mutable.status = 'cancelled'
          mutable.waitingSince = null
          mutable.pendingStepId = null
          mutable.history.push({ at: isoNow(), event: 'cancelled_by_user' })
        })
        await this.#kick()
        return this.store.getJob(job.id)
      }

      if (action === 'resume-waiting' && RESUMABLE_STATUSES.has(job.status)) {
        await this.store.updateJob(job.id, (mutable) => {
          mutable.status = 'waiting'
          mutable.waitingSince = isoNow()
          mutable.error = null
          mutable.history.push({ at: mutable.waitingSince, event: 'resumed_by_user' })
        })
        await this.#scheduleCurrentTimeout()
        return this.store.getJob(job.id)
      }

      if (job.status === 'send_uncertain' && (action === 'retry-send' || action === 'assume-sent')) {
        const pendingRuleId = job.pendingStepId?.startsWith('rule:') ? job.pendingStepId.slice(5) : null
        const pendingRule = pendingRuleId
          ? (job.workflow.inboundRules ?? []).find((rule) => rule.id === pendingRuleId)
          : null
        if (pendingRule) {
          if (action === 'retry-send') {
            await this.#sendTerminalRule(job.id, pendingRule, { retry: true })
          } else {
            await this.#completeTerminalRule(job.id, pendingRule.id, 'uncertain_send_assumed_sent')
          }
          return this.store.getJob(job.id)
        }

        const pendingIndex = job.workflow.steps.findIndex((step) => step.id === job.pendingStepId)
        if (pendingIndex < 0) throw new Error('O passo de envio incerto não existe mais no snapshot do trabalho.')

        if (action === 'retry-send') {
          await this.#sendStep(job.id, job.workflow.steps[pendingIndex], { retry: true })
        } else {
          await this.store.updateJob(job.id, (mutable) => {
            mutable.cursor = pendingIndex + 1
            mutable.status = 'waiting'
            mutable.waitingSince = isoNow()
            mutable.error = null
            mutable.history.push({ at: mutable.waitingSince, event: 'uncertain_send_assumed_sent', stepId: mutable.pendingStepId })
            mutable.pendingStepId = null
          })
          await this.#scheduleCurrentTimeout()
        }
        return this.store.getJob(job.id)
      }

      throw new Error(`A ação ${action} não é válida para o estado ${job.status}.`)
    })
  }

  async #kick() {
    if (!this.connected || this.stopping) return
    if (await this.store.getBlockingJob()) return

    const next = await this.store.getNextQueuedJob()
    if (!next) return
    const expiresAt = Date.parse(next.createdAt) + next.workflow.jobTimeoutMinutes * 60_000
    if (Date.now() >= expiresAt) {
      await this.store.updateJob(next.id, (job) => {
        job.status = 'timed_out'
        job.error = 'O trabalho expirou na fila antes do primeiro envio.'
        job.history.push({ at: isoNow(), event: 'queued_job_timed_out' })
      })
      return
    }
    if (!this.#destinationMatches(next)) {
      await this.store.updateJob(next.id, (job) => {
        job.status = 'failed'
        job.error = 'O número ativo não corresponde ao número deste trabalho. Nenhuma mensagem foi enviada.'
        job.history.push({ at: isoNow(), event: 'destination_mismatch_blocked' })
      })
      return
    }
    const firstStep = next.workflow.steps[next.cursor]
    if (firstStep?.await?.mode !== 'job_created' || !firstStep.send) {
      await this.store.updateJob(next.id, (job) => {
        job.status = 'failed'
        job.error = 'O primeiro passo do snapshot não pode iniciar o trabalho.'
        job.history.push({ at: isoNow(), event: 'invalid_initial_step' })
      })
      return
    }
    await this.#sendStep(next.id, firstStep)
  }

  async #sendStep(jobId, step, options = {}) {
    if (!this.connected) throw new Error('WhatsApp desconectado.')
    const before = await this.store.getJob(jobId)
    if (!before) throw new Error('Trabalho não encontrado antes do envio.')
    if (!this.#destinationMatches(before)) {
      await this.store.updateJob(jobId, (job) => {
        job.status = 'failed'
        job.error = 'O número ativo não corresponde ao número deste trabalho. Nenhuma mensagem foi enviada.'
        job.history.push({ at: isoNow(), event: 'destination_mismatch_blocked', stepId: step.id })
      })
      throw new Error('Envio bloqueado porque o destinatário ativo não corresponde ao trabalho.')
    }

    const sendStartedAt = isoNow()
    await this.store.updateJob(jobId, (job) => {
      job.status = 'sending'
      job.pendingStepId = step.id
      job.waitingSince = sendStartedAt
      job.error = null
      job.history.push({ at: sendStartedAt, event: options.retry ? 'send_retry_started' : 'send_started', stepId: step.id })
    })

    try {
      let result
      if (step.send.kind === 'text') {
        const text = renderTemplate(step.send.value, before.payload)
        result = await this.whatsapp.sendText(text)
      } else {
        if (!before.attachmentPath) throw new Error('O PDF deste trabalho não está disponível.')
        const fileName = sanitizeFileName(renderTemplate(step.send.fileName, before.payload), 'bilhete.pdf')
        const caption = step.send.caption ? renderTemplate(step.send.caption, before.payload) : undefined
        result = await this.whatsapp.sendDocument(before.attachmentPath, { fileName, caption })
      }

      const sentAt = isoNow()
      await this.store.updateJob(jobId, (job) => {
        job.cursor += 1
        job.status = 'waiting'
        job.lastOutboundAt = sentAt
        job.waitingSince = sendStartedAt
        job.pendingStepId = null
        if (result?.key?.id) job.outboundMessageIds.push(result.key.id)
        job.history.push({ at: sentAt, event: 'sent', stepId: step.id, messageId: result?.key?.id ?? null })
      })
      this.logger.info?.({ jobId, stepId: step.id }, 'Passo enviado')
      await this.#scheduleCurrentTimeout()
    } catch (error) {
      const safeError = redactError(error)
      await this.store.updateJob(jobId, (job) => {
        job.status = 'send_uncertain'
        job.error = safeError
        job.history.push({ at: isoNow(), event: 'send_uncertain', stepId: step.id })
      })
      this.logger.error?.({ jobId, stepId: step.id, error: safeError }, 'Envio incerto; revisão necessária')
      throw error
    }
  }

  async #completeTerminalRule(jobId, ruleId, event = 'conditional_rule_completed', result) {
    const completedAt = isoNow()
    await this.store.updateJob(jobId, (job) => {
      job.status = 'completed'
      job.lastOutboundAt = completedAt
      job.waitingSince = null
      job.pendingStepId = null
      job.error = null
      if (result?.key?.id) job.outboundMessageIds.push(result.key.id)
      job.history.push({ at: completedAt, event, ruleId, messageId: result?.key?.id ?? null })
    })
    this.logger.info?.({ jobId, ruleId }, 'Trabalho concluído por regra condicional')
    await this.#kick()
  }

  async #sendTerminalRule(jobId, rule, options = {}) {
    if (!this.connected) throw new Error('WhatsApp desconectado.')
    const before = await this.store.getJob(jobId)
    if (!before) throw new Error('Trabalho não encontrado antes do envio condicional.')
    if (!this.#destinationMatches(before)) throw new Error('Envio condicional bloqueado por divergência de destinatário.')

    const pendingStepId = `rule:${rule.id}`
    const sendStartedAt = isoNow()
    await this.store.updateJob(jobId, (job) => {
      job.status = 'sending'
      job.pendingStepId = pendingStepId
      job.waitingSince = sendStartedAt
      job.error = null
      job.history.push({ at: sendStartedAt, event: options.retry ? 'conditional_send_retry_started' : 'conditional_send_started', ruleId: rule.id })
    })

    try {
      const text = renderTemplate(rule.send.value, before.payload)
      const result = await this.whatsapp.sendText(text)
      await this.#completeTerminalRule(jobId, rule.id, 'conditional_rule_completed', result)
    } catch (error) {
      const safeError = redactError(error)
      await this.store.updateJob(jobId, (job) => {
        job.status = 'send_uncertain'
        job.error = safeError
        job.history.push({ at: isoNow(), event: 'conditional_send_uncertain', ruleId: rule.id })
      })
      this.logger.error?.({ jobId, ruleId: rule.id, error: safeError }, 'Envio condicional incerto; revisão necessária')
      throw error
    }
  }

  async #scheduleCurrentTimeout() {
    this.#clearTimeout()
    if (!this.connected || this.stopping) return
    const job = await this.store.getBlockingJob()
    if (!job || job.status !== 'waiting') return

    const stepTimeoutMs = job.workflow.stepTimeoutMinutes * 60_000
    const jobTimeoutMs = job.workflow.jobTimeoutMinutes * 60_000
    const stepRemaining = Math.max(1, Date.parse(job.waitingSince) + stepTimeoutMs - Date.now())
    const jobRemaining = Math.max(1, Date.parse(job.createdAt) + jobTimeoutMs - Date.now())
    const delay = Math.min(stepRemaining, jobRemaining)
    const expectedCursor = job.cursor

    this.timeout = setTimeout(() => {
      void this.#serialize(async () => {
        const current = await this.store.getJob(job.id)
        if (!current || current.status !== 'waiting' || current.cursor !== expectedCursor) return
        await this.store.updateJob(current.id, (mutable) => {
          mutable.status = 'timed_out'
          mutable.error = 'Tempo de espera excedido; revise a conversa antes de continuar.'
          mutable.history.push({ at: isoNow(), event: 'timed_out', cursor: mutable.cursor })
        })
        this.logger.warn?.({ jobId: current.id }, 'Trabalho pausado por timeout')
      })
    }, Math.min(delay, 2_147_483_647))
    this.timeout.unref?.()
  }

  #clearTimeout() {
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
  }

  #destinationMatches(job) {
    if (job.targetNumber !== this.config.whatsapp.monitoredNumber) return false
    if (this.whatsapp.targetNumber && this.whatsapp.targetNumber !== job.targetNumber) return false
    return true
  }

  async stop() {
    this.stopping = true
    this.#clearTimeout()
    await this.operation
  }
}

export { messageMatches }
