import { Response } from 'express'
import { IServerSideEventStreamer } from '@cuttlely/components'

export type SSEFrame =
    | { kind: 'event'; payload: Record<string, unknown> } // every stream*Event object, all keys
    | { kind: 'comment'; text: string } // heartbeat
    | { kind: 'final'; payload: Record<string, unknown> } // removeClient end frame, TTS abort frame

export type SSEEncoder = (frame: SSEFrame) => string | null // null writes nothing

export const defaultSSEEncoder: SSEEncoder = (frame) => {
    if (frame.kind === 'comment') return `:${frame.text}\n\n`
    return 'message:\ndata:' + JSON.stringify(frame.payload) + '\n\n'
}

// define a new type that has a client type (INTERNAL or EXTERNAL) and Response type
type Client = {
    // future use
    clientType: 'INTERNAL' | 'EXTERNAL'
    response: Response
    // optional property with default value
    started?: boolean
    encoder?: SSEEncoder
}

export class SSEStreamer implements IServerSideEventStreamer {
    private readonly clients: Map<string, Client> = new Map()
    // Observers receive a passive copy of every event written for `sourceChatId` — one source,
    // many destinations. Use cases: webhook listener panels watching an in-flight execution,
    // multi-tab chat sync, admin shadowing, test/eval harnesses. Per-replica only — cross-replica
    // fan-out happens upstream by having the observer's replica subscribe to the source chatId itself.
    private readonly observers: Map<string, Set<string>> = new Map()
    private heartbeatInterval: NodeJS.Timeout | null = null

    hasClient(chatId: string): boolean {
        return this.clients.has(chatId)
    }

    /**
     * True when there's either a real client or at least one active observer for this chatId.
     */
    hasClientOrObserver(chatId: string): boolean {
        return this.clients.has(chatId) || (this.observers.get(chatId)?.size ?? 0) > 0
    }

    addObserver(sourceChatId: string, observerId: string) {
        let set = this.observers.get(sourceChatId)
        if (!set) {
            set = new Set()
            this.observers.set(sourceChatId, set)
        }
        set.add(observerId)
    }

    removeObserver(sourceChatId: string, observerId: string) {
        const set = this.observers.get(sourceChatId)
        if (!set) return
        set.delete(observerId)
        if (set.size === 0) this.observers.delete(sourceChatId)
    }

    clearObservers(sourceChatId: string) {
        this.observers.delete(sourceChatId)
    }

    addExternalClient(chatId: string, res: Response, encoder?: SSEEncoder) {
        this.clients.set(chatId, { clientType: 'EXTERNAL', response: res, started: false, encoder })
    }

    tryAddExternalClient(chatId: string, res: Response, encoder: SSEEncoder): boolean {
        if (this.clients.has(chatId)) return false
        this.addExternalClient(chatId, res, encoder)
        return true
    }

    addClient(chatId: string, res: Response) {
        this.clients.set(chatId, { clientType: 'INTERNAL', response: res, started: false })
    }

    private writeEncoded(client: Client, encoded: string): boolean {
        try {
            client.response.write(encoded)
            return true
        } catch {
            return false
        }
    }

    /**
     * Write `frame` to the source client with that client's encoder (default when none).
     * A string is written and emit returns whether the write succeeded (as safeWrite does today).
     * null writes nothing and returns true, so streamStartEvent still sets client.started exactly
     * once and never retries a suppressed start frame. Observers always get the default encoding.
     */
    private emit(chatId: string, frame: SSEFrame): boolean {
        const client = this.clients.get(chatId)
        let ok = false
        if (client) {
            const encoded = (client.encoder ?? defaultSSEEncoder)(frame)
            if (encoded === null) {
                ok = true
            } else if (this.writeEncoded(client, encoded)) {
                ok = true
            } else {
                this.clients.delete(chatId)
            }
        }

        const observerBytes = defaultSSEEncoder(frame)
        const observerSet = this.observers.get(chatId)
        if (observerBytes !== null && observerSet && observerSet.size > 0) {
            for (const observerId of Array.from(observerSet)) {
                const observer = this.clients.get(observerId)
                if (!observer) {
                    observerSet.delete(observerId)
                    continue
                }
                if (!this.writeEncoded(observer, observerBytes)) {
                    this.clients.delete(observerId)
                    observerSet.delete(observerId)
                }
            }
            if (observerSet.size === 0) this.observers.delete(chatId)
        }

        return ok
    }

