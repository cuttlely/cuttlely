import fs from 'fs'
import path from 'path'
import { StatusCodes } from 'http-status-codes'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import { runBuilder } from '../builder/core'
import { CredentialSummary, PartDefinition } from '../builder/recipe'
import { harnessRecipe } from '../builder/recipes/harness'
import chatflowsService from '../chatflows'
import credentialsService from '../credentials'
import etlService from '../etl'
import { loadHarness } from '../harnesses'
import { VersionActor } from '../flow-versions/author'
import { DEMOS, DemoDefinition, demoById, demoCredentialNames, demoModelFor, withDemoStarters } from './plan'

// node:sqlite is built into Node 24, which Cuttlely requires (ETL opens its database the same way).
type SqliteModule = { DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void } }
const RUN_WAIT_MS = 120000
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled'])

// samples/demo/<name> in this checkout or image.
function demoDataDir(name: string): string {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidate = path.join(dir, 'samples', 'demo', name)
        if (fs.existsSync(candidate)) return candidate
        dir = path.dirname(dir)
    }
    throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `The bundled ${name} demo data was not found.`)
}

// A specialist's own folder gets its made-up files: each .sql file becomes a SQLite database of the same name, and
// any other file is copied. Rebuilt each time, so a demo that was changed by hand starts clean again.
export async function stageDemoFiles(folder: string, source: string, files: string[]): Promise<void> {
    fs.mkdirSync(folder, { recursive: true })
    const { DatabaseSync } = require('node:sqlite') as SqliteModule
    for (const file of files) {
        if (!file.endsWith('.sql')) {
            fs.copyFileSync(path.join(source, file), path.join(folder, file))
            continue
        }
        const target = path.join(folder, `${path.basename(file, '.sql')}.sqlite`)
        const temp = path.join(folder, `.${path.basename(file, '.sql')}-${process.pid}-${Date.now()}.sqlite`)
        const db = new DatabaseSync(temp)
        try {
            db.exec(fs.readFileSync(path.join(source, file), 'utf8'))
        } finally {
            db.close()
        }
        fs.renameSync(temp, target)
    }
}

// The bakery analyst's folder: the made-up sales database and the chart helper.
export async function stageBakery(folder: string, source = demoDataDir('bakery')): Promise<void> {
    await stageDemoFiles(folder, source, DEMOS.bakery.files.analyst)
}

async function existingDemo(demo: DemoDefinition, workspaceId: string): Promise<ChatFlow | null> {
    return getRunningExpressApp()
        .AppDataSource.getRepository(ChatFlow)
        .findOneBy({ name: demo.harness, type: EnumChatflowType.HARNESS, workspaceId })
}

// The demo's knowledge pipeline in this workspace, imported from the bundled sample and run once when it is new.
async function demoPipeline(demo: DemoDefinition, workspaceId: string): Promise<string> {
    const pipelines: any[] = (await etlService.listPipelines(workspaceId)) || []
    let pipeline = pipelines.find((item) => item.name === demo.pipelineName)
    if (!pipeline) {
        const saved: any = await etlService.importSample(demo.pipelineSample, workspaceId)
        pipeline = { id: saved.id, name: saved.name, lastRun: null }
    }
    if (pipeline.lastRun?.status !== 'succeeded') {
        const run: any = await etlService.startRun(pipeline.id, {}, workspaceId)
        const started = Date.now()
        let status = run?.status
        while (!TERMINAL.has(status) && Date.now() - started < RUN_WAIT_MS) {
            await new Promise((resolve) => setTimeout(resolve, 500))
            status = ((await etlService.getRun(run.id, 0, workspaceId)) as any)?.status
        }
        if (status !== 'succeeded' && status !== 'partial')
            throw new InternalFlowiseError(
                StatusCodes.INTERNAL_SERVER_ERROR,
                `The ${demo.pipelineName} pipeline did not finish its first run (${status || 'no status'}). Open ETL to see why.`
            )
    }
    return pipeline.name
}

