import { Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { getErrorMessage } from '../../errors/utils'
import type { IHarnessCaller } from '../../Interface'
import harnessesService from '../../services/harnesses'
import { watchClientDisconnect } from '../../utils/clientAbort'
import { isStreamingRequest } from '../../utils/streaming'

// A harness canvas is not a chatflow. Building it looks for node.init and throws.
// The in-app chat and the public prediction route both hand the run here.
export async function runHarnessCanvasChat(
    req: Request,
    res: Response,
    chatflow: { id: string; name: string; flowData: string; workspaceId: string },
    caller: IHarnessCaller
) {
    const streaming = isStreamingRequest(req)
    const source = 'playground'
    const run = (extra: { signal?: AbortSignal; onEvent?: (event: { type: string }) => void } = {}) =>
        harnessesService.startCanvasRun(chatflow, req.body || {}, { source, caller, ...extra })
    if (!streaming) {
        const outcome = await run()
        return res.json({ chatId: outcome.chatId, run: outcome.run, ...outcome.payload })
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
    try {
        const outcome = await run({
            signal,
            onEvent: (event) => write(`harness.${event.type}`, event)
        })
        const images = harnessesService.chatImages((outcome.payload as { artifacts?: unknown } | undefined)?.artifacts)
        if (images.length) write('artifacts', images)
        write('harness.recorded', { run: outcome.run, chatId: outcome.chatId })
        write('end', {})
        res.end()
    } catch (error) {
        const recorded = (error as { harnessRun?: unknown }).harnessRun || null
        write('error', { message: getErrorMessage(error), run: recorded })
        write('end', {})
        res.end()
    }
}