    removeClient(chatId: string) {
        const client = this.clients.get(chatId)
        if (client) {
            try {
                const payload = {
                    event: 'end',
                    data: '[DONE]'
                }
                const encoded = (client.encoder ?? defaultSSEEncoder)({ kind: 'final', payload })
                if (encoded !== null) client.response.write(encoded)
                client.response.end()
            } catch {
                // Client already disconnected, ignore write errors
            } finally {
                this.clients.delete(chatId)
            }
        }

        // Notify any observers that this execution finished, but keep their long-lived
        // connections open for whatever they're observing next. UI transitions in_progress → done → idle.
        const observerSet = this.observers.get(chatId)
        if (observerSet && observerSet.size > 0) {
            for (const observerId of Array.from(observerSet)) {
                const observer = this.clients.get(observerId)
                if (!observer) continue
                try {
                    const payload = { event: 'executionEnd', data: { chatId } }
                    observer.response.write(defaultSSEEncoder({ kind: 'event', payload }) as string)
                } catch {
                    this.clients.delete(observerId)
                }
            }
            this.observers.delete(chatId)
        }

        // If the removed `chatId` was itself an observer, scrub it from every observer Set that
        // still references it. Otherwise stale references would sit in memory until the next
        // write to each observed chatId organically failed and lazily cleaned them up.
        for (const [sourceId, observerIds] of this.observers) {
            if (observerIds.delete(chatId) && observerIds.size === 0) {
                this.observers.delete(sourceId)
            }
        }
    }

    streamCustomEvent(chatId: string, eventType: string, data: any) {
        this.emit(chatId, { kind: 'event', payload: { event: eventType, data: data } })
    }

    streamStartEvent(chatId: string, data: string) {
        const client = this.clients.get(chatId)
        // prevent multiple start events being streamed to the client
        if (client && !client.started) {
            if (this.emit(chatId, { kind: 'event', payload: { event: 'start', data: data } })) {
                client.started = true
            }
        }
    }

    streamTokenEvent(chatId: string, data: string) {
        this.emit(chatId, { kind: 'event', payload: { event: 'token', data: data } })
    }

    streamThinkingEvent(chatId: string, data: string, duration?: number) {
        this.emit(chatId, { kind: 'event', payload: { event: 'thinking', data: data, duration: duration } })
    }