const componentNodes = () => getRunningExpressApp().nodesPool.componentNodes as Record<string, PartDefinition>

// What the Try the demo card needs: the credential types the demos run on, and each demo already made here, if any.
const status = async (workspaceId: string) => {
    const demos: Record<string, { id: string; name: string; starterQuestions: string[] } | null> = {}
    for (const demo of Object.values(DEMOS)) {
        const made = await existingDemo(demo, workspaceId)
        demos[demo.id] = made ? { id: made.id, name: made.name, starterQuestions: demo.starters } : null
    }
    return { credentialNames: demoCredentialNames(componentNodes()), demos }
}

export interface DemoCaller {
    orgId: string
    workspaceId: string
    subscriptionId: string
    actor?: VersionActor
}

// Makes a demo team with the person's own model key. A second call returns the team made the first time.
const create = async (credentialId: unknown, caller: DemoCaller, demoId?: unknown) => {
    const { orgId, workspaceId, subscriptionId, actor } = caller
    const demo = demoById(demoId)
    if (typeof credentialId !== 'string' || !credentialId)
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Pick the model key the demo should use.')
    await credentialsService.assertCredentialInWorkspace(credentialId, workspaceId)
    const existing = await existingDemo(demo, workspaceId)
    if (existing) return { id: existing.id, name: existing.name, created: false, starterQuestions: demo.starters }

    const nodes = componentNodes()
    const rows: any[] = (await credentialsService.getAllCredentials(undefined, workspaceId)) || []
    const credentials: CredentialSummary[] = rows.map((row) => ({ id: row.id, name: row.name, credentialName: row.credentialName }))
    const credential = credentials.find((row) => row.id === credentialId)
    const model = credential && demoModelFor(credential.credentialName, nodes)
    if (!credential || !model)
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'That key is not for a chat model. Pick a model key, such as OpenAI API.')

    // Harness names are shared by every workspace. A record left here by a deleted demo is replaced on save.
    const record = (await loadHarness('store.mjs')).getHarness(demo.harness)
    if (record && record.workspaceId !== workspaceId)
        throw new InternalFlowiseError(StatusCodes.CONFLICT, `A team named ${demo.harness} already exists in another workspace.`)

    const pipelineName = demo.pipelineSample ? await demoPipeline(demo, workspaceId) : ''
    const profile = await loadHarness('profile.mjs')
    const source = demoDataDir(demo.dataDir)
    const folders: Record<string, string> = {}
    for (const [specialist, files] of Object.entries(demo.files)) {
        const folder = profile.specialistWorkspace(profile.specialistProfileName(demo.harness, specialist))
        await stageDemoFiles(folder, source, files)
        folders[specialist] = folder.split(path.sep).join('/')
    }

    const chatModel = { name: model.name, credential: credentialId, inputs: model.modelName ? { modelName: model.modelName } : {} }
    const plan = demo.plan(pipelineName, folders)
    const built = await runBuilder(harnessRecipe, 'Try the demo', { componentNodes: nodes, chatModel, credentials }, async () =>
        JSON.stringify(plan)
    )
    if (!built.ok)
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `The demo team did not pass the check: ${built.problems.join(' ')}`
        )

    const chatflow = new ChatFlow()
    Object.assign(chatflow, {
        name: demo.harness,
        type: EnumChatflowType.HARNESS,
        flowData: JSON.stringify({ nodes: built.nodes, edges: built.edges, viewport: { x: 0, y: 0, zoom: 0.6 } }),
        chatbotConfig: withDemoStarters(undefined, demo.starters),
        deployed: false,
        isPublic: false,
        workspaceId
    })
    const saved = await chatflowsService.saveChatflow(
        chatflow,
        orgId,
        workspaceId,
        subscriptionId,
        getRunningExpressApp().usageCacheManager,
        actor
    )
    logger.info(`[server]: Try the demo made ${demo.harness} with ${model.name}${model.modelName ? ` (${model.modelName})` : ''}`)
    return { id: saved.id, name: saved.name, created: true, starterQuestions: demo.starters }
}

export default { status, create }
