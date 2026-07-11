import { EventEmitter } from 'node:events'
import path from 'node:path'
import { URL } from 'node:url'

import makeWASocket, {
	areJidsSameUser,
	DisconnectReason,
	isLidUser,
	isPnUser,
	normalizeMessageContent,
	useMultiFileAuthState
} from '@whiskeysockets/baileys'
import pino from 'pino'
import QRCode from 'qrcode'

const DEFAULT_RECONNECT_OPTIONS = Object.freeze({
	enabled: true,
	baseDelayMs: 1_000,
	maxDelayMs: 30_000,
	jitterRatio: 0.2,
	maxAttempts: Number.POSITIVE_INFINITY
})

const STOP_REASONS = new Set([
	DisconnectReason.loggedOut,
	DisconnectReason.forbidden,
	DisconnectReason.multideviceMismatch,
	DisconnectReason.connectionReplaced,
	DisconnectReason.badSession
])

/**
 * Convert a user supplied phone number to E.164 digits without a leading plus.
 */
export function normalizePhoneNumber(value) {
	if (typeof value === 'number' && !Number.isSafeInteger(value)) {
		throw new TypeError('O numero deve ser informado como texto para evitar perda de digitos.')
	}

	if (typeof value !== 'string' && typeof value !== 'number') {
		throw new TypeError('Numero de WhatsApp invalido.')
	}

	const raw = String(value).trim()
	if (!raw || raw.includes('@') || /[a-z]/i.test(raw)) {
		throw new TypeError('Numero de WhatsApp invalido.')
	}

	const unprefixed = raw.startsWith('00') ? raw.slice(2) : raw
	const digits = unprefixed.replace(/\D/g, '')
	if (!/^\d{8,15}$/.test(digits)) {
		throw new RangeError('Informe o numero com DDI, usando entre 8 e 15 digitos.')
	}

	return digits
}

export function phoneNumberToJid(value) {
	return `${normalizePhoneNumber(value)}@s.whatsapp.net`
}

/**
 * Extract a Boom/HTTP-like status code without retaining or logging the error.
 */
export function getDisconnectStatusCode(error) {
	const candidates = [
		error,
		error?.output?.statusCode,
		error?.data?.statusCode,
		error?.statusCode,
		error?.status,
		error?.cause?.output?.statusCode,
		error?.cause?.statusCode,
		error?.cause?.status
	]

	for (const candidate of candidates) {
		const code = typeof candidate === 'string' ? Number(candidate) : candidate
		if (Number.isInteger(code)) {
			return code
		}
	}

	return undefined
}

/**
 * `restart` means a fresh socket is mandatory immediately after pairing.
 * `retry` means a transient/unknown failure and uses exponential backoff.
 * `stop` requires operator action or a new authentication.
 */
export function classifyDisconnect(statusCode) {
	if (statusCode === DisconnectReason.restartRequired) {
		return 'restart'
	}

	if (STOP_REASONS.has(statusCode)) {
		return 'stop'
	}

	return 'retry'
}

export function calculateReconnectDelay(
	attempt,
	{
		baseDelayMs = DEFAULT_RECONNECT_OPTIONS.baseDelayMs,
		maxDelayMs = DEFAULT_RECONNECT_OPTIONS.maxDelayMs,
		jitterRatio = DEFAULT_RECONNECT_OPTIONS.jitterRatio,
		random = Math.random
	} = {}
) {
	if (!Number.isInteger(attempt) || attempt < 0) {
		throw new RangeError('A tentativa de reconexao deve ser um inteiro nao negativo.')
	}

	if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
		throw new RangeError('baseDelayMs invalido.')
	}

	if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) {
		throw new RangeError('maxDelayMs invalido.')
	}

	if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
		throw new RangeError('jitterRatio deve estar entre 0 e 1.')
	}

	const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
	const randomValue = Math.min(1, Math.max(0, Number(random())))
	const jitter = exponentialDelay * jitterRatio * (randomValue * 2 - 1)

	return Math.max(0, Math.round(exponentialDelay + jitter))
}

