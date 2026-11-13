import { spawn } from 'child_process'
import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { FlowVersionState } from '../../database/entities/FlowVersionState'
import { AppError } from '../../errors/appError'
import { hasAnyPermission } from '../../identity/rbac'
import chatflowsService from '../../services/chatflows'
import credentialsService from '../../services/credentials'
import flowDraftsService, { canvasHash, DraftChangedError } from '../../services/flow-drafts'
import { harnessCallerFor } from '../../services/harnesses/apiAccess'
import { beginVerification, executeVerify, recoverOrphanedRun, type SavedQuery, type VerifyRecord } from '../../services/import-verify'
import { readOnlyRows, testPinnedQuery, PinnedRequestError } from '../../services/pinned-queries'
import { pinnedQueriesEnabled } from '../../services/pinned-queries/sql'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

const active = new Map<string, AbortController>()

function permissionFor(type: string | null | undefined): string {
    if (type === 'AGENTFLOW' || type === 'MULTIAGENT') return 'agentflows:update'
    if (type === 'ASSISTANT') return 'assistants:update'
    return 'chatflows:update'
}

async function flowFor(req: Request) {
    if (req.user?.apiKeyId) throw new AppError(StatusCodes.FORBIDDEN, 'Sign in to import and verify a flow.')
    const workspaceId = req.user?.activeWorkspaceId
    if (!workspaceId) throw new AppError(StatusCodes.NOT_FOUND, 'Workspace not found.')
    const flow = await chatflowsService.getChatflowByIdForWorkspace(req.params.chatflowId, workspaceId)
    if (!(await hasAnyPermission(req, permissionFor(flow?.type)))) {
        throw new AppError(StatusCodes.FORBIDDEN, 'You do not have permission to change this type of flow.')
    }
    return flow
}

function readRecord(raw: unknown): VerifyRecord | null {
    if (!raw || typeof raw !== 'string') return null
    try {
        const parsed = JSON.parse(raw) as VerifyRecord
        if (!parsed || parsed.version !== 1) return null
        return parsed
    } catch {
        return null
    }
}

async function writeRecord(chatflowId: string, record: VerifyRecord): Promise<void> {
    await getRunningExpressApp()
        .AppDataSource.getRepository(FlowVersionState)
        .update({ chatflowId }, { importVerify: JSON.stringify(record) })
}

function python(code: string): Promise<boolean> {
    return new Promise((resolve) => {
        const child = spawn('python3', ['-c', code], { stdio: 'ignore' })
        const timer = setTimeout(() => {
            child.kill()
            resolve(false)
        }, 8000)
        child.on('error', () => {
            clearTimeout(timer)
            resolve(false)
        })
        child.on('exit', (code) => {
            clearTimeout(timer)
            resolve(code === 0)
        })
    })
}