    streamSourceDocumentsEvent(chatId: string, data: any) {
        this.emit(chatId, { kind: 'event', payload: { event: 'sourceDocuments', data: data } })
    }
    streamArtifactsEvent(chatId: string, data: any) {
        this.emit(chatId, { kind: 'event', payload: { event: 'artifacts', data: data } })
    }
    streamUsedToolsEvent(chatId: string, data: any): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'usedTools', data: data } })
    }
    streamCalledToolsEvent(chatId: string, data: any): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'calledTools', data: data } })
    }
    streamFileAnnotationsEvent(chatId: string, data: any): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'fileAnnotations', data: data } })
    }
    streamToolEvent(chatId: string, data: any): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'tool', data: data } })
    }
    streamAgentReasoningEvent(chatId: string, data: any): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'agentReasoning', data: data } })
    }
    streamNextAgentEvent(chatId: string, data: any): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'nextAgent', data: data } })
    }
    streamAgentFlowEvent(chatId: string, data: any): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'agentFlowEvent', data: data } })
    }
    streamAgentFlowExecutedDataEvent(chatId: string, data: any): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'agentFlowExecutedData', data: data } })
    }
    streamNextAgentFlowEvent(chatId: string, data: any): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'nextAgentFlow', data: data } })
    }
    streamActionEvent(chatId: string, data: any): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'action', data: data } })
    }

    streamAbortEvent(chatId: string): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'abort', data: '[DONE]' } })
    }

    streamEndEvent(_: string) {
        // placeholder for future use
    }

    // `details` carries the status and code the request would have had without streaming (the HTTP status is already 200).
    streamErrorEvent(chatId: string, msg: string, details?: { status: number; code: string; retryAfter?: number }) {
        if (msg.includes('401 Incorrect API key provided'))
            msg = '401 Unauthorized – check your API key and ensure it has access to the requested model.'
        const payload: Record<string, unknown> = {
            event: 'error',
            data: msg,
            ...(details ? { status: details.status, code: details.code } : {}),
            ...(details?.retryAfter ? { retryAfter: details.retryAfter } : {})
        }
        this.emit(chatId, { kind: 'event', payload })
    }

    // `options.sessionToken` adds the caller's session token. Only the public prediction route sets it: a browser
    // embed on another site can't use the session cookie, so it needs the token to keep the conversation going.
    streamMetadataEvent(chatId: string, apiResponse: any, options: { sessionToken?: boolean } = {}) {
        const metadataJson: any = {}
        if (apiResponse.chatId) {
            metadataJson['chatId'] = apiResponse.chatId
        }
        if (options.sessionToken && typeof apiResponse.sessionToken === 'string' && apiResponse.sessionToken) {
            metadataJson['sessionToken'] = apiResponse.sessionToken
        }
        if (apiResponse.chatMessageId) {
            metadataJson['chatMessageId'] = apiResponse.chatMessageId
        }
        if (apiResponse.question) {
            metadataJson['question'] = apiResponse.question
        }
        if (apiResponse.sessionId) {
            metadataJson['sessionId'] = apiResponse.sessionId
        }
        if (apiResponse.memoryType) {
            metadataJson['memoryType'] = apiResponse.memoryType
        }
        if (apiResponse.followUpPrompts) {
            metadataJson['followUpPrompts'] =
                typeof apiResponse.followUpPrompts === 'string' ? JSON.parse(apiResponse.followUpPrompts) : apiResponse.followUpPrompts
        }
        if (apiResponse.flowVariables) {
            metadataJson['flowVariables'] =
                typeof apiResponse.flowVariables === 'string' ? JSON.parse(apiResponse.flowVariables) : apiResponse.flowVariables
        }
        if (apiResponse.action) {
            metadataJson['action'] = typeof apiResponse.action === 'string' ? JSON.parse(apiResponse.action) : apiResponse.action
        }
        if (Object.keys(metadataJson).length > 0) {
            this.streamCustomEvent(chatId, 'metadata', metadataJson)
        }
    }

    streamUsageMetadataEvent(chatId: string, data: any): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'usageMetadata', data: data } })
    }

    streamTTSStartEvent(chatId: string, chatMessageId: string, format: string): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'tts_start', data: { chatMessageId, format } } })
    }

    streamTTSDataEvent(chatId: string, chatMessageId: string, audioChunk: string): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'tts_data', data: { chatMessageId, audioChunk } } })
    }

    streamTTSEndEvent(chatId: string, chatMessageId: string): void {
        this.emit(chatId, { kind: 'event', payload: { event: 'tts_end', data: { chatMessageId } } })
    }

    streamTTSAbortEvent(chatId: string, chatMessageId: string): void {
        const client = this.clients.get(chatId)
        if (client) {
            try {
                const payload = {
                    event: 'tts_abort',
                    data: { chatMessageId }
                }
                const encoded = (client.encoder ?? defaultSSEEncoder)({ kind: 'final', payload })
                if (encoded !== null) client.response.write(encoded)
                client.response.end()
            } catch {
                // Client already disconnected, ignore write errors
            } finally {
                this.clients.delete(chatId)
            }
        }
    }

    startHeartbeat(intervalMs: number = 30_000) {
        this.heartbeatInterval = setInterval(() => {
            for (const chatId of this.clients.keys()) {
                // SSE comment line — ignored by clients but keeps the connection alive through ALB/proxies
                this.emit(chatId, { kind: 'comment', text: 'heartbeat' })
            }
        }, intervalMs)
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval)
            this.heartbeatInterval = null
        }
    }
}
