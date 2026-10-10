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
import {
    ANALYST,
    DEMO_HARNESS,
    DEMO_PIPELINE_SAMPLE,
    DEMO_STARTERS,
    demoCredentialNames,
    demoModelFor,
    demoPlan,
    withDemoStarters
} from './plan'

// node:sqlite is built into Node 24, which Cuttlely requires (ETL opens its database the same way).
type SqliteModule = { DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void } }
const RUN_WAIT_MS = 120000
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled'])

// samples/demo/bakery in this checkout or image.
function bakeryDir(): string {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidate = path.join(dir, 'samples', 'demo', 'bakery')
        if (fs.existsSync(path.join(candidate, 'bakery.sql'))) return candidate
        dir = path.dirname(dir)
    }
    throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'The bundled bakery demo data was not found.')
}

// The analyst's own folder gets the made-up database and the chart helper. Rebuilt each time, so a demo that was
// changed by hand starts clean again.
export async function stageBakery(folder: string, source = bakeryDir()): Promise<void> {
    fs.mkdirSync(folder, { recursive: true })
    const { DatabaseSync } = require('node:sqlite') as SqliteModule
    const temp = path.join(folder, `.bakery-${process.pid}-${Date.now()}.sqlite`)
    const db = new DatabaseSync(temp)
    try {
        db.exec(fs.readFileSync(path.join(source, 'bakery.sql'), 'utf8'))
    } finally {
        db.close()
    }
    fs.renameSync(temp, path.join(folder, 'bakery.sqlite'))
    fs.copyFileSync(path.join(source, 'bakery_chart.py'), path.join(folder, 'bakery_chart.py'))
}

async function existingDemo(workspaceId: string): Promise<ChatFlow | null> {
    return getRunningExpressApp()
        .AppDataSource.getRepository(ChatFlow)
        .findOneBy({ name: DEMO_HARNESS, type: EnumChatflowType.HARNESS, workspaceId })
}

// The Bakery Handbook pipeline in this workspace, imported from the bundled sample and run once when it is new.
async function handbookPipeline(workspaceId: string): Promise<string> {
    const pipelines: any[] = (await etlService.listPipelines(workspaceId)) || []
    let pipeline = pipelines.find((item) => item.name === 'Bakery Handbook')
    if (!pipeline) {
        const saved: any = await etlService.importSample(DEMO_PIPELINE_SAMPLE, workspaceId)
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
                `The Bakery Handbook pipeline did not finish its first run (${status || 'no status'}). Open ETL to see why.`
            )
    }
    return pipeline.name
}

const componentNodes = () => getRunningExpressApp().nodesPool.componentNodes as Record<string, PartDefinition>

// What the Try the demo card needs: the credential types it can run on, and the demo already made here, if any.
const status = async (workspaceId: string) => {
    const demo = await existingDemo(workspaceId)
    return {
        credentialNames: demoCredentialNames(componentNodes()),
        demo: demo ? { id: demo.id, name: demo.name, starterQuestions: DEMO_STARTERS } : null
    }
}

export interface DemoCaller {
    orgId: string
    workspaceId: string
    subscriptionId: string
    actor?: VersionActor
}

// Makes the demo team with the person's own model key. A second call returns the team made the first time.
const create = async (credentialId: unknown, caller: DemoCaller) => {
    const { orgId, workspaceId, subscriptionId, actor } = caller
    if (typeof credentialId !== 'string' || !credentialId)
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Pick the model key the demo should use.')
    await credentialsService.assertCredentialInWorkspace(credentialId, workspaceId)
    const existing = await existingDemo(workspaceId)
    if (existing) return { id: existing.id, name: existing.name, created: false, starterQuestions: DEMO_STARTERS }

    const nodes = componentNodes()
    const rows: any[] = (await credentialsService.getAllCredentials(undefined, workspaceId)) || []
    const credentials: CredentialSummary[] = rows.map((row) => ({ id: row.id, name: row.name, credentialName: row.credentialName }))
    const credential = credentials.find((row) => row.id === credentialId)
    const model = credential && demoModelFor(credential.credentialName, nodes)
    if (!credential || !model)
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'That key is not for a chat model. Pick a model key, such as OpenAI API.')

    // Harness names are shared by every workspace. A record left here by a deleted demo is replaced on save.
    const record = (await loadHarness('store.mjs')).getHarness(DEMO_HARNESS)
    if (record && record.workspaceId !== workspaceId)
        throw new InternalFlowiseError(StatusCodes.CONFLICT, `A team named ${DEMO_HARNESS} already exists in another workspace.`)

    const pipelineName = await handbookPipeline(workspaceId)
    const profile = await loadHarness('profile.mjs')
    const folder = profile.specialistWorkspace(profile.specialistProfileName(DEMO_HARNESS, ANALYST))
    await stageBakery(folder)

    const chatModel = { name: model.name, credential: credentialId, inputs: model.modelName ? { modelName: model.modelName } : {} }
    const plan = demoPlan(pipelineName, folder.split(path.sep).join('/'))
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
        name: DEMO_HARNESS,
        type: EnumChatflowType.HARNESS,
        flowData: JSON.stringify({ nodes: built.nodes, edges: built.edges, viewport: { x: 0, y: 0, zoom: 0.6 } }),
        chatbotConfig: withDemoStarters(undefined),
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
    logger.info(`[server]: Try the demo made ${DEMO_HARNESS} with ${model.name}${model.modelName ? ` (${model.modelName})` : ''}`)
    return { id: saved.id, name: saved.name, created: true, starterQuestions: DEMO_STARTERS }
}

export default { status, create }