function mappedPhoneJid(value) {
	if (typeof value === 'string') {
		if (isPnUser(value)) {
			return value
		}

		if (/^\d{8,15}$/.test(value)) {
			return `${value}@s.whatsapp.net`
		}
	}

	if (value && typeof value === 'object') {
		return mappedPhoneJid(value.phoneNumber ?? value.pn ?? value.jid ?? value.id)
	}

	return undefined
}

/**
 * Resolve a v7 LID to its phone-number JID when Baileys has the mapping locally.
 */
export async function resolvePhoneJidForLid(socket, lid) {
	if (!socket || typeof lid !== 'string' || !isLidUser(lid)) {
		return undefined
	}

	const mappingStore = socket.signalRepository?.lidMapping
	if (typeof mappingStore?.getPNForLID !== 'function') {
		return undefined
	}

	try {
		const result = await mappingStore.getPNForLID(lid)
		if (Array.isArray(result)) {
			for (const item of result) {
				const jid = mappedPhoneJid(item)
				if (jid) return jid
			}
			return undefined
		}

		return mappedPhoneJid(result)
	} catch {
		return undefined
	}
}

/**
 * Match only a direct chat from the configured target. Group participant fields
 * are intentionally not considered. Both PN/alternate JIDs and v7 LIDs work.
 */
export async function messageMatchesTarget(message, targetNumber, socket, { allowFromMe = false } = {}) {
	if (!message?.key || (!allowFromMe && message.key.fromMe) || !message.message) {
		return false
	}

	const remoteJid = message.key.remoteJid
	if (typeof remoteJid !== 'string' || (!isPnUser(remoteJid) && !isLidUser(remoteJid))) {
		return false
	}

	const targetJid = phoneNumberToJid(targetNumber)
	const candidates = [...new Set([remoteJid, message.key.remoteJidAlt].filter(Boolean))]

	for (const candidate of candidates) {
		if (typeof candidate === 'string' && isPnUser(candidate) && areJidsSameUser(candidate, targetJid)) {
			return true
		}
	}

	for (const candidate of candidates) {
		if (typeof candidate !== 'string' || !isLidUser(candidate)) continue
		const phoneJid = await resolvePhoneJidForLid(socket, candidate)
		if (phoneJid && areJidsSameUser(phoneJid, targetJid)) {
			return true
		}
	}

	return false
}

function textFromInteractiveResponse(response) {
	const paramsJson = response?.nativeFlowResponseMessage?.paramsJson
	if (typeof paramsJson !== 'string' || !paramsJson.trim()) return undefined

	try {
		const parsed = JSON.parse(paramsJson)
		for (const candidate of [parsed?.title, parsed?.text, parsed?.id]) {
			if (typeof candidate === 'string' && candidate.trim()) return candidate
		}
	} catch {
		return undefined
	}

	return undefined
}

/**
 * Extract only user-visible text that can safely advance the workflow. Protocol,
 * reaction, receipt and media-only messages intentionally return undefined.
 */
export function extractInboundText(message) {
	const content = normalizeMessageContent(message?.message)
	if (!content) return undefined

	const candidates = [
		content.conversation,
		content.extendedTextMessage?.text,
		content.buttonsResponseMessage?.selectedDisplayText,
		content.buttonsResponseMessage?.selectedButtonId,
		content.templateButtonReplyMessage?.selectedDisplayText,
		content.templateButtonReplyMessage?.selectedId,
		content.listResponseMessage?.title,
		content.listResponseMessage?.singleSelectReply?.selectedRowId,
		textFromInteractiveResponse(content.interactiveResponseMessage)
	]

	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim()) {
			return candidate
		}
	}

	return undefined
}

/**
 * Build the minimal envelope consumed by WorkflowEngine. The configured number
 * is used only after messageMatchesTarget has cryptographically mapped any LID.
 */
