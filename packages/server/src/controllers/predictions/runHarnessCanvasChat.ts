import { Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { removeSpecificFileFromUpload } from '@cuttlely/components'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'
import type { IHarnessCaller } from '../../Interface'
import harnessesService from '../../services/harnesses'
import { watchClientDisconnect } from '../../utils/clientAbort'
import { isStreamingRequest } from '../../utils/streaming'

const hasBodyUploads = (uploads: unknown) =>
    uploads !== undefined && uploads !== null && uploads !== '' && !(Array.isArray(uploads) && uploads.length === 0)

function assertVerifiedDeliveryDeadline(payload: unknown) {
    const result = payload as { trustedOutput?: boolean; trustedOutputDeadlineAt?: number; trace?: { handoff?: { reason?: string } } }
    if (
        (result?.trustedOutput || result?.trace?.handoff?.reason === 'trustedOutput') &&
        typeof result.trustedOutputDeadlineAt === 'number' &&
        Date.now() >= result.trustedOutputDeadlineAt
    )
        throw new AppError(StatusCodes.BAD_REQUEST, 'The turn budget expired before verified output could be delivered.')
}

// A harness canvas run takes the question as text and does not read attachments. A request with files or uploads is
// refused with 400 before the run, and the multipart files multer already stored are removed.
async function refuseUploads(req: Request) {
    const files = Array.isArray(req.files) ? (req.files as Array<{ path?: string; key?: string }>) : []
    if (!files.length && !hasBodyUploads((req.body as { uploads?: unknown } | undefined)?.uploads)) return
    for (const file of files) {
        const tempPath = file.path ?? file.key
        if (!tempPath) continue
        try {
            await removeSpecificFileFromUpload(tempPath)
        } catch {
            // Already gone.
        }
    }
    throw new AppError(StatusCodes.BAD_REQUEST, 'A harness canvas does not take file uploads. Send the question as text.')
}

// A harness canvas is not a chatflow. Building it looks for node.init and throws.
// The in-app chat and the public prediction route both hand the run here.
export async function runHarnessCanvasChat(
    req: Request,
    res: Response,
    chatflow: { id: string; name: string; flowData: string; workspaceId: string },
    caller: IHarnessCaller,
    options: { canvas: 'live' | 'draft'; sessionToken?: string }
) {
    await refuseUploads(req)
    const streaming = isStreamingRequest(req)
    const source = 'playground'
    const run = (extra: { signal?: AbortSignal; onEvent?: (event: { type: string }) => void } = {}) =>
        harnessesService.startCanvasRun(chatflow, req.body || {}, { source, caller, canvas: options.canvas, ...extra })
    if (!streaming) {
        const outcome = await run()
        assertVerifiedDeliveryDeadline(outcome.payload)
        return res.json({
            chatId: outcome.chatId,
            run: outcome.run,
            ...outcome.payload,
            ...(options.sessionToken ? { sessionToken: options.sessionToken } : {})
        })
    }
    const signal = watchClientDisconnect(res)
    res.status(StatusCodes.OK)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const write = (event: string, data: unknown) => {
        if (res.writableEnded) return
        res.write(`message:\ndata:${JSON.stringify({ event, data })}\n\n`)
    }
    const deferred: Array<{ type: string }> = []
    try {
        const outcome = await run({
            signal,
            onEvent: (event) => {
                const shaped = event as { type: string; phase?: string; trustedOutput?: boolean }
                if (shaped.trustedOutput && (shaped.type === 'final' || (shaped.type === 'partial' && shaped.phase === 'answer')))
                    deferred.push(event)
                else write(`harness.${event.type}`, event)
            }
        })
        const images = harnessesService.chatImages((outcome.payload as { artifacts?: unknown } | undefined)?.artifacts)
        if (signal.aborted) throw new AppError(StatusCodes.BAD_REQUEST, 'Run was cancelled.')
        assertVerifiedDeliveryDeadline(outcome.payload)
        const payload = (outcome.payload || {}) as {
            trustedOutput?: boolean
            artifacts?: unknown[]
            trace?: { handoff?: { reason?: string } }
        }
        if (
            (payload.trustedOutput || payload.trace?.handoff?.reason === 'trustedOutput') &&
            images.length !== (payload.artifacts?.length || 0)
        )
            throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, 'Verified attachments could not be delivered.')
        if (images.length) write('artifacts', images)
        for (const event of deferred) write(`harness.${event.type}`, event)
        write('harness.recorded', {
            run: outcome.run,
            chatId: outcome.chatId,
            ...(options.sessionToken ? { sessionToken: options.sessionToken } : {})
        })
        write('end', {})
        res.end()
    } catch (error) {
        const recorded = (error as { harnessRun?: unknown }).harnessRun || null
        write('error', { message: getErrorMessage(error), run: recorded })
        write('end', {})
        res.end()
    }
}
