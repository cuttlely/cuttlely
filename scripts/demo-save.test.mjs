// Try the demo on a fresh install, and again when a previous attempt left the specialist
// workspaces behind. The name-reuse check still refuses a real profile leftover, a linked
// workspace, and another harness's workspace.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, describe, it } from 'node:test'

let ran = 0
process.on('uncaughtException', (error) => {
    process.exitCode = 1
    console.error(error)
})
process.on('exit', () => {
    if (ran > 0) return
    process.exitCode = 1
    console.error('demo-save ran no tests')
})

const root = path.join(import.meta.dirname, '..')
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cuttlely-demo-save-'))
process.env.CUTTLELY_DATA_DIR = dataDir
process.env.CUTTLELY_HERMES_HOME = path.join(dataDir, 'hermes')
process.env.CUTTLELY_WARM_HERMES = 'false'

const serverRequire = createRequire(path.join(root, 'packages', 'server', 'package.json'))
serverRequire('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: {
        module: 'commonjs',
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        strict: false,
        skipLibCheck: true,
        target: 'ES2022'
    }
})

const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const stringInput = (name) => ({ label: name, name, type: 'string', optional: true })
const boolInput = (name) => ({ label: name, name, type: 'boolean', optional: true })
const componentNodes = {
    chatOpenAI: {
        name: 'chatOpenAI',
        label: 'ChatOpenAI',
        category: 'Chat Models',
        baseClasses: ['ChatOpenAI', 'BaseChatModel'],
        credential: { label: 'Connect Credential', name: 'credential', type: 'credential', credentialNames: ['openAIApi'] },
        inputs: [{ label: 'Model Name', name: 'modelName', type: 'string', default: 'gpt-4.1-mini' }]
    },
    harnessChief: {
        name: 'harnessChief',
        label: 'Harness Prime',
        type: 'HarnessChief',
        category: 'Harness',
        baseClasses: ['HarnessChief'],
        inputs: [
            { label: 'Chat Model', name: 'chatModel', type: 'BaseChatModel' },
            { label: 'Specialists', name: 'specialists', type: 'HarnessSpecialist', list: true, optional: true },
            stringInput('instructions')
        ]
    },
    harnessSpecialist: {
        name: 'harnessSpecialist',
        label: 'Harness Specialist',
        type: 'HarnessSpecialist',
        category: 'Harness',
        baseClasses: ['HarnessSpecialist'],
        inputs: [
            stringInput('specialistName'),
            stringInput('routingSummary'),
            stringInput('instructions'),
            boolInput('enableCodeExecution'),
            boolInput('enableShell'),
            boolInput('enableBrowser'),
            boolInput('enableFileAccess')
        ]
    }
}

let savedCanvas = null
let saveCount = 0
const appMod = serverRequire('./src/utils/getRunningExpressApp.ts')
appMod.getRunningExpressApp = () => ({
    AppDataSource: {
        getRepository: () => ({
            findOneBy: async (where) => {
                if (!savedCanvas) return null
                if (where?.name && where.name !== savedCanvas.name) return null
                if (where?.workspaceId && where.workspaceId !== savedCanvas.workspaceId) return null
                return savedCanvas
            }
        })
    },
    nodesPool: { componentNodes },
    usageCacheManager: {}
})

const harnesses = serverRequire('./src/services/harnesses/index.ts')
const chatflows = serverRequire('./src/services/chatflows/index.ts')
chatflows.default.saveChatflow = async (chatflow) => {
    const flow = JSON.parse(chatflow.flowData)
    const specialists = (flow.nodes || [])
        .filter((node) => node.data?.name === 'harnessSpecialist')
        .map((node) => ({
            name: node.data.inputs.specialistName,
            codeExecution: node.data.inputs.enableCodeExecution === true
        }))
    await harnesses.assertNameAvailable(chatflow.name, chatflow.workspaceId, {
        claiming: true,
        record: {
            name: chatflow.name,
            chief: { model: { nodeName: 'chatOpenAI', credential: 'cred-1' } },
            specialists
        }
    })
    saveCount += 1
    return { id: 'flow-customer-care', name: chatflow.name, workspaceId: chatflow.workspaceId, type: chatflow.type }
}

const credentials = serverRequire('./src/services/credentials/index.ts')
credentials.default.assertCredentialInWorkspace = async () => {}
credentials.default.getAllCredentials = async () => [{ id: 'cred-1', name: 'OpenAI demo', credentialName: 'openAIApi' }]

const demo = serverRequire('./src/services/demo/index.ts').default
const profile = await import(pathToFileURL(path.join(root, 'packages', 'harness', 'profile.mjs')).href)
const cleanup = await import(pathToFileURL(path.join(root, 'packages', 'harness', 'cleanup.mjs')).href)

const caller = {
    orgId: 'org-1',
    workspaceId: WORKSPACE,
    subscriptionId: 'sub-1',
    harnessCaller: { via: 'session' }
}

const specialistDir = (name) => profile.specialistWorkspace(profile.specialistProfileName('customer-care-demo', name))

after(async () => {
    ;(await import(pathToFileURL(path.join(root, 'packages', 'harness', 'lock.mjs')).href)).closeQueueDb()
    await rm(dataDir, { recursive: true, force: true })
})