function sourceTimestampFromMessage(message) {
	const value = message?.messageTimestamp
	let seconds
	if (typeof value === 'number') seconds = value
	else if (typeof value === 'bigint') seconds = Number(value)
	else if (typeof value?.toNumber === 'function') seconds = value.toNumber()
	else if (typeof value?.low === 'number') seconds = value.low
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined
	const timestamp = new Date(seconds * 1000)
	if (Number.isNaN(timestamp.getTime())) return undefined
	return timestamp.toISOString()
}

export function toInboundMessage(message, targetNumber, observedAt = new Date()) {
	const id = message?.key?.id
	const text = extractInboundText(message)
	if (typeof id !== 'string' || !id || !text) return undefined

	const timestamp = observedAt instanceof Date ? observedAt : new Date(observedAt)
	if (Number.isNaN(timestamp.getTime())) {
		throw new RangeError('Horario local de recebimento invalido.')
	}

	return Object.freeze({
		id,
		fromNumber: normalizePhoneNumber(targetNumber),
		text,
		observedAt: timestamp.toISOString(),
		sourceTimestamp: sourceTimestampFromMessage(message),
		eligible: true
	})
}

export function sanitizePdfFileName(value, fallback = 'bilhete.pdf') {
	const fallbackName = String(fallback || 'bilhete.pdf')
	let fileName = typeof value === 'string' ? path.basename(value.trim()) : fallbackName
	fileName = fileName.replace(/[\u0000-\u001f\u007f]/g, '').trim()

	if (!fileName) fileName = fallbackName
	if (!/\.pdf$/i.test(fileName)) fileName += '.pdf'

	if (fileName.length > 120) {
		fileName = `${fileName.slice(0, 116)}.pdf`
	}

	return fileName
}

/**
 * Convert a path, URL, Buffer or Baileys media descriptor to WAMediaUpload.
 */
export function toDocumentUpload(source, cwd = process.cwd()) {
	if (Buffer.isBuffer(source)) {
		return source
	}

	if (source instanceof URL) {
		return { url: source }
	}

	if (typeof source === 'string' && source.trim()) {
		const value = source.trim()
		if (/^https?:\/\//i.test(value)) {
			return { url: value }
		}
		return { url: path.resolve(cwd, value) }
	}

	if (source && typeof source === 'object') {
		if ('url' in source && (typeof source.url === 'string' || source.url instanceof URL)) {
			return { ...source }
		}
		if ('stream' in source && source.stream) {
			return { ...source }
		}
	}

	throw new TypeError('PDF invalido: informe um caminho, URL, Buffer ou stream.')
}

function defaultFileNameForSource(source) {
	if (typeof source !== 'string') return 'bilhete.pdf'

	try {
		if (/^https?:\/\//i.test(source)) {
			return path.basename(new URL(source).pathname) || 'bilhete.pdf'
		}
	} catch {
		return 'bilhete.pdf'
	}

	return path.basename(source) || 'bilhete.pdf'
}

function forceSilentLogger(logger) {
	if (logger?.level === 'silent' && typeof logger.child === 'function') {
		return logger
	}

	// Never mutate a shared application logger: changing its level could hide
	// unrelated operational logs. Baileys receives its own silent instance.
	return pino({ level: 'silent' })
}

const LIBSIGNAL_LOG_FILTER = Symbol.for('latam-name-bot.libsignal-log-filter')

export function suppressUnsafeLibsignalLogs(consoleObject = console) {
	if (consoleObject[LIBSIGNAL_LOG_FILTER]) return
	const originalInfo = consoleObject.info.bind(consoleObject)
	consoleObject.info = (...arguments_) => {
		if (arguments_[0] === 'Closing session:') return
		originalInfo(...arguments_)
	}
	Object.defineProperty(consoleObject, LIBSIGNAL_LOG_FILTER, { value: true })
}

