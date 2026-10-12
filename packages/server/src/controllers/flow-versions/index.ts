import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { ChatFlow } from '../../database/entities/ChatFlow'
import chatflowsService from '../../services/chatflows'
import { actorFromUser } from '../../services/flow-versions/author'
import flowVersionsService from '../../services/flow-versions'
import flowDraftsService from '../../services/flow-drafts'
import { GithubError } from '../../services/flow-versions/github'
import { hasAnyPermission } from '../../identity/rbac'
import { missingCredentialsMessage } from './message'

export { missingCredentialsMessage }

const SHA = /^[0-9a-f]{7,40}$/

// The flow must be in the caller's active workspace. History for any other flow is a 404.
async function flowFor(req: Request) {
    const workspaceId = req.user?.activeWorkspaceId
    if (!workspaceId) throw new AppError(StatusCodes.NOT_FOUND, 'Workspace not found.')
    return chatflowsService.getChatflowByIdForWorkspace(req.params.chatflowId, workspaceId)
}

function shaParam(req: Request): string {
    const sha = String(req.params.sha || '')
    if (!SHA.test(sha)) throw new AppError(StatusCodes.BAD_REQUEST, 'A version id is 7 to 40 lowercase hex characters.')
    return sha
}

const getStatus = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json({ enabled: flowVersionsService.isVersioningEnabled() })
    } catch (error) {
        next(error)
    }
}

const listVersions = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req)
        const list = await flowVersionsService.listVersions(flow.id)
        // The version that is Live now, and the last Publish or Roll back. Versions put Live by Publish or
        // Roll back carry published: true.
        const liveSha = list.enabled ? await flowVersionsService.liveVersionSha(flow, list.versions) : null
        const { lastPublished } = await flowDraftsService.getDraftStatus(flow)
        return res.json({ ...list, liveSha, lastPublished })
    } catch (error) {
        next(error)
    }
}

const getVersion = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const sha = shaParam(req)
        const flow = await flowFor(req)
        const version = await flowVersionsService.getVersion(flow, sha)
        if (!version) throw new AppError(StatusCodes.NOT_FOUND, `Version ${sha} was not found for this flow.`)
        return res.json(version)
    } catch (error) {
        next(error)
    }
}

const diffVersion = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const sha = shaParam(req)
        const against = typeof req.query.against === 'string' && req.query.against ? req.query.against : 'previous'
        if (against !== 'previous' && against !== 'current' && !SHA.test(against)) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'against is previous, current, or a version id.')
        }
        const flow = await flowFor(req)
        const diff = await flowVersionsService.diffVersion(flow, sha, against)
        if (!diff) throw new AppError(StatusCodes.NOT_FOUND, `Version ${sha} was not found for this flow.`)
        return res.json(diff)
    } catch (error) {
        next(error)
    }
}

// The permission that changes a flow of this type. The route lets in either chatflow or agentflow
// editors, so the type of the flow (and of the version, when restore changes it) is checked here.
function updatePermissionFor(type?: string | null): string {
    if (type === 'AGENTFLOW' || type === 'MULTIAGENT') return 'agentflows:update'
    if (type === 'ASSISTANT') return 'assistants:update'
    return 'chatflows:update'
}

export interface LiveRecord {
    kind: 'restore' | 'rollback' | 'promote'
    // "Restored", "Rolled back Live to" or "Promoted from Dev", for the history title.
    verb: string
    // Promote: the title of the version on Dev (it is not in this server's history) and its full id.
    title?: string
    promotedFrom?: string
}

export interface LiveResult {
    // The response body.
    body: Record<string, any>
    // The saved flow, or null when the version matched Live and nothing was saved.
    chatflow: any | null
    // The new history version, or null.
    sha: string | null
}

