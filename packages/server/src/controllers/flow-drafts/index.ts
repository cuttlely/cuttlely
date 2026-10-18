import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { ChatFlow } from '../../database/entities/ChatFlow'
import chatflowsService from '../../services/chatflows'
import flowDraftsService, { redactDraftStatus } from '../../services/flow-drafts'
import flowCheckService from '../../services/flow-check'
import { listQuestionHistory } from '../../services/flow-check/history'
import { BadQuestionIdsError, CheckRuleError, questionIdFailureMessage } from '../../services/flow-check/question-ids-error'
import flowVersionsService from '../../services/flow-versions'
import { actorFromUser } from '../../services/flow-versions/author'
import { hasAnyPermission } from '../../identity/rbac'
import { harnessCallerFor } from '../../services/harnesses/apiAccess'
import { putVersionLive } from '../flow-versions'
import { PUBLISH_CHECK_OFF_MESSAGE, publishCheckEnabled } from '../../settings/runtime'

const SHA = /^[0-9a-f]{7,40}$/

// The route lets in chatflow or agentflow users, so the flow's own type is checked here.
function permissionFor(type: string | null | undefined, action: 'view' | 'update'): string {
    if (type === 'AGENTFLOW' || type === 'MULTIAGENT') return `agentflows:${action}`
    if (type === 'ASSISTANT') return `assistants:${action}`
    return `chatflows:${action}`
}

// The flow must be in the caller's active workspace, and the caller needs the permission for its type.
async function flowFor(req: Request, action: 'view' | 'update') {
    const workspaceId = req.user?.activeWorkspaceId
    if (!workspaceId) throw new AppError(StatusCodes.NOT_FOUND, 'Workspace not found.')
    const flow = await chatflowsService.getChatflowByIdForWorkspace(req.params.chatflowId, workspaceId)
    if (!(await hasAnyPermission(req, permissionFor(flow.type, action)))) {
        throw new AppError(StatusCodes.FORBIDDEN, `You do not have permission to ${action} this type of flow.`)
    }
    return flow
}

async function shownStatus<T>(req: Request, status: T): Promise<T> {
    return redactDraftStatus(status, {
        datasets: await hasAnyPermission(req, 'datasets:view'),
        evaluators: await hasAnyPermission(req, 'evaluators:view')
    })
}

const getDraft = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'view')
        return res.json(await shownStatus(req, await flowDraftsService.getDraftStatus(flow)))
    } catch (error) {
        next(error)
    }
}

const saveDraft = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'update')
        const orgId = req.user?.activeOrganizationId
        if (!orgId) throw new AppError(StatusCodes.NOT_FOUND, 'Organization not found.')
        const status = await flowDraftsService.saveDraft(flow, req.body?.flowData, {
            userId: req.user?.id || null,
            orgId,
            subscriptionId: req.user?.activeOrganizationSubscriptionId || '',
            caller: await harnessCallerFor(req)
        })
        return res.json(await shownStatus(req, status))
    } catch (error) {
        next(error)
    }
}

const discardDraft = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'update')
        return res.json(await shownStatus(req, await flowDraftsService.discardDraft(flow)))
    } catch (error) {
        next(error)
    }
}

const updateSettings = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'update')
        const body = req.body || {}
        // Turning the gate on selects a dataset and evaluators, so those view permissions are required too.
        if (body.publishGate?.enabled === true) {
            if (!(await hasAnyPermission(req, 'datasets:view'))) {
                throw new AppError(StatusCodes.FORBIDDEN, 'You do not have permission to view datasets.')
            }
            if (!(await hasAnyPermission(req, 'evaluators:view'))) {
                throw new AppError(StatusCodes.FORBIDDEN, 'You do not have permission to view evaluators.')
            }
        }
        if (body.publishGate !== undefined || (body.publishInstantly !== undefined && body.publishGate !== undefined)) {
            return res.json(await shownStatus(req, await flowDraftsService.updateDraftSettings(flow, body)))
        }
        return res.json(await shownStatus(req, await flowDraftsService.setPublishInstantly(flow, body.publishInstantly)))
    } catch (error) {
        next(error)
    }
}