/**
 * Small, single-session Baileys client. The flow/state engine is deliberately
 * external; this class only transports filtered real-time messages.
 */
export class WhatsAppClient extends EventEmitter {
	constructor({
		authDirectory,
		authDir,
		targetNumber,
		socketConfig = {},
		reconnect = {},
		onConnectionChange,
		onConnectionUpdate,
		onMessage,
		onOwnMessage,
		onQr,
		onError,
		onDiagnostic,
		output = process.stdout,
		logger,
		socketFactory = makeWASocket,
		authStateFactory = useMultiFileAuthState,
		qrRenderer = (value, options) => QRCode.toString(value, options),
		random = Math.random
	} = {}) {
		super()

		const selectedAuthDirectory = authDirectory ?? authDir ?? path.resolve('.data', 'auth')
		if (typeof selectedAuthDirectory !== 'string' || !selectedAuthDirectory.trim()) {
			throw new TypeError('authDirectory deve ser um caminho nao vazio.')
		}
		this.authDirectory = path.resolve(selectedAuthDirectory)
		this._socketConfig = { ...socketConfig }
		delete this._socketConfig.printQRInTerminal

		this._reconnectOptions = {
			...DEFAULT_RECONNECT_OPTIONS,
			...reconnect
		}
		this._validateReconnectOptions()

		this._onConnectionChange = this._optionalCallback(onConnectionChange, 'onConnectionChange')
		this._onConnectionUpdate = this._optionalCallback(onConnectionUpdate, 'onConnectionUpdate')
		this._onMessage = this._optionalCallback(onMessage, 'onMessage')
		this._onOwnMessage = this._optionalCallback(onOwnMessage, 'onOwnMessage')
		this._onQr = this._optionalCallback(onQr, 'onQr')
		this._onError = this._optionalCallback(onError, 'onError')
		this._onDiagnostic = this._optionalCallback(onDiagnostic, 'onDiagnostic')
		this._output = output
		this._logger = forceSilentLogger(logger)
		this._socketFactory = socketFactory
		this._authStateFactory = authStateFactory
		this._qrRenderer = qrRenderer
		this._random = random

		this._socket = undefined
		this._socketHandlers = undefined
		this._authBundle = undefined
		this._connectPromise = undefined
		this._credentialsSavePromise = Promise.resolve()
		this._connectionOperation = Promise.resolve()
		this._messageOperation = Promise.resolve()
		this._reconnectTimer = undefined
		this._reconnectAttempt = 0
		this._started = false
		this._intentionalStop = false
		this._connection = 'close'
		suppressUnsafeLibsignalLogs()

		this.targetNumber = undefined
		this.targetJid = undefined
		if (targetNumber !== undefined && targetNumber !== null) {
			this.setTargetNumber(targetNumber)
		}
	}

	get socket() {
		return this._socket
	}

	get connectionState() {
		return this._connection
	}

	get started() {
		return this._started
	}

	setTargetNumber(value) {
		this.targetNumber = normalizePhoneNumber(value)
		this.targetJid = phoneNumberToJid(this.targetNumber)
		return this.targetNumber
	}

	async start() {
		if (!this.targetNumber) {
			throw new Error('Configure o numero monitorado antes de iniciar o WhatsApp.')
		}

		if (this._started && (this._socket || this._connectPromise)) {
			return this
		}

		this._started = true
		this._intentionalStop = false
		await this._connect()
		return this
	}

	async connect() {
		return this.start()
	}

	async stop() {
		await this._shutdown({ notify: true, preserveAuth: true })
	}

	async restart() {
		await this._shutdown({ notify: false, preserveAuth: true })
		this._started = true
		this._intentionalStop = false
		this._reconnectAttempt = 0
		await this._connect()
		return this
	}