// Loads a version of the flow and checks the caller may put it in place: they need the update permission
// for the flow's type, and for the version's type when it differs.
async function versionFor(req: Request, flow: ChatFlow, sha: string) {
    if (!flowVersionsService.isVersioningEnabled()) {
        throw new AppError(StatusCodes.CONFLICT, 'Version history is off on this server.')
    }
    const version = await flowVersionsService.getVersion(flow, sha)
    if (!version) throw new AppError(StatusCodes.NOT_FOUND, `Version ${sha} was not found for this flow.`)
    const allowed =
        (await hasAnyPermission(req, updatePermissionFor(flow.type))) &&
        (!version.type || (await hasAnyPermission(req, updatePermissionFor(version.type))))
    if (!allowed) {
        throw new AppError(StatusCodes.FORBIDDEN, 'You do not have permission to change this type of flow.')
    }
    return version
}

function credentialNotes(version: any) {
    return {
        missingCredentials: version.missingCredentials,
        ambiguousCredentials: version.ambiguousCredentials || [],
        hiddenSecrets: version.hiddenSecrets || []
    }
}

// Puts a saved version back as the flow's Live canvas through the normal update path, so the harness
// sync, validation, and file handling all run. History gains a new "Restored" (or "Rolled back") version;
// nothing is erased, so it can be undone the same way. Used by Restore and by Roll back Live.
export async function putVersionLive(req: Request, flow: ChatFlow, sha: string, record: LiveRecord): Promise<LiveResult> {
    const workspaceId = req.user?.activeWorkspaceId
    const orgId = req.user?.activeOrganizationId
    if (!workspaceId || !orgId) throw new AppError(StatusCodes.NOT_FOUND, 'Workspace not found.')
    const version = await versionFor(req, flow, sha)
    // Promote never puts a version Live without every credential it uses: it would fail for real users.
    if (record.kind === 'promote' && version.missingCredentials.length) {
        throw new AppError(StatusCodes.CONFLICT, missingCredentialsMessage(version.missingCredentials))
    }

    // Unchanged is decided from the content, before anything is saved: same canvas, same name, same type,
    // and no live secret where the version holds a hidden-secret placeholder.
    const diff = await flowVersionsService.diffVersion(flow, sha, 'current')
    const typeChanged = Boolean(version.type && version.type !== flow.type)
    // The version brings its category back too (Restore, Roll back and Promote alike), so Live matches the version
    // exactly and a version that only differs in category still counts as a change.
    const categoryChanged = (version.category ?? '') !== String(flow.category || '')
    const hiddenChanged = flowVersionsService.hiddenInputsDiffer(flow.flowData, version.flowData, version.hiddenSecrets || [])
    if (diff && !flowVersionsService.hasChanges(diff) && !typeChanged && !categoryChanged && !hiddenChanged) {
        return {
            chatflow: null,
            sha: null,
            body: {
                chatflow: { id: flow.id, name: flow.name, type: flow.type, updatedDate: flow.updatedDate },
                restoredFrom: sha,
                restoredTo: 'live',
                version: null,
                unchanged: true,
                recorded: false,
                historyError: null,
                ...credentialNotes(version)
            }
        }
    }

    const { versions } = record.title === undefined ? await flowVersionsService.listVersions(flow.id) : { versions: [] }
    const entry = versions.find((item) => item.sha.startsWith(sha))
    const update = new ChatFlow()
    update.id = flow.id
    update.flowData = version.flowData
    update.name = version.name
    // The saved type comes back too, so an Agentflow version is not stored as a chatflow.
    if (version.type) update.type = version.type as ChatFlow['type']
    update.category = (version.category || null) as unknown as string
    const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''
    let recorded: Promise<string | null> = Promise.resolve(null)
    const chatflow = await chatflowsService.updateChatflow(flow, update, orgId, workspaceId, subscriptionId, {
        versionRecord: {
            kind: record.kind,
            title: flowVersionsService.restoreTitle(sha, record.title ?? entry?.title, record.verb),
            ...(record.promotedFrom ? { promotedFrom: record.promotedFrom } : {})
        },
        actor: actorFromUser(req.user),
        // The version replaces Live only while Live is still the canvas this check read.
        expectedFlowData: flow.flowData,
        onVersionQueued: (result) => {
            recorded = result
        }
    })
    // The result of this save's own history record: a commit id, or null when it could not be written.
    const newSha = await recorded
    const after = newSha ? (await flowVersionsService.listVersions(flow.id)).versions.find((item) => item.sha === newSha) : undefined
    // Only what the page needs to go back to the right canvas; the canvas reloads the flow itself.
    return {
        chatflow,
        sha: newSha,
        body: {
            chatflow: { id: chatflow.id, name: chatflow.name, type: chatflow.type, updatedDate: chatflow.updatedDate },
            restoredFrom: sha,
            restoredTo: 'live',
            version: after || null,
            unchanged: false,
            recorded: Boolean(newSha),
            historyError: newSha ? null : flowVersionsService.lastErrorFor(flow.id),
            ...credentialNotes(version)
        }
    }
}