function summary(flow: any) {
    return { id: flow.id, name: flow.name, type: flow.type, updatedDate: flow.updatedDate, flowData: flow.flowData }
}

// Publish: the draft becomes Live through the normal update path (validation, harness sync, file handling),
// and history gains a "Published" version. A draft whose Live changed underneath needs
// { overwriteLiveChanges: true }.
const publishDraft = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'update')
        const workspaceId = req.user?.activeWorkspaceId
        const orgId = req.user?.activeOrganizationId
        if (!workspaceId || !orgId) throw new AppError(StatusCodes.NOT_FOUND, 'Workspace not found.')
        const draft = await flowDraftsService.draftToPublish(flow, req.body?.overwriteLiveChanges)
        // The Live canvas the stale check above was made against. The save only goes through while Live is
        // still this canvas, so an update that lands meanwhile is never overwritten silently.
        const liveBefore = flow.flowData
        // Live already matches (for example, the same change came in through the API). The same conditional save
        // confirms that atomically before the draft is dropped; history records nothing for an unchanged canvas.
        const unchanged = flowDraftsService.sameCanvas(draft, liveBefore)
        const update = new ChatFlow()
        update.id = flow.id
        update.flowData = draft
        let recorded: Promise<string | null> = Promise.resolve(null)
        const chatflow = await chatflowsService.updateChatflow(
            flow,
            update,
            orgId,
            workspaceId,
            req.user?.activeOrganizationSubscriptionId || '',
            {
                versionRecord: { kind: 'publish', titlePrefix: 'Published: ' },
                expectedFlowData: liveBefore,
                actor: actorFromUser(req.user),
                caller: await harnessCallerFor(req),
                onVersionQueued: (result) => {
                    recorded = result
                }
            }
        )
        const sha = await recorded
        if (unchanged) {
            // Only the draft that was checked is cleared; a newer one saved meanwhile is kept.
            const status = await shownStatus(req, await flowDraftsService.clearDraftIfStill(chatflow, draft))
            return res.json({ chatflow: summary(chatflow), version: null, unchanged: true, recorded: false, historyError: null, status })
        }
        const status = await shownStatus(req, await flowDraftsService.afterLiveSet(chatflow, sha, draft))
        const version = sha ? (await flowVersionsService.listVersions(flow.id)).versions.find((item) => item.sha === sha) || null : null
        return res.json({
            chatflow: summary(chatflow),
            version,
            unchanged: false,
            recorded: Boolean(sha),
            historyError: sha ? null : flowVersionsService.lastErrorFor(flow.id),
            status
        })
    } catch (error) {
        next(error)
    }
}

// Roll back Live to this version: Live is set to the version at once and history gains a "Rolled back"
// version. An open draft is kept.
const rollbackLive = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'update')
        if (!flowDraftsService.isDraftsEnabled()) {
            throw new AppError(StatusCodes.CONFLICT, 'Drafts are off on this server. Use Restore instead.')
        }
        const sha = typeof req.body?.sha === 'string' ? req.body.sha : ''
        if (!SHA.test(sha)) throw new AppError(StatusCodes.BAD_REQUEST, 'sha is a version id: 7 to 40 lowercase hex characters.')
        // A version of another flow type is refused while the flow has unpublished changes (updateChatflow).
        const result = await putVersionLive(req, flow, sha, { kind: 'rollback', verb: 'Rolled back Live to' })
        const status = await shownStatus(
            req,
            result.chatflow
                ? await flowDraftsService.afterLiveSet(result.chatflow, result.sha)
                : await flowDraftsService.getDraftStatus(flow)
        )
        // The page keeps this object as the flow. flowData is the canvas that is Live now:
        // the version that was written, or the canvas already stored when nothing changed.
        const liveCanvas = result.chatflow?.flowData || flow.flowData
        const named = result.body?.chatflow
        const chatflow = named && typeof liveCanvas === 'string' ? { ...named, flowData: liveCanvas } : named
        return res.json({ ...result.body, ...(chatflow ? { chatflow } : {}), status })
    } catch (error) {
        next(error)
    }
}