	async logout() {
		this._started = false
		this._intentionalStop = true
		this._clearReconnectTimer()

		const socket = this._socket
		let logoutFailed = false
		if (socket?.logout) {
			try {
				await socket.logout()
			} catch {
				logoutFailed = true
				this._reportError('logout_failed')
			}
		} else {
			logoutFailed = true
		}

		await this._credentialsSavePromise
		await this._shutdown({ notify: true, preserveAuth: false })
		if (logoutFailed) {
			throw new Error('Nao foi possivel confirmar a desvinculacao remota do WhatsApp.')
		}
	}

	async sendText(text) {
		if (typeof text !== 'string' || !text.trim()) {
			throw new TypeError('A mensagem de texto nao pode estar vazia.')
		}

		const socket = this._readySocket()
		return socket.sendMessage(this.targetJid, { text })
	}

	async sendPdf(source, { fileName, caption } = {}) {
		if (caption !== undefined && typeof caption !== 'string') {
			throw new TypeError('A legenda do PDF deve ser um texto.')
		}

		const socket = this._readySocket()
		const content = {
			document: toDocumentUpload(source),
			mimetype: 'application/pdf',
			fileName: sanitizePdfFileName(fileName ?? defaultFileNameForSource(source))
		}

		if (caption) content.caption = caption
		return socket.sendMessage(this.targetJid, content)
	}

	async sendDocument(source, options = {}) {
		return this.sendPdf(source, options)
	}

	async isTargetMessage(message) {
		if (!this.targetNumber) return false
		return messageMatchesTarget(message, this.targetNumber, this._socket)
	}

	async _connect() {
		if (!this._started) return undefined
		if (this._connectPromise) return this._connectPromise

		this._connectPromise = (async () => {
			await this._credentialsSavePromise
			if (!this._authBundle) {
				this._authBundle = await this._authStateFactory(this.authDirectory)
			}

			this._detachSocketListeners()

			const socket = await this._socketFactory({
				...this._socketConfig,
				auth: this._authBundle.state,
				logger: this._logger,
				markOnlineOnConnect: this._socketConfig.markOnlineOnConnect ?? false,
				syncFullHistory: this._socketConfig.syncFullHistory ?? false,
				shouldSyncHistoryMessage:
					this._socketConfig.shouldSyncHistoryMessage ?? (() => false)
			})

			if (!this._started) {
				await socket.end?.(undefined)
				return undefined
			}

			this._socket = socket
			this._connection = 'connecting'
			this._attachSocketListeners(socket)
			void this._notifyConnection({ connection: 'connecting', action: 'wait' })
			return socket
		})()

		try {
			return await this._connectPromise
		} catch (error) {
			this._reportError('connection_start_failed')
			throw error
		} finally {
			this._connectPromise = undefined
		}
	}

	_attachSocketListeners(socket) {
		const onCredentialsUpdate = () => {
			this._credentialsSavePromise = this._credentialsSavePromise
				.then(() => this._authBundle.saveCreds())
				.catch(() => this._reportError('credentials_save_failed'))
		}

		const onConnectionUpdate = update => {
			this._connectionOperation = this._connectionOperation
				.then(() => this._handleConnectionUpdate(socket, update))
				.catch(() => this._reportError('connection_update_failed'))
		}

		const onMessagesUpsert = event => {
			const connectionPrerequisite = this._connectionOperation
			this._messageOperation = this._messageOperation
				.then(() => connectionPrerequisite)
				.then(() => this._handleMessagesUpsert(socket, event))
				.catch(() => this._reportError('message_handler_failed'))
		}

		this._socketHandlers = {
			socket,
			onCredentialsUpdate,
			onConnectionUpdate,
			onMessagesUpsert
		}

		socket.ev.on('creds.update', onCredentialsUpdate)
		socket.ev.on('connection.update', onConnectionUpdate)
		socket.ev.on('messages.upsert', onMessagesUpsert)
	}

