// Promote, on a server labeled Prod: the flows with a new version from Dev, one flow's version with what it
// changes and the credentials it needs, the behavior check against Live, and Promote. Owner only (routes).
import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { ChatFlow } from '../../database/entities/ChatFlow'
import chatflowsService from '../../services/chatflows'
import flowCheckService, { Candidate } from '../../services/flow-check'
import { typeUnavailable } from '../../services/flow-check/kinds'
import flowDraftsService from '../../services/flow-drafts'
import flowPromoteService from '../../services/flow-promote'
import flowVersionsService from '../../services/flow-versions'
import { actorFromUser } from '../../services/flow-versions/author'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { checkUsageLimit } from '../../utils/quotaUsage'
import { missingCredentialsMessage, putVersionLive } from '../flow-versions'

const verb = () => flowPromoteService.promoteVerb?.() || 'Promoted from Dev'
const sourceName = () => flowPromoteService.promoteSource?.() || 'Dev'
const missingVersion = () =>
    sourceName() === 'Dev'
        ? 'There is no new version from Dev for this flow.'
        : `There is no new version from ${sourceName()} for this flow.`
const missingCheck = () =>
    sourceName() === 'Dev' ? 'There is no new version from Dev to check.' : `There is no new version from ${sourceName()} to check.`

function workspaceOf(req: Request): string {
    const workspaceId = req.user?.activeWorkspaceId
    if (!workspaceId) throw new AppError(StatusCodes.NOT_FOUND, 'Workspace not found.')
    return workspaceId
}

const listIncoming = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await flowPromoteService.listIncoming(workspaceOf(req)))
    } catch (error) {
        next(error)
    }
}

const getIncoming = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await flowPromoteService.getIncoming(req.params.chatflowId, workspaceOf(req)))
    } catch (error) {
        next(error)
    }
}

// Puts the newest version from Dev Live here: through the normal update path for a flow this server has, or as a
// new flow with the same id. History records it as promoted from Dev, so Roll back works as for any Publish.
// A draft here is kept and stays marked as started from the old Live. Missing credentials block it.
const promote = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const workspaceId = workspaceOf(req)
        const orgId = req.user?.activeOrganizationId
        if (!orgId) throw new AppError(StatusCodes.NOT_FOUND, 'Organization not found.')
        const from = typeof req.body?.from === 'string' ? req.body.from : undefined
        const candidate = from
            ? await flowPromoteService.promotable(req.params.chatflowId, req.body?.sha, workspaceId, undefined, from)
            : await flowPromoteService.promotable(req.params.chatflowId, req.body?.sha, workspaceId)
        const { latest, row } = candidate
        const drafts = flowDraftsService.isDraftsEnabled()
        if (row) {
            const result = await putVersionLive(req, row, latest.sha, {
                kind: 'promote',
                verb: verb(),
                title: latest.title,
                promotedFrom: latest.sha
            })
            const status = !drafts
                ? null
                : result.chatflow
                ? await flowDraftsService.afterLiveSet(result.chatflow, result.sha, undefined, { keepDraftBase: true })
                : await flowDraftsService.getDraftStatus(row)
            return res.json({ ...result.body, created: false, hasDraft: Boolean(status?.draft), status })
        }

        // A flow this server does not have yet: created with Dev's id, so its next versions find it.
        const blank = { id: latest.flowId, name: latest.name, type: 'CHATFLOW', flowData: '{"nodes":[],"edges":[]}', workspaceId }
        const version = await flowVersionsService.getVersion(blank, latest.sha)
        if (!version) throw new AppError(StatusCodes.NOT_FOUND, missingVersion())
        if (version.missingCredentials.length) {
            throw new AppError(StatusCodes.CONFLICT, missingCredentialsMessage(version.missingCredentials))
        }
        const app = getRunningExpressApp()
        const type = (version.type || 'CHATFLOW') as NonNullable<ChatFlow['type']>
        const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''
        const count = await chatflowsService.getAllChatflowsCountByOrganization(type, orgId)
        await checkUsageLimit('flows', subscriptionId, app.usageCacheManager, count + 1)
        const created = new ChatFlow()
        created.id = latest.flowId
        created.name = version.name || latest.name
        created.flowData = version.flowData
        created.type = type
        if (version.category) created.category = version.category
        created.workspaceId = workspaceId
        let recorded: Promise<string | null> = Promise.resolve(null)
        const saved = await chatflowsService.saveChatflow(
            created,
            orgId,
            workspaceId,
            subscriptionId,
            app.usageCacheManager,
            actorFromUser(req.user),
            {
                versionRecord: {
                    kind: 'promote',
                    title: flowVersionsService.restoreTitle(latest.sha, latest.title, verb()),
                    promotedFrom: latest.sha
                },
                onVersionQueued: (result) => {
                    recorded = result
                }
            }
        )
        const newSha = await recorded
        const status = drafts ? await flowDraftsService.afterLiveSet(saved, newSha, undefined, { keepDraftBase: true }) : null
        const after = newSha ? (await flowVersionsService.listVersions(saved.id)).versions.find((item) => item.sha === newSha) : undefined
        return res.json({
            chatflow: { id: saved.id, name: saved.name, type: saved.type, updatedDate: saved.updatedDate },
            restoredFrom: latest.sha,
            restoredTo: 'live',
            version: after || null,
            unchanged: false,
            recorded: Boolean(newSha),
            historyError: newSha ? null : flowVersionsService.lastErrorFor(saved.id),
            missingCredentials: [],
            ambiguousCredentials: version.ambiguousCredentials || [],
            hiddenSecrets: version.hiddenSecrets || [],
            created: true,
            hasDraft: false,
            status
        })
    } catch (error) {
        next(error)
    }
}

// The behavior check compares Live here with the version from Dev, mapped to this server's credentials.
async function checkTarget(req: Request): Promise<{ flow: ChatFlow; candidate: Candidate }> {
    const workspaceId = workspaceOf(req)
    const flow = await chatflowsService.getChatflowByIdForWorkspace(req.params.chatflowId, workspaceId)
    const incoming = await flowPromoteService.incomingCanvas(flow, workspaceId)
    const candidate: Candidate = {
        key: `${flow.id}:promote`,
        canvas: incoming?.flowData ?? null,
        unavailable: !incoming
            ? { code: 'no-draft', message: missingCheck() }
            : typeUnavailable(incoming.type, flow.type) ??
              (!incoming.flowData
                  ? { code: 'credentials', message: 'Add the missing credentials first. The check runs the new version with them.' }
                  : null)
    }
    return { flow, candidate }
}

const getCheckSetup = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { flow, candidate } = await checkTarget(req)
        return res.json(await flowCheckService.getCheckSetup(flow, candidate))
    } catch (error) {
        next(error)
    }
}

const startCheck = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { flow, candidate } = await checkTarget(req)
        const baseURL = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`
        return res.status(StatusCodes.ACCEPTED).json(await flowCheckService.startCheck(flow, req.body || {}, baseURL, candidate))
    } catch (error) {
        next(error)
    }
}

const getCheck = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { flow, candidate } = await checkTarget(req)
        return res.json(await flowCheckService.getCheck(flow, req.params.checkId, candidate))
    } catch (error) {
        next(error)
    }
}

const stopCheck = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { flow, candidate } = await checkTarget(req)
        return res.json(await flowCheckService.stopCheck(flow, req.params.checkId, candidate))
    } catch (error) {
        next(error)
    }
}

export default { listIncoming, getIncoming, promote, getCheckSetup, startCheck, getCheck, stopCheck }