// Restore. When the canvas saves to a draft, the version becomes the draft and Live is untouched until
// Publish; Roll back Live is the way to change Live at once. Otherwise the version is put Live, as before.
const restoreVersion = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const sha = shaParam(req)
        const workspaceId = req.user?.activeWorkspaceId
        const orgId = req.user?.activeOrganizationId
        if (!workspaceId || !orgId) throw new AppError(StatusCodes.NOT_FOUND, 'Workspace not found.')
        const flow = await flowFor(req)
        const drafts = await flowDraftsService.getDraftStatus(flow)
        if (drafts.mode !== 'draft') {
            return res.json((await putVersionLive(req, flow, sha, { kind: 'restore', verb: 'Restored' })).body)
        }
        const version = await versionFor(req, flow, sha)
        // A draft holds the canvas only, so a version of another kind of flow cannot become the draft.
        if (version.type && version.type !== flow.type) {
            throw new AppError(
                StatusCodes.CONFLICT,
                'This version is a different kind of flow, so it cannot become the draft. Use Roll back Live instead.'
            )
        }
        const status = await flowDraftsService.saveDraft(flow, version.flowData, {
            userId: req.user?.id || null,
            orgId,
            subscriptionId: req.user?.activeOrganizationSubscriptionId || ''
        })
        return res.json({
            chatflow: { id: flow.id, name: flow.name, type: flow.type, updatedDate: flow.updatedDate },
            restoredFrom: sha,
            restoredTo: 'draft',
            draft: status,
            version: null,
            // The version matches Live, so there is nothing left to publish.
            unchanged: !status.draft,
            recorded: false,
            historyError: null,
            ...credentialNotes(version)
        })
    } catch (error) {
        next(error)
    }
}

// The GitHub copy is server-wide. Its errors carry a plain sentence and a status, never the token.
function githubError(error: unknown): unknown {
    if (error instanceof GithubError) return new AppError(error.status, error.message)
    return error
}

const getGithub = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await flowVersionsService.getGithub().status())
    } catch (error) {
        next(githubError(error))
    }
}

const connectGithub = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = req.body || {}
        return res.json(
            await flowVersionsService
                .getGithub()
                .connect(
                    { repo: body.repo, token: body.token, credentialId: body.credentialId, credentialName: body.credentialName },
                    req.user?.activeWorkspaceId
                )
        )
    } catch (error) {
        next(githubError(error))
    }
}

const disconnectGithub = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await flowVersionsService.getGithub().disconnect())
    } catch (error) {
        next(githubError(error))
    }
}

const pushGithub = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await flowVersionsService.getGithub().tryNow())
    } catch (error) {
        next(githubError(error))
    }
}

const listGithubRepos = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(
            await flowVersionsService
                .getGithub()
                .listRepos({ token: req.body?.token, credentialId: req.body?.credentialId }, req.user?.activeWorkspaceId)
        )
    } catch (error) {
        next(githubError(error))
    }
}

const createGithubRepo = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(
            await flowVersionsService
                .getGithub()
                .createRepo(
                    { token: req.body?.token, credentialId: req.body?.credentialId, name: req.body?.name },
                    req.user?.activeWorkspaceId
                )
        )
    } catch (error) {
        next(githubError(error))
    }
}

const setEnvironment = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await flowVersionsService.getGithub().setEnvironment(req.body?.environment ?? null))
    } catch (error) {
        next(githubError(error))
    }
}

export default {
    listGithubRepos,
    createGithubRepo,
    setEnvironment,
    getGithub,
    connectGithub,
    disconnectGithub,
    pushGithub,
    getStatus,
    listVersions,
    getVersion,
    diffVersion,
    restoreVersion
}