// Starting a check already requires these. Reading one must too, or a flow viewer sees dataset rows and evaluator names.
async function checkReveal(req: Request) {
    return {
        datasets: await hasAnyPermission(req, 'datasets:view'),
        evaluators: await hasAnyPermission(req, 'evaluators:view')
    }
}

function historyCaller(req: Request): string {
    const id = req.user?.id
    if (typeof id === 'string' && id) return `user:${id}`
    const keyId = req.user?.apiKeyId
    if (typeof keyId === 'string' && keyId) return `key:${keyId}`
    return 'api'
}

function assertPublishCheckOn(): void {
    if (!publishCheckEnabled()) throw new AppError(StatusCodes.CONFLICT, PUBLISH_CHECK_OFF_MESSAGE)
}

// Past questions a caller can hand to the check. Reading them needs the same view permission as this flow's messages.
// The body is stored question text, so a 200 is not stored by the browser either.
const getCheckHistory = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'view')
        const history = await listQuestionHistory(flow, req.query, historyCaller(req))
        res.setHeader('Cache-Control', 'no-store')
        return res.status(StatusCodes.OK).json(history)
    } catch (error) {
        res.setHeader('Cache-Control', 'no-store')
        if (error instanceof CheckRuleError) {
            return res.status(error.statusCode).json({ code: error.code, message: error.message })
        }
        next(error)
    }
}

// The publish check: recent questions replayed against Live and the draft. Optional; Publish never waits for it.
const getCheckSetup = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'view')
        return res.json(await flowCheckService.getCheckSetup(flow, undefined, await checkReveal(req)))
    } catch (error) {
        next(error)
    }
}

// Do not use req.destroyed. express.json() ends the request stream after it reads the body,
// and that sets destroyed while the socket is still open and the client is still waiting.
const clientGone = (req: Request) => {
    const incoming = req as Request & { aborted?: boolean }
    return Boolean(incoming.aborted || req.socket?.destroyed)
}

// A reset while the 202 is being written does not set req.aborted. It arrives on the next
// turn as a socket error, after writableFinished is already true. A clean close is different:
// a client that read the 202 and sent Connection: close drops the socket without an error.
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED'])

type Listenable = {
    on?: (event: string, handler: (...args: any[]) => void) => void
    off?: (event: string, handler: (...args: any[]) => void) => void
    removeListener?: (event: string, handler: (...args: any[]) => void) => void
} | null

const listen = (emitter: Listenable, event: string, handler: (...args: any[]) => void) => {
    if (emitter && typeof emitter.on === 'function') emitter.on(event, handler)
}

const unlisten = (emitter: Listenable, event: string, handler: (...args: any[]) => void) => {
    if (!emitter) return
    if (typeof emitter.off === 'function') emitter.off(event, handler)
    else if (typeof emitter.removeListener === 'function') emitter.removeListener(event, handler)
}

