import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { getErrorMessage } from '../../errors/utils'
import { requireWorkspaceIdFromReq } from '../../identity/workspaceScope'
import harnessesService from '../../services/harnesses'
import { noteBackgroundRunSettled, noteBackgroundRunStarted } from '../../services/harnesses/apiAccess'
import { chatImages } from '../../services/harnesses/chatImages'
import { watchClientDisconnect } from '../../utils/clientAbort'
import { isStreamingRequest } from '../../utils/streaming'

// The caller's active team. An API key's user carries that key's workspace. A missing id is 400, not every harness.
function activeWorkspace(req: Request): string {
    return requireWorkspaceIdFromReq(req)
}

const listHarnesses = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await harnessesService.listHarnesses(activeWorkspace(req)))
    } catch (error) {
        next(error)
    }
}

const getHarness = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await harnessesService.getHarness(req.params.name, activeWorkspace(req)))
    } catch (error) {
        next(error)
    }
}

const saveHarness = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await harnessesService.saveHarness(req.body, activeWorkspace(req)))
    } catch (error) {
        next(error)
    }
}

const deleteHarness = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await harnessesService.deleteHarness(req.params.name, activeWorkspace(req)))
    } catch (error) {
        next(error)
    }
}

const listRuns = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await harnessesService.listRuns(req.params.name, activeWorkspace(req)))
    } catch (error) {
        next(error)
    }
}

const getRun = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await harnessesService.getRun(req.params.name, req.params.runId, activeWorkspace(req)))
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
    let workspaceId = ''
    try {
        workspaceId = activeWorkspace(req)
        await harnessesService.assertRunRequest(req.params.name, req.body || {}, workspaceId)
    } catch (error) {
        next(error)
        return
    }
    if (!isStreamingRequest(req)) {
        try {
            const outcome = await harnessesService.startRun(req.params.name, req.body || {}, { source, workspaceId })
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
            workspaceId,
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

// Answers 202 with the run id. The run itself keeps going after the response.
const startBackgroundRun = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const workspaceId = activeWorkspace(req)
        const started = await harnessesService.startBackgroundRun(req.params.name, req.body || {}, {
            workspaceId,
            source: 'api',
            onSettled: (outcome) => noteBackgroundRunSettled(req.params.name, outcome)
        })
        await noteBackgroundRunStarted(req, started, workspaceId)
        const base = `/api/v1/harnesses/${encodeURIComponent(started.harness)}/runs/${started.runId}`
        return res.status(StatusCodes.ACCEPTED).json({ ...started, statusUrl: base, resultUrl: `${base}/result` })
    } catch (error) {
        next(error)
    }
}

const getRunResult = async (req: Request, res: Response, next: NextFunction) => {
    try {
        res.setHeader('Cache-Control', 'no-store')
        return res.json(await harnessesService.getRunResult(req.params.name, req.params.runId, activeWorkspace(req)))
    } catch (error) {
        next(error)
    }
}

export default {
    listHarnesses,
    getHarness,
    saveHarness,
    deleteHarness,
    listRuns,
    getRun,
    createRun,
    startBackgroundRun,
    getRunResult
}
