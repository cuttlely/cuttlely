import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { getErrorMessage } from '../../errors/utils'
import harnessesService from '../../services/harnesses'
import { chatImages } from '../../services/harnesses/chatImages'
import { watchClientDisconnect } from '../../utils/clientAbort'
import { isStreamingRequest } from '../../utils/streaming'

const listHarnesses = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await harnessesService.listHarnesses())
    } catch (error) {
        next(error)
    }
}

const getHarness = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await harnessesService.getHarness(req.params.name))
    } catch (error) {
        next(error)
    }
}

const saveHarness = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await harnessesService.saveHarness(req.body))
    } catch (error) {
        next(error)
    }
}

const deleteHarness = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await harnessesService.deleteHarness(req.params.name))
    } catch (error) {
        next(error)
    }
}

const listRuns = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await harnessesService.listRuns(req.params.name))
    } catch (error) {
        next(error)
    }
}

const getRun = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await harnessesService.getRun(req.params.name, req.params.runId))
    } catch (error) {
        next(error)
    }
}

function writeSse(res: Response, event: string, data: unknown) {
    if (res.writableEnded) return
    res.write(`message:\ndata:${JSON.stringify({ event, data })}\n\n`)
}

const createRun = async (req: Request, res: Response, next: NextFunction) => {
    const source = req.get('x-request-from') === 'internal' ? 'playground' : 'api'
    try {
        await harnessesService.assertRunRequest(req.params.name, req.body || {})
    } catch (error) {
        next(error)
        return
    }
    if (!isStreamingRequest(req)) {
        try {
            const outcome = await harnessesService.startRun(req.params.name, req.body || {}, { source })
            return res.json({ chatId: outcome.chatId, run: outcome.run, ...outcome.payload })
        } catch (error) {
            next(error)
        }
        return
    }
    const signal = watchClientDisconnect(res)
    res.status(StatusCodes.OK)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    try {
        const outcome = await harnessesService.startRun(req.params.name, req.body || {}, {
            source,
            signal,
            onEvent: (event) => writeSse(res, `harness.${event.type}`, event)
        })
        // Images a specialist made: the events named them, the chat shows them.
        const images = chatImages((outcome.payload as { artifacts?: unknown } | undefined)?.artifacts)
        if (images.length) writeSse(res, 'artifacts', images)
        writeSse(res, 'harness.recorded', { run: outcome.run, chatId: outcome.chatId })
        res.end()
    } catch (error) {
        const recorded = (error as { harnessRun?: unknown }).harnessRun || null
        writeSse(res, 'error', { message: getErrorMessage(error), run: recorded })
        res.end()
    }
}

export default {
    listHarnesses,
    getHarness,
    saveHarness,
    deleteHarness,
    listRuns,
    getRun,
    createRun
}