	_detachSocketListeners() {
		const handlers = this._socketHandlers
		if (!handlers) return

		const remove = handlers.socket.ev.off?.bind(handlers.socket.ev)
			?? handlers.socket.ev.removeListener?.bind(handlers.socket.ev)

		if (remove) {
			remove('creds.update', handlers.onCredentialsUpdate)
			remove('connection.update', handlers.onConnectionUpdate)
			remove('messages.upsert', handlers.onMessagesUpsert)
		}

		this._socketHandlers = undefined
	}

	async _handleConnectionUpdate(socket, update = {}) {
		if (socket !== this._socket) return

		if (update.qr) {
			await this._printQr(update.qr)
		}

		if (update.connection === 'connecting') {
			this._connection = 'connecting'
			await this._notifyConnection({ connection: 'connecting', action: 'wait' })
			return
		}

		if (update.connection === 'open') {
			this._connection = 'open'
			this._reconnectAttempt = 0
			this._clearReconnectTimer()
			await this._notifyConnection({ connection: 'open', action: 'ready' })
			return
		}

		if (update.connection !== 'close') return

		this._connection = 'close'
		this._detachSocketListeners()
		if (this._socket === socket) this._socket = undefined

		const reason = getDisconnectStatusCode(update.lastDisconnect?.error)
		if (!this._started || this._intentionalStop) {
			await this._notifyConnection({ connection: 'close', reason, action: 'stopped' })
			return
		}

		const action = classifyDisconnect(reason)
		if (action === 'stop') {
			this._started = false
			await this._notifyConnection({
				connection: 'close',
				reason,
				action: 'operator_required'
			})
			return
		}

		if (action === 'retry' && !this._reconnectOptions.enabled) {
			this._started = false
			await this._notifyConnection({
				connection: 'close',
				reason,
				action: 'reconnect_disabled'
			})
			return
		}

		const schedule = this._scheduleReconnect(action === 'restart')
		if (!schedule) return

		await this._notifyConnection({
			connection: 'close',
			reason,
			action: 'reconnect',
			reconnectInMs: schedule.delay,
			attempt: schedule.attempt
		})
	}

	async _handleMessagesUpsert(socket, event = {}) {
		if (socket !== this._socket || event.type !== 'notify' || !Array.isArray(event.messages)) {
			return
		}

		const observedAt = new Date()
		for (const message of event.messages) {
			if (message?.key?.fromMe) {
				if (!(await messageMatchesTarget(message, this.targetNumber, socket, { allowFromMe: true }))) continue
				const id = message.key.id
				if (typeof id !== 'string' || !id) continue
				const ownMessage = Object.freeze({ id, observedAt: new Date().toISOString() })
				if (this._onOwnMessage) await this._onOwnMessage(ownMessage)
				this.emit('own-message', ownMessage)
				continue
			}
			if (!(await messageMatchesTarget(message, this.targetNumber, socket))) {
				if (this._onDiagnostic) await this._onDiagnostic({ reason: 'target_mismatch' })
				continue
			}
			const inbound = toInboundMessage(message, this.targetNumber, observedAt)
			if (!inbound) {
				if (this._onDiagnostic) await this._onDiagnostic({ reason: 'unsupported_content' })
				continue
			}

			if (this._onMessage) {
				await this._onMessage(inbound)
			}
			this.emit('message', inbound)
		}
	}

