import crypto from 'node:crypto'
import fs from 'node:fs/promises'

import express from 'express'
import multer from 'multer'

import { bearerTokenFromRequest } from './token.js'
import {
  isPdfBuffer,
  redactError,
  sanitizeFileName,
  timingSafeTokenEqual,
} from './utils.js'

function publicJob(job) {
  return {
    id: job.id,
    requestId: job.requestId,
    status: job.status,
    currentStepId: job.workflow.steps[job.cursor]?.id ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
  }
}

function validateTextField(value, label, maximum = 100) {
  const text = String(value ?? '').normalize('NFC').trim()
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw Object.assign(new Error(`${label} deve ter entre 1 e ${maximum} caracteres válidos.`), { statusCode: 400 })
  }
  return text
}

function validateName(value, label) {
  const text = validateTextField(value, label)
  if (!/^[\p{L}\p{M} .'-]+$/u.test(text)) {
    throw Object.assign(new Error(`${label} contém caracteres não permitidos.`), { statusCode: 400 })
  }
  return text
}

function decodeBase64Pdf(value, maximumBytes) {
  if (typeof value !== 'string') return null
  const encoded = value.replace(/^data:application\/pdf;base64,/i, '').replace(/\s/g, '')
  if (!encoded || encoded.length > Math.ceil(maximumBytes * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw Object.assign(new Error('ticketPdfBase64 é inválido ou excede o limite.'), { statusCode: 400 })
  }
  return Buffer.from(encoded, 'base64')
}

function requestIdFrom(request) {
  const value = request.get('idempotency-key') ?? request.body?.requestId ?? crypto.randomUUID()
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw Object.assign(new Error('Idempotency-Key ou requestId deve ter de 8 a 128 caracteres seguros.'), { statusCode: 400 })
  }
  return value
}

function requiresPdf(workflow) {
  return workflow.steps.some((step) => step.send?.kind === 'document')
}

export function createWebhookApp({ config, token, store, engine, logger = console }) {
  const app = express()
  const maximumBytes = config.server.maxUploadMb * 1024 * 1024
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maximumBytes, files: 1, fields: 20 },
  })

  app.disable('x-powered-by')
  const parseJson = express.json({ limit: Math.ceil(maximumBytes * 1.5), strict: true })

  app.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      whatsapp: engine.connected ? 'connected' : 'disconnected',
    })
  })

  const requireToken = (request, response, next) => {
    if (!timingSafeTokenEqual(bearerTokenFromRequest(request), token)) {
      return response.status(401).json({ error: 'Token ausente ou inválido.' })
    }
    return next()
  }

  app.use('/api', requireToken, parseJson)

  const createJob = async (request, response, next) => {
    let attachmentPath = null
    try {
      const requestId = requestIdFrom(request)
      const existing = await store.findByRequestId(requestId)
      if (existing) return response.status(200).json({ created: false, job: publicJob(existing) })

      const pnr = validateTextField(request.body?.pnr, 'pnr', 6).toUpperCase()
      if (!/^[A-Z0-9]{6}$/.test(pnr)) {
        throw Object.assign(new Error('pnr deve conter exatamente 6 letras ou números.'), { statusCode: 400 })
      }
      const currentName = validateName(request.body?.currentName, 'currentName')
      const correctName = validateName(request.body?.correctName, 'correctName')

      let pdf = request.file?.buffer ?? decodeBase64Pdf(request.body?.ticketPdfBase64, maximumBytes)
      if (requiresPdf(config.workflow) && !pdf) {
        throw Object.assign(new Error('Envie o PDF no campo multipart ticket ou em ticketPdfBase64.'), { statusCode: 400 })
      }
      if (pdf && (pdf.length > maximumBytes || !isPdfBuffer(pdf))) {
        throw Object.assign(new Error('O arquivo deve ser um PDF válido dentro do limite configurado.'), { statusCode: 400 })
      }

      const ticketFileName = sanitizeFileName(request.file?.originalname ?? request.body?.ticketFileName, `bilhete-${pnr}.pdf`)
      if (!ticketFileName.toLocaleLowerCase('pt-BR').endsWith('.pdf')) {
        throw Object.assign(new Error('O nome do bilhete deve terminar em .pdf.'), { statusCode: 400 })
      }

      const id = crypto.randomUUID()
      if (pdf) attachmentPath = await store.savePdf(id, pdf)
      pdf = null

      const result = await store.createJob({
        id,
        requestId,
        payload: { pnr, currentName, correctName, ticketFileName },
        attachmentPath,
        workflow: config.workflow,
        targetNumber: config.whatsapp.monitoredNumber,
        supersedeUnfinished: true,
      })

      if (!result.created && attachmentPath) {
        await fs.rm(attachmentPath, { force: true }).catch(() => {})
      }

      if (result.created) {
        try {
          await engine.enqueue(result.job)
        } catch (error) {
          logger.error?.({ jobId: result.job.id, error: redactError(error) }, 'O trabalho foi salvo, mas o envio inicial precisa de revisão')
        }
      }

      const current = await store.getJob(result.job.id)
      const responseBody = {
        created: result.created,
        cancelledPreviousJobs: result.cancelledPreviousJobs ?? 0,
        job: publicJob(current),
      }
      if (current.status === 'queued') {
        const blocking = await store.getBlockingJob()
        if (blocking && blocking.id !== current.id) {
          responseBody.warning = 'O trabalho entrou na fila porque existe outro trabalho que precisa ser concluído, cancelado ou resolvido.'
          responseBody.blockedBy = publicJob(blocking)
        }
      }
      return response.status(result.created ? 202 : 200).json(responseBody)
    } catch (error) {
      if (attachmentPath) await fs.rm(attachmentPath, { force: true }).catch(() => {})
      return next(error)
    }
  }

  app.post('/api/jobs', upload.single('ticket'), createJob)
  app.post('/webhooks/name-correction', requireToken, parseJson, upload.single('ticket'), createJob)

  app.get('/api/jobs', async (_request, response, next) => {
    try {
      response.json({ jobs: (await store.listJobs()).map(publicJob) })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/jobs/:id', async (request, response, next) => {
    try {
      const job = await store.getJob(request.params.id)
      if (!job) return response.status(404).json({ error: 'Trabalho não encontrado.' })
      return response.json({ job: publicJob(job) })
    } catch (error) {
      return next(error)
    }
  })

  app.post('/api/jobs/:id/actions', async (request, response, next) => {
    try {
      const allowed = new Set(['cancel', 'resume-waiting', 'retry-send', 'assume-sent'])
      if (!allowed.has(request.body?.action)) {
        return response.status(400).json({ error: 'Ação inválida.' })
      }
      if (!(await store.getJob(request.params.id))) {
        return response.status(404).json({ error: 'Trabalho não encontrado.' })
      }
      let job
      try {
        job = await engine.resolveJob(request.params.id, request.body.action)
      } catch (error) {
        error.statusCode = 409
        throw error
      }
      return response.json({ job: publicJob(job) })
    } catch (error) {
      return next(error)
    }
  })

  app.use((error, _request, response, _next) => {
    const isSizeError = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
    const reportedStatus = Number(error.statusCode ?? error.status)
    const statusCode = isSizeError
      ? 413
      : (error instanceof multer.MulterError
          ? 400
          : (reportedStatus >= 400 && reportedStatus < 600 ? reportedStatus : 500))
    const message = statusCode >= 500 ? 'Erro interno. Consulte o terminal local.' : error.message
    if (statusCode >= 500) logger.error?.({ error: redactError(error) }, 'Erro no webhook')
    response.status(statusCode).json({ error: message })
  })

  return app
}

export function listenWebhook(app, config) {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.server.port, config.server.host, () => resolve(server))
    server.once('error', reject)
  })
}

export { publicJob }