const startCheck = async (req: Request, res: Response, next: NextFunction) => {
    // ownedId is set only after this request has stored its own record. A close before that
    // must not stop a check this request did not create.
    let ownedId: string | null = null
    let gone = false
    let stopped = false
    let detach: () => void = () => undefined
    try {
        assertPublishCheckOn()
        const flow = await flowFor(req, 'update')
        const body = req.body || {}
        // Picking stored questions reads this flow's messages. A key that can run a check but cannot view messages is refused.
        if (
            body.questionIds !== undefined &&
            body.questionIds !== null &&
            !(await hasAnyPermission(req, permissionFor(flow.type, 'view')))
        ) {
            throw new AppError(StatusCodes.FORBIDDEN, "You do not have permission to read this flow's messages.")
        }
        // On top of the flow permission: a dataset needs datasets:view, and evaluators need evaluators:view.
        if (body.datasetId !== undefined && body.datasetId !== null && !(await hasAnyPermission(req, 'datasets:view'))) {
            throw new AppError(StatusCodes.FORBIDDEN, 'You do not have permission to view datasets.')
        }
        if (Array.isArray(body.evaluatorIds) && body.evaluatorIds.length > 0 && !(await hasAnyPermission(req, 'evaluators:view'))) {
            throw new AppError(StatusCodes.FORBIDDEN, 'You do not have permission to view evaluators.')
        }
        const socket = req.socket
        const stopOwned = (force = false) => {
            if (stopped || !ownedId) return
            if (!force && res.writableFinished) return
            const id = ownedId
            ownedId = null
            stopped = true
            detach()
            void flowCheckService.stopCheck(flow, id).catch(() => undefined)
        }
        const mark = () => {
            // A clean close after the 202 was written is the client hanging up, not a cancel.
            if (res.writableFinished) return
            gone = true
            stopOwned()
        }
        const onSocketError = (error: { code?: string }) => {
            if (!error?.code || !RESET_CODES.has(error.code)) return
            gone = true
            stopOwned(true)
        }
        const onDelivered = () => {
            // The reset error is delivered before the next immediate. Once that turn passes with
            // no error, the 202 was handed off and this listener must not stay on a reused socket.
            setImmediate(() => {
                if (!gone) detach()
            })
        }
        detach = () => {
            unlisten(req, 'aborted', mark)
            unlisten(socket, 'close', mark)
            unlisten(socket, 'error', onSocketError)
            unlisten(res, 'close', mark)
            unlisten(res, 'finish', onDelivered)
        }
        listen(req, 'aborted', mark)
        listen(socket, 'close', mark)
        listen(socket, 'error', onSocketError)
        listen(res, 'close', mark)
        listen(res, 'finish', onDelivered)
        const baseURL = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`
        const closed = () => gone || clientGone(req)
        // A Harness card, or this harness itself, replays for the caller: an API key runs only what is on its list.
        const view = await flowCheckService.startCheck(flow, body, baseURL, undefined, { closed }, await harnessCallerFor(req))
        ownedId = view.id
        if (closed()) {
            const id = ownedId
            ownedId = null
            stopped = true
            detach()
            await flowCheckService.stopCheck(flow, id).catch(() => undefined)
            return
        }
        return res.status(StatusCodes.ACCEPTED).json(view)
    } catch (error) {
        detach()
        if (error instanceof BadQuestionIdsError) {
            res.setHeader('Cache-Control', 'no-store')
            return res.status(StatusCodes.BAD_REQUEST).json({
                code: error.code,
                message: questionIdFailureMessage(error.errors, error.badCount),
                badCount: error.badCount,
                errors: error.errors
            })
        }
        if (error instanceof CheckRuleError) {
            res.setHeader('Cache-Control', 'no-store')
            return res.status(error.statusCode).json({ code: error.code, message: error.message })
        }
        next(error)
    }
}

const getCheck = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'view')
        return res.json(await flowCheckService.getCheck(flow, req.params.checkId, undefined, await checkReveal(req)))
    } catch (error) {
        next(error)
    }
}

const stopCheck = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'update')
        return res.json(await flowCheckService.stopCheck(flow, req.params.checkId, undefined, await checkReveal(req)))
    } catch (error) {
        next(error)
    }
}

export default {
    getCheckSetup,
    getCheckHistory,
    startCheck,
    getCheck,
    stopCheck,
    publishDraft,
    rollbackLive,
    getDraft,
    saveDraft,
    discardDraft,
    updateSettings
}
