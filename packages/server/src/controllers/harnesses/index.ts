import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { getErrorMessage } from '../../errors/utils'
import { requireWorkspaceIdFromReq } from '../../identity/workspaceScope'
import harnessesService from '../../services/harnesses'
import {
    callerApiKeyId,
    callerKeyHarnesses,
    harnessCallerFor,
    isApiKeyCaller,
    noteBackgroundRunSettled,
    noteBackgroundRunStarted,
    noteHarnessAudit,
    safeHarnessName,
    scheduleOwner
} from '../../services/harnesses/apiAccess'
import type { IHarnessCaller } from '../../Interface'
import { trackBackgroundRun } from '../../settings/runs'
import { chatImages } from '../../services/harnesses/chatImages'
import { watchClientDisconnect } from '../../utils/clientAbort'
import { isStreamingRequest } from '../../utils/streaming'

// The caller's active team. An API key's user carries that key's workspace. A missing id is 400, not every harness.
function activeWorkspace(req: Request): string {
    return requireWorkspaceIdFromReq(req)
}

const listHarnesses = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const rows = await harnessesService.listHarnesses(activeWorkspace(req))
        const allowed = await callerKeyHarnesses(req)
        return res.json(allowed === null ? rows : rows.filter((row: { name: string }) => allowed.includes(row.name)))
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
        return res.json(await harnessesService.listRuns(req.params.name, activeWorkspace(req), { apiKeyId: callerApiKeyId(req) }))
    } catch (error) {
        next(error)
    }
}

const getRun = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(
            await harnessesService.getRun(req.params.name, req.params.runId, activeWorkspace(req), { apiKeyId: callerApiKeyId(req) })
        )
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
    let caller: IHarnessCaller
    try {
        workspaceId = activeWorkspace(req)
        caller = await harnessCallerFor(req)
        await harnessesService.assertRunRequest(req.params.name, req.body || {}, workspaceId, caller)
    } catch (error) {
        next(error)
        return
    }
    if (!isStreamingRequest(req)) {
        try {
            const outcome = await harnessesService.startRun(req.params.name, req.body || {}, { source, workspaceId, caller })
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
            caller,
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
            caller: await harnessCallerFor(req),
            track: trackBackgroundRun,
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
        return res.json(
            await harnessesService.getRunResult(req.params.name, req.params.runId, activeWorkspace(req), { apiKeyId: callerApiKeyId(req) })
        )
    } catch (error) {
        next(error)
    }
}

const getSchedule = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(
            await harnessesService.getHarnessSchedule(req.params.name, activeWorkspace(req), { apiKeyCaller: isApiKeyCaller(req) })
        )
    } catch (error) {
        next(error)
    }
}

type ScheduleView = { schedule: Record<string, unknown> | null }

async function noteScheduleChange(req: Request, action: string, summary: string, view: ScheduleView | { deleted: boolean }) {
    const schedule = 'schedule' in view ? view.schedule : null
    await noteHarnessAudit(req, 'harness_schedule', summary, {
        harness: safeHarnessName(req.params.name),
        action,
        ...(schedule ? { cron: schedule.cron, timezone: schedule.timezone, status: schedule.status } : {})
    })
}

const saveSchedule = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const ownerId = scheduleOwner(req)
        const saved = await harnessesService.saveHarnessSchedule(req.params.name, req.body || {}, {
            workspaceId: activeWorkspace(req),
            ownerId
        })
        await noteScheduleChange(req, 'saved', 'Harness schedule saved', saved)
        return res.json(saved)
    } catch (error) {
        next(error)
    }
}

const pauseSchedule = async (req: Request, res: Response, next: NextFunction) => {
    try {
        scheduleOwner(req)
        const saved = await harnessesService.setHarnessScheduleStatus(req.params.name, 'paused', activeWorkspace(req))
        await noteScheduleChange(req, 'paused', 'Harness schedule paused', saved)
        return res.json(saved)
    } catch (error) {
        next(error)
    }
}

const resumeSchedule = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const ownerId = scheduleOwner(req)
        const saved = await harnessesService.setHarnessScheduleStatus(req.params.name, 'active', activeWorkspace(req), { ownerId })
        await noteScheduleChange(req, 'resumed', 'Harness schedule resumed', saved)
        return res.json(saved)
    } catch (error) {
        next(error)
    }
}

const deleteSchedule = async (req: Request, res: Response, next: NextFunction) => {
    try {
        scheduleOwner(req)
        const removed = await harnessesService.deleteHarnessSchedule(req.params.name, activeWorkspace(req))
        await noteScheduleChange(req, 'deleted', 'Harness schedule deleted', removed)
        return res.json(removed)
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
    getRunResult,
    getSchedule,
    saveSchedule,
    pauseSchedule,
    resumeSchedule,
    deleteSchedule
}