async function run(req: Request, retryFailures: boolean): Promise<VerifyRecord> {
    const flow = await flowFor(req)
    const orgId = req.user?.activeOrganizationId
    if (!orgId) throw new AppError(StatusCodes.NOT_FOUND, 'Organization not found.')
    const workspaceId = String(req.user?.activeWorkspaceId || '')
    const state = await flowDraftsService.getState(flow.id)
    const draft = state?.draftFlowData || flow.flowData
    if (!state?.draftFlowData && flow.flowData) {
        await flowDraftsService.saveDraft(flow, flow.flowData, {
            userId: req.user?.id || null,
            orgId,
            subscriptionId: req.user?.activeOrganizationSubscriptionId || '',
            caller: await harnessCallerFor(req)
        })
    }
    const choices = req.body?.choices && typeof req.body.choices === 'object' && !Array.isArray(req.body.choices) ? req.body.choices : {}
    const controller = new AbortController()
    active.set(flow.id, controller)
    try {
        const app = getRunningExpressApp()
        const loaded = app.nodesPool?.componentNodes ? Object.keys(app.nodesPool.componentNodes) : undefined
        const starting = (await flowDraftsService.getState(flow.id))?.draftFlowData || draft
        const previous = await beginVerification({
            read: async () => readRecord((await flowDraftsService.getState(flow.id))?.importVerify),
            write: (record) => writeRecord(flow.id, record),
            draftText: starting || '',
            now: new Date().toISOString()
        })
        let expectedHash = starting ? canvasHash(starting) : undefined
        return await executeVerify({
            flowText: starting,
            record: previous,
            choices,
            retryFailures,
            deps: {
                now: () => new Date().toISOString(),
                saveFlow: async (flowText) => {
                    let written = flowText
                    try {
                        const saved = await flowDraftsService.saveDraft(flow, flowText, {
                            userId: req.user?.id || null,
                            orgId,
                            subscriptionId: req.user?.activeOrganizationSubscriptionId || '',
                            caller: await harnessCallerFor(req),
                            expectedDraftHash: expectedHash,
                            strictDraftHash: true
                        })
                        if (saved.draft?.flowData) written = saved.draft.flowData
                    } catch (error) {
                        if (error instanceof DraftChangedError) {
                            throw Object.assign(new Error('The draft changed while verification was running.'), { code: 'draft-moved' })
                        }
                        throw error
                    }
                    const stored = (await flowDraftsService.getState(flow.id))?.draftFlowData || written
                    if (canvasHash(stored) !== canvasHash(written)) {
                        throw Object.assign(new Error('The draft changed while verification was running.'), { code: 'draft-moved' })
                    }
                    expectedHash = canvasHash(stored)
                    return stored
                },
                saveRecord: (record) => writeRecord(flow.id, record),
                credentials: async () => {
                    const rows = await credentialsService.getAllCredentials(undefined, workspaceId)
                    return (Array.isArray(rows) ? rows : []).map((row) => ({
                        id: String(row.id || ''),
                        name: String(row.name || ''),
                        credentialName: String(row.credentialName || '')
                    }))
                },
                testPin: async ({ nodeId, entry, sampleValues, credentialId }) => {
                    try {
                        const result = await testPinnedQuery({
                            ...req,
                            body: {
                                nodeId,
                                entry,
                                sampleValues,
                                canvas: {
                                    credential: credentialId,
                                    inputs: {}
                                }
                            },
                            params: { ...req.params, chatflowId: flow.id }
                        } as unknown as Request)
                        return {
                            ok: true,
                            rowCount: Number(result.rowCount || 0),
                            statementHash: typeof result.statementHash === 'string' ? result.statementHash : undefined,
                            entry: result.entry as SavedQuery
                        }
                    } catch (error) {
                        const pinned = error instanceof PinnedRequestError ? error : null
                        const message = pinned?.message || (error instanceof Error ? error.message : 'The query could not be tested.')
                        const transient = /timeout|timed out|ECONNRESET|503|504|temporarily/i.test(message)
                        return { ok: false, message, transient }
                    }
                },
                discover: async ({ node, sql }) => readOnlyRows({ workspaceId, node, sql }),
                pdfAvailable: () => python('import reportlab'),
                renderPdfSample: async () => {
                    const ok = await python(
                        'import io\nfrom reportlab.pdfgen import canvas\nbuf = io.BytesIO()\nc = canvas.Canvas(buf)\nc.drawString(72, 720, "Verification sample")\nc.save()\nassert buf.tell() > 50\n'
                    )
                    if (!ok) throw new Error('The PDF library did not build a sample.')
                },
                loadedNodeNames: loaded,
                pinnedQueriesEnabled: pinnedQueriesEnabled(process.env),
                signal: controller.signal
            }
        })
    } finally {
        if (active.get(flow.id) === controller) active.delete(flow.id)
    }
}

const start = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (active.has(String(req.params.chatflowId || ''))) {
            const flow = await flowFor(req)
            const state = await flowDraftsService.getState(flow.id)
            const record = readRecord(state?.importVerify)
            if (record) return res.json({ ...record, running: true })
            return res.json({
                version: 1,
                status: 'running',
                running: true,
                phase: 'Checking this flow.',
                publishOffered: false,
                blockers: [],
                queries: [],
                smoke: [],
                connections: []
            })
        }
        return res.json(await run(req, req.body?.retryFailures === true))
    } catch (error) {
        next(error)
    }
}

const status = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req)
        const state = await flowDraftsService.getState(flow.id)
        const record = readRecord(state?.importVerify)
        if (!record)
            return res.json({ version: 1, status: 'idle', publishOffered: false, blockers: [], queries: [], smoke: [], connections: [] })
        const jobActive = active.has(flow.id)
        const recovered = recoverOrphanedRun(record, jobActive)
        if (recovered && recovered !== record) await writeRecord(flow.id, recovered)
        return res.json({ ...(recovered || record), running: jobActive })
    } catch (error) {
        next(error)
    }
}

const cancel = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = await flowFor(req)
        active.get(flow.id)?.abort()
        const state = await flowDraftsService.getState(flow.id)
        const record = readRecord(state?.importVerify)
        return res.json(record || { version: 1, status: 'incomplete', summary: 'Verification was stopped.', publishOffered: false })
    } catch (error) {
        next(error)
    }
}

export default { start, status, cancel }
