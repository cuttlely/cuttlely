import fs from 'fs'
import path from 'path'
import { StatusCodes } from 'http-status-codes'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { AppError } from '../../errors/appError'
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
import type { IHarnessCaller } from '../../Interface'
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
    throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `The bundled ${name} demo data was not found.`)
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

// The file stageDemoFiles writes for one bundled source file. A .sql file becomes a SQLite database.
function stagedFileName(file: string): string {
    return file.endsWith('.sql') ? `${path.basename(file, '.sql')}.sqlite` : path.basename(file)
}

// Written next to files this demo stages. 1.7.3 staged the same files and did not write this marker.
const DEMO_STAGE_MARKER = '.cuttlely-demo-stage'

function stageMarkerText(harness: string, profileName: string): string {
    return `${harness}\n${profileName}\n`
}

function specialistFilesReady(folder: string, files: string[]): boolean {
    return files.every((file) => {
        try {
            return fs.lstatSync(path.join(folder, stagedFileName(file))).isFile()
        } catch {
            return false
        }
    })
}

function isTempSqlite(name: string, files: string[]): boolean {
    return files.some((file) => {
        if (!file.endsWith('.sql')) return false
        const base = path.basename(file, '.sql')
        return new RegExp(`^\\.${base}-\\d+-\\d+\\.sqlite$`).test(name)
    })
}

// A plain directory this demo may remove. Its entries are only that specialist's bundled file names.
// A marker from this demo may sit with them, and so may the temporary sqlite file written before rename.
// A link, a profile, or any other file stays. An unmarked folder is the leftover 1.7.3 wrote before the save.
function workspaceIsThisDemo(folder: string, harness: string, profileName: string, files: string[], source: string): boolean {
    let stat: fs.Stats
    try {
        stat = fs.lstatSync(folder)
    } catch {
        return false
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    const expected = new Set(files.map(stagedFileName))
    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(folder, { withFileTypes: true })
    } catch {
        return false
    }
    let marked = false
    let staged = 0
    let temp = 0
    const copied: string[] = []
    for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isFile()) return false
        if (entry.name === DEMO_STAGE_MARKER) {
            let text = ''
            try {
                text = fs.readFileSync(path.join(folder, entry.name), 'utf8')
            } catch {
                return false
            }
            if (text !== stageMarkerText(harness, profileName)) return false
            marked = true
            continue
        }
        if (expected.has(entry.name)) {
            staged += 1
            if (!entry.name.endsWith('.sqlite')) copied.push(entry.name)
            continue
        }
        if (isTempSqlite(entry.name, files)) {
            temp += 1
            continue
        }
        return false
    }
    // 1.7.3 did not write a marker or leave the temporary sqlite name behind after a finished stage.
    // An unmarked folder must hold every bundled file, and each non-sqlite file must be the bundled bytes.
    if (!marked && (temp > 0 || staged !== expected.size)) return false
    if (
        !marked &&
        copied.some((name) => {
            const bundled = files.find((file) => stagedFileName(file) === name)
            return !bundled || !fs.readFileSync(path.join(folder, name)).equals(fs.readFileSync(path.join(source, bundled)))
        })
    )
        return false
    return staged > 0
}

function isRegularFile(file: string): boolean {
    try {
        return fs.lstatSync(file).isFile()
    } catch {
        return false
    }
}

// Copies one bundled file when that name is not already a regular file, so a later Try the demo
// does not replace a specialist file someone edited.
function writeMissingStagedFile(folder: string, source: string, file: string): void {
    const dest = path.join(folder, stagedFileName(file))
    if (isRegularFile(dest)) return
    try {
        if (fs.lstatSync(dest)) return
    } catch {
        // Missing. Write it.
    }
    if (!file.endsWith('.sql')) {
        fs.copyFileSync(path.join(source, file), dest)
        return
    }
    const { DatabaseSync } = require('node:sqlite') as SqliteModule
    const temp = path.join(folder, `.${path.basename(file, '.sql')}-${process.pid}-${Date.now()}.sqlite`)
    const db = new DatabaseSync(temp)
    try {
        db.exec(fs.readFileSync(path.join(source, file), 'utf8'))
    } finally {
        db.close()
    }
    fs.renameSync(temp, dest)
}

async function stageDemoWorkspace(folder: string, source: string, files: string[], harness: string, profileName: string): Promise<void> {
    let stat: fs.Stats | null = null
    try {
        stat = fs.lstatSync(folder)
    } catch {
        stat = null
    }
    // A link is not a place to write the demo. A missing folder is created here.
    if (stat?.isSymbolicLink()) throw new Error(`Demo folder is a link: ${path.basename(folder)}`)
    fs.mkdirSync(folder, { recursive: true })
    for (const file of files) writeMissingStagedFile(folder, source, file)
    const marker = path.join(folder, DEMO_STAGE_MARKER)
    if (!isRegularFile(marker)) fs.writeFileSync(marker, stageMarkerText(harness, profileName), { flag: 'wx' })
}

// Writes any specialist folder that is missing a bundled file. A team that was saved and then stopped
// before this copy finished is completed on the next Try the demo. A complete folder is left as it is.
async function ensureDemoFiles(demo: DemoDefinition): Promise<void> {
    const profile = await loadHarness('profile.mjs')
    const source = demoDataDir(demo.dataDir)
    for (const [specialist, files] of Object.entries(demo.files)) {
        const profileName = profile.specialistProfileName(demo.harness, specialist)
        const folder = profile.specialistWorkspace(profileName)
        if (!specialistFilesReady(folder, files)) await stageDemoWorkspace(folder, source, files, demo.harness, profileName)
    }
}

