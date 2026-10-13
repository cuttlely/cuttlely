import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { ChatFlow } from '../../database/entities/ChatFlow'
import chatflowsService from '../../services/chatflows'
import flowDraftsService from '../../services/flow-drafts'
import flowCheckService from '../../services/flow-check'
import flowVersionsService from '../../services/flow-versions'
import { actorFromUser } from '../../services/flow-versions/author'
import { hasAnyPermission } from '../../identity/rbac'
import { putVersionLive } from '../flow-versions'

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

const getDraft = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'view')
        return res.json(await flowDraftsService.getDraftStatus(flow))
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
            subscriptionId: req.user?.activeOrganizationSubscriptionId || ''
        })
        return res.json(status)
    } catch (error) {
        next(error)
    }
}

const discardDraft = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'update')
        return res.json(await flowDraftsService.discardDraft(flow))
    } catch (error) {
        next(error)
    }
}

const updateSettings = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'update')
        return res.json(await flowDraftsService.setPublishInstantly(flow, req.body?.publishInstantly))
    } catch (error) {
        next(error)
    }
}

function summary(flow: any) {
    return { id: flow.id, name: flow.name, type: flow.type, updatedDate: flow.updatedDate }
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
                onVersionQueued: (result) => {
                    recorded = result
                }
            }
        )
        const sha = await recorded
        if (unchanged) {
            // Only the draft that was checked is cleared; a newer one saved meanwhile is kept.
            const status = await flowDraftsService.clearDraftIfStill(chatflow, draft)
            return res.json({ chatflow: summary(chatflow), version: null, unchanged: true, recorded: false, historyError: null, status })
        }
        const status = await flowDraftsService.afterLiveSet(chatflow, sha, draft)
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
        const status = result.chatflow
            ? await flowDraftsService.afterLiveSet(result.chatflow, result.sha)
            : await flowDraftsService.getDraftStatus(flow)
        return res.json({ ...result.body, status })
    } catch (error) {
        next(error)
    }
}

// The publish check: recent questions replayed against Live and the draft. Optional; Publish never waits for it.
const getCheckSetup = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'view')
        return res.json(await flowCheckService.getCheckSetup(flow))
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

const startCheck = async (req: Request, res: Response, next: NextFunction) => {
    // ownedId is set only after this request has stored its own record. A close before that
    // must not stop a check this request did not create.
    let ownedId: string | null = null
    let gone = false
    try {
        const flow = await flowFor(req, 'update')
        const stopOwned = () => {
            if (res.writableFinished || !ownedId) return
            const id = ownedId
            ownedId = null
            void flowCheckService.stopCheck(flow, id).catch(() => undefined)
        }
        const mark = () => {
            if (res.writableFinished) return
            gone = true
            stopOwned()
        }
        if (typeof req.on === 'function') req.on('aborted', mark)
        if (req.socket && typeof req.socket.on === 'function') req.socket.on('close', mark)
        if (typeof res.on === 'function') res.on('close', mark)
        const baseURL = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`
        const closed = () => gone || clientGone(req)
        const view = await flowCheckService.startCheck(flow, req.body || {}, baseURL, undefined, { closed })
        ownedId = view.id
        if (closed()) {
            await flowCheckService.stopCheck(flow, view.id).catch(() => undefined)
            return
        }
        return res.status(StatusCodes.ACCEPTED).json(view)
    } catch (error) {
        next(error)
    }
}

const getCheck = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'view')
        return res.json(await flowCheckService.getCheck(flow, req.params.checkId))
    } catch (error) {
        next(error)
    }
}

const stopCheck = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req, 'update')
        return res.json(await flowCheckService.stopCheck(flow, req.params.checkId))
    } catch (error) {
        next(error)
    }
}

export default {
    getCheckSetup,
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