describe('Try the demo save', () => {
    it('saves the customer care team on a fresh install', async () => {
        ran += 1
        const saved = await demo.create('cred-1', caller, 'customer-care')
        assert.equal(saved.created, true)
        assert.equal(saved.name, 'customer-care-demo')
        assert.deepEqual(fs.readdirSync(specialistDir('customer')).sort(), ['.cuttlely-demo-stage', 'support.sqlite', 'support_desk.py'])
        assert.deepEqual(fs.readdirSync(specialistDir('operations')).sort(), [
            '.cuttlely-demo-stage',
            'fulfillment.py',
            'fulfillment.sqlite'
        ])
        assert.deepEqual(fs.readdirSync(specialistDir('policy')).sort(), ['.cuttlely-demo-stage', 'policy_book.py', 'service-policy.md'])
    })

    it('saves again when the demo specialist folders are already there', async () => {
        ran += 1
        assert.ok(fs.existsSync(specialistDir('customer')))
        const saved = await demo.create('cred-1', caller, 'customer-care')
        assert.equal(saved.created, true)
        assert.equal(saved.name, 'customer-care-demo')
        assert.ok(fs.existsSync(path.join(specialistDir('customer'), 'support.sqlite')))
        assert.ok(fs.existsSync(path.join(specialistDir('operations'), 'fulfillment.sqlite')))
        assert.ok(fs.existsSync(path.join(specialistDir('policy'), 'service-policy.md')))
    })

    it('still refuses a profile leftover, a linked workspace, and another harness workspace', async () => {
        ran += 1
        const customer = specialistDir('customer')
        const profiles = path.join(dataDir, 'hermes', 'profiles')
        fs.mkdirSync(path.join(profiles, 'customer-care-demo--customer'), { recursive: true })
        fs.writeFileSync(path.join(profiles, 'customer-care-demo--customer', 'private.md'), 'keep')
        fs.writeFileSync(path.join(customer, 'keep-real.txt'), 'keep')
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-demo-outside-'))
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'keep')
        fs.rmSync(specialistDir('policy'), { recursive: true, force: true })
        fs.symlinkSync(outside, specialistDir('policy'))
        const other = path.join(dataDir, 'workspaces', 'other-team--notes')
        fs.mkdirSync(other, { recursive: true })
        fs.writeFileSync(path.join(other, 'keep.txt'), 'keep')
        await assert.rejects(demo.create('cred-1', caller, 'customer-care'), (error) => {
            assert.equal(error.statusCode, 503)
            assert.match(error.message, /could not be removed/)
            return true
        })
        assert.equal(fs.readFileSync(path.join(profiles, 'customer-care-demo--customer', 'private.md'), 'utf8'), 'keep')
        assert.equal(fs.readFileSync(path.join(customer, 'keep-real.txt'), 'utf8'), 'keep')
        assert.ok(fs.lstatSync(specialistDir('policy')).isSymbolicLink())
        assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'keep')
        assert.equal(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8'), 'keep')
        fs.mkdirSync(path.join(dataDir, 'workspaces', 'wsonly--a'), { recursive: true })
        fs.writeFileSync(path.join(dataDir, 'workspaces', 'wsonly--a', 'notes.txt'), 'old harness files')
        const kept = await cleanup.removeHarnessProfiles('wsonly')
        assert.ok(kept.kept.includes('workspaces/wsonly--a'))
        assert.equal(fs.readFileSync(path.join(dataDir, 'workspaces', 'wsonly--a', 'notes.txt'), 'utf8'), 'old harness files')
        fs.rmSync(outside, { recursive: true, force: true })
        fs.rmSync(path.join(profiles, 'customer-care-demo--customer'), { recursive: true, force: true })
        fs.rmSync(specialistDir('policy'), { force: true })
    })

    it('does not remove a demo folder when another demo name holds a non-demo file', async () => {
        ran += 1
        const customer = specialistDir('customer')
        const operationsFile = path.join(specialistDir('operations'), 'fulfillment.py')
        fs.writeFileSync(path.join(customer, 'notes.txt'), 'not demo staging')
        const before = fs.readFileSync(operationsFile, 'utf8')
        fs.writeFileSync(operationsFile, `${before}\nLOCAL`)
        const savesBefore = saveCount
        await assert.rejects(demo.create('cred-1', caller, 'customer-care'), (error) => {
            assert.equal(error.statusCode, 503)
            assert.match(error.message, /could not be removed/)
            return true
        })
        assert.equal(saveCount, savesBefore)
        assert.equal(fs.readFileSync(path.join(customer, 'notes.txt'), 'utf8'), 'not demo staging')
        assert.equal(fs.readFileSync(operationsFile, 'utf8'), `${before}\nLOCAL`)
        assert.ok(fs.existsSync(path.join(customer, 'support.sqlite')))
    })

    it('fills missing specialist files for a demo that is already saved', async () => {
        ran += 1
        for (const name of ['customer', 'operations', 'policy']) fs.rmSync(specialistDir(name), { recursive: true, force: true })
        savedCanvas = {
            id: 'flow-customer-care',
            name: 'customer-care-demo',
            workspaceId: WORKSPACE,
            type: 'HARNESS'
        }
        const savesBefore = saveCount
        const saved = await demo.create('cred-1', caller, 'customer-care')
        assert.equal(saved.created, false)
        assert.equal(saved.id, 'flow-customer-care')
        assert.equal(saveCount, savesBefore)
        assert.deepEqual(fs.readdirSync(specialistDir('customer')).sort(), ['.cuttlely-demo-stage', 'support.sqlite', 'support_desk.py'])
        assert.ok(fs.existsSync(path.join(specialistDir('operations'), 'fulfillment.sqlite')))
        assert.ok(fs.existsSync(path.join(specialistDir('policy'), 'service-policy.md')))
        const repeat = await demo.create('cred-1', caller, 'customer-care')
        assert.equal(repeat.created, false)
        assert.equal(saveCount, savesBefore)
        savedCanvas = null
    })
})