// nameReuseBlockers refuses a save over a workspace that is already there. Remove one only when every
// blocker is a directory this demo staged (its marker and only its own files). Any other blocker means
// nothing is removed, so a later refusal cannot follow a partial delete.
async function releaseIdentifiedDemoWorkspaces(demo: DemoDefinition): Promise<void> {
    const profile = await loadHarness('profile.mjs')
    const cleanup = await loadHarness('cleanup.mjs')
    const byProfile = new Map<string, { folder: string; files: string[] }>()
    const expected: string[] = []
    for (const [specialist, files] of Object.entries(demo.files)) {
        const profileName = profile.specialistProfileName(demo.harness, specialist)
        expected.push(profileName)
        byProfile.set(profileName, { folder: profile.specialistWorkspace(profileName), files })
    }
    const source = demoDataDir(demo.dataDir)
    const blockers = cleanup.nameReuseBlockers(demo.harness, { expected }) as string[]
    if (!blockers.length) return
    const folders: Array<{ folder: string; files: string[]; profileName: string }> = []
    for (const blocker of blockers) {
        const match = /^workspaces\/([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(blocker)
        const staged = match ? byProfile.get(match[1]) : undefined
        if (!match || !staged || !workspaceIsThisDemo(staged.folder, demo.harness, match[1], staged.files, source)) return
        folders.push({ ...staged, profileName: match[1] })
    }
    const again = (cleanup.nameReuseBlockers(demo.harness, { expected }) as string[]).slice().sort().join('\n')
    if (again !== blockers.slice().sort().join('\n')) return
    for (const item of folders) {
        if (!workspaceIsThisDemo(item.folder, demo.harness, item.profileName, item.files, source)) return
    }
    for (const item of folders) fs.rmSync(item.folder, { recursive: true, force: true })
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
            throw new AppError(
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
    // Who makes the demo canvas. An API key needs the demo harness name on its own list.
    harnessCaller: IHarnessCaller
}

// Makes a demo team with the person's own model key. A second call returns the team made the first time.
const create = async (credentialId: unknown, caller: DemoCaller, demoId?: unknown) => {
    const { orgId, workspaceId, subscriptionId, actor, harnessCaller } = caller
    const demo = demoById(demoId)
    if (typeof credentialId !== 'string' || !credentialId)
        throw new AppError(StatusCodes.BAD_REQUEST, 'Pick the model key the demo should use.')
    await credentialsService.assertCredentialInWorkspace(credentialId, workspaceId)
    const existing = await existingDemo(demo, workspaceId)
    if (existing) {
        await ensureDemoFiles(demo)
        return { id: existing.id, name: existing.name, created: false, starterQuestions: demo.starters }
    }

    const nodes = componentNodes()
    const rows: any[] = (await credentialsService.getAllCredentials(undefined, workspaceId)) || []
    const credentials: CredentialSummary[] = rows.map((row) => ({ id: row.id, name: row.name, credentialName: row.credentialName }))
    const credential = credentials.find((row) => row.id === credentialId)
    const model = credential && demoModelFor(credential.credentialName, nodes)
    if (!credential || !model)
        throw new AppError(StatusCodes.BAD_REQUEST, 'That key is not for a chat model. Pick a model key, such as OpenAI API.')

    // Harness names are shared by every workspace. A record left here by a deleted demo is replaced on save.
    const record = (await loadHarness('store.mjs')).getHarness(demo.harness)
    if (record && record.workspaceId !== workspaceId)
        throw new AppError(StatusCodes.CONFLICT, `A team named ${demo.harness} already exists in another workspace.`)

    const pipelineName = demo.pipelineSample ? await demoPipeline(demo, workspaceId) : ''
    const profile = await loadHarness('profile.mjs')
    // The name check treats a specialist workspace that is already there as a leftover. Clear it only when
    // every blocker is a directory this demo itself staged. Any other blocker is left for that check.
    await releaseIdentifiedDemoWorkspaces(demo)
    const folders: Record<string, string> = {}
    for (const specialist of Object.keys(demo.files)) {
        folders[specialist] = profile.specialistWorkspace(profile.specialistProfileName(demo.harness, specialist)).split(path.sep).join('/')
    }

    const chatModel = { name: model.name, credential: credentialId, inputs: model.modelName ? { modelName: model.modelName } : {} }
    const plan = demo.plan(pipelineName, folders)
    const built = await runBuilder(harnessRecipe, 'Try the demo', { componentNodes: nodes, chatModel, credentials }, async () =>
        JSON.stringify(plan)
    )
    if (!built.ok)
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `The demo team did not pass the check: ${built.problems.join(' ')}`)

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
        actor,
        { caller: harnessCaller }
    )
    // The save compiles the profiles. The specialist files go in after that, so the name check never sees
    // this demo's own folders as leftovers. A later Try the demo fills any folder this copy did not finish.
    await ensureDemoFiles(demo)
    logger.info(`[server]: Try the demo made ${demo.harness} with ${model.name}${model.modelName ? ` (${model.modelName})` : ''}`)
    return { id: saved.id, name: saved.name, created: true, starterQuestions: demo.starters }
}

export default { status, create }