	_scheduleReconnect(immediate) {
		if (!this._started || this._reconnectTimer) return undefined

		const attemptIndex = this._reconnectAttempt
		if (attemptIndex >= this._reconnectOptions.maxAttempts) {
			this._started = false
			void this._notifyConnection({
				connection: 'close',
				action: 'reconnect_exhausted',
				attempt: attemptIndex
			})
			return undefined
		}

		this._reconnectAttempt += 1
		const delay = immediate
			? 0
			: calculateReconnectDelay(attemptIndex, {
				baseDelayMs: this._reconnectOptions.baseDelayMs,
				maxDelayMs: this._reconnectOptions.maxDelayMs,
				jitterRatio: this._reconnectOptions.jitterRatio,
				random: this._random
			})

		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = undefined
			void this._connect().catch(() => {
				if (!this._started) return
				this._reportError('reconnect_failed')
				this._scheduleReconnect(false)
			})
		}, delay)

		return { attempt: this._reconnectAttempt, delay }
	}

	async _printQr(qr) {
		try {
			const rendered = await this._qrRenderer(qr, { type: 'terminal' })
			this._output?.write?.(
				`\nEscaneie o QR code abaixo em WhatsApp > Dispositivos conectados:\n${rendered}\n`
			)
			if (this._onQr) await this._onQr()
			this.emit('qr')
		} catch {
			this._reportError('qr_render_failed')
		}
	}

	_readySocket() {
		if (!this._socket || this._connection !== 'open') {
			throw new Error('WhatsApp ainda nao esta conectado.')
		}
		if (!this.targetJid) {
			throw new Error('Numero monitorado nao configurado.')
		}
		return this._socket
	}

	async _shutdown({ notify, preserveAuth }) {
		this._started = false
		this._intentionalStop = true
		this._clearReconnectTimer()

		const socket = this._socket
		this._detachSocketListeners()
		this._socket = undefined
		this._connection = 'close'

		if (socket?.end) {
			try {
				await socket.end(undefined)
			} catch {
				this._reportError('socket_close_failed')
			}
		}

		if (!preserveAuth) this._authBundle = undefined
		if (notify) {
			await this._notifyConnection({ connection: 'close', action: 'stopped' })
		}
	}

	_clearReconnectTimer() {
		if (!this._reconnectTimer) return
		clearTimeout(this._reconnectTimer)
		this._reconnectTimer = undefined
	}

	async _notifyConnection(payload) {
		const safePayload = Object.freeze({
			connection: payload.connection,
			action: payload.action,
			...(payload.reason === undefined ? {} : { reason: payload.reason }),
			...(payload.reconnectInMs === undefined
				? {}
				: { reconnectInMs: payload.reconnectInMs }),
			...(payload.attempt === undefined ? {} : { attempt: payload.attempt })
		})

		const callbacks = []
		if (this._onConnectionChange && (safePayload.connection === 'open' || safePayload.connection === 'close')) {
			callbacks.push(Promise.resolve(
				this._onConnectionChange(safePayload.connection === 'open', safePayload)
			).catch(() => {
				this._reportError('connection_callback_failed')
			}))
		}

		if (this._onConnectionUpdate) {
			callbacks.push(Promise.resolve(this._onConnectionUpdate(safePayload)).catch(() => {
				this._reportError('connection_callback_failed')
			}))
		}
		this.emit('connection', safePayload)
		await Promise.all(callbacks)
	}

	_reportError(code) {
		const payload = Object.freeze({ code })
		if (this._onError) {
			Promise.resolve(this._onError(payload)).catch(() => {})
		}
		this.emit('client.error', payload)
	}

	_optionalCallback(value, name) {
		if (value === undefined || value === null) return undefined
		if (typeof value !== 'function') {
			throw new TypeError(`${name} deve ser uma funcao.`)
		}
		return value
	}

	_validateReconnectOptions() {
		const options = this._reconnectOptions
		if (typeof options.enabled !== 'boolean') {
			throw new TypeError('reconnect.enabled deve ser booleano.')
		}

		if (options.maxAttempts === 0) {
			options.maxAttempts = Number.POSITIVE_INFINITY
		}
		calculateReconnectDelay(0, {
			baseDelayMs: options.baseDelayMs,
			maxDelayMs: options.maxDelayMs,
			jitterRatio: options.jitterRatio,
			random: () => 0.5
		})

		if (
			options.maxAttempts !== Number.POSITIVE_INFINITY
			&& (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 0)
		) {
			throw new RangeError('maxAttempts deve ser um inteiro nao negativo ou Infinity.')
		}
	}
}

export default WhatsAppClient
