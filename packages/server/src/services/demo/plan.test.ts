import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runBuilder } from '../builder/core'
import { harnessProblems, harnessRecipe } from '../builder/recipes/harness'
import { realParts } from '../builder/testRealParts'
import {
    CUSTOMER_CARE_STARTERS,
    DEMOS,
    DEMO_STARTERS,
    customerCarePlan,
    demoById,
    demoCredentialNames,
    demoModelFor,
    demoPlan,
    withDemoStarters
} from './plan'

jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../chatflows', () => ({ __esModule: true, default: {} }))
jest.mock('../etl', () => ({ __esModule: true, default: {} }))
jest.mock('../harnesses', () => ({ loadHarness: jest.fn() }))
jest.mock('../credentials', () => ({ __esModule: true, default: {} }))

const componentNodes = realParts([
    'harnessChief',
    'harnessSpecialist',
    'etlRetriever',
    'chatOpenAI',
    'chatAnthropic',
    'chatGoogleGenerativeAI',
    'chatDeepseek'
])
const credentials = [{ id: 'cred-1', name: 'My OpenAI key', credentialName: 'openAIApi' }]
const ctx = {
    componentNodes,
    chatModel: { name: 'chatOpenAI', credential: 'cred-1', inputs: { modelName: 'gpt-4.1-mini' } },
    credentials
}

const repoRoot = path.join(__dirname, '..', '..', '..', '..', '..')
const sampleDir = (name: string) => path.join(repoRoot, 'samples', 'demo', name)

describe('Try the demo team', () => {
    it('passes the harness check and builds with the picked model key', async () => {
        const plan = demoPlan('Bakery Handbook', '/data/workspaces/bakery-demo-analyst')
        expect(harnessProblems(plan, ctx)).toEqual([])
        const built = await runBuilder(harnessRecipe, 'Try the demo', ctx, async () => JSON.stringify(plan))
        expect(built.ok).toBe(true)
        if (!built.ok) return
        expect(built.repaired).toBe(false)
        expect(built.missingCredentials).toEqual([])
        expect(built.starterQuestions).toEqual(DEMO_STARTERS)
        const byName = (name: string) => built.nodes.filter((node) => node.data.name === name)
        expect(byName('chatOpenAI')[0].data.credential).toBe('cred-1')
        expect(byName('chatOpenAI')[0].data.inputs.modelName).toBe('gpt-4.1-mini')
        const specialists = byName('harnessSpecialist')
        expect(specialists.map((node) => node.data.inputs.specialistName).sort()).toEqual(['analyst', 'librarian'])
        const analyst = specialists.find((node) => node.data.inputs.specialistName === 'analyst')
        expect(analyst.data.inputs.enableCodeExecution).toBe(true)
        expect(analyst.data.inputs.instructions).toContain('/data/workspaces/bakery-demo-analyst/bakery.sqlite')
        expect(byName('etlRetriever')[0].data.inputs.pipeline).toBe('Bakery Handbook')
        // Prime, two specialists, the handbook search and the model, all connected.
        expect(built.nodes).toHaveLength(5)
        expect(built.edges).toHaveLength(4)
    })

    it('picks a chat model card for the key type, and none for a key that is not for chat', () => {
        expect(demoModelFor('openAIApi', componentNodes)).toEqual({ name: 'chatOpenAI', modelName: 'gpt-4.1-mini' })
        expect(demoModelFor('anthropicApi', componentNodes)?.name).toBe('chatAnthropic')
        expect(demoModelFor('googleGenerativeAI', componentNodes)).toEqual({
            name: 'chatGoogleGenerativeAI',
            modelName: 'gemini-2.5-flash'
        })
        expect(demoModelFor('deepseekApi', componentNodes)).toEqual({ name: 'chatDeepseek', modelName: 'deepseek-flash' })
        expect(demoModelFor('notAModelKey', componentNodes)).toBeUndefined()
        expect(demoCredentialNames(componentNodes)).toEqual(expect.arrayContaining(['anthropicApi', 'openAIApi']))
    })

    it('puts the starter questions in the chat settings and keeps other settings', () => {
        const config = JSON.parse(withDemoStarters(JSON.stringify({ welcomeMessage: 'Hi' })))
        expect(config.welcomeMessage).toBe('Hi')
        expect(Object.values(config.starterPrompts).map((entry: any) => entry.prompt)).toEqual(DEMO_STARTERS)
        expect(JSON.parse(withDemoStarters('not json')).starterPrompts['0'].prompt).toBe(DEMO_STARTERS[0])
    })

    it('stages the made-up database and the chart helper in the analyst folder', async () => {
        const { stageBakery } = await import('./index')
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bakery-demo-'))
        try {
            await stageBakery(folder, sampleDir('bakery'))
            expect(fs.readdirSync(folder).sort()).toEqual(['bakery.sqlite', 'bakery_chart.py'])
            const { DatabaseSync } = require('node:sqlite')
            const db = new DatabaseSync(path.join(folder, 'bakery.sqlite'))
            const row = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT week_start) AS weeks FROM weekly_sales').get()
            db.close()
            expect(row).toEqual(expect.objectContaining({ n: 416, weeks: 26 }))
            // Staging again replaces the files instead of failing.
            await stageBakery(folder, sampleDir('bakery'))
            expect(fs.readdirSync(folder).sort()).toEqual(['bakery.sqlite', 'bakery_chart.py'])
        } finally {
            fs.rmSync(folder, { recursive: true, force: true })
        }
    })
})

describe('Customer care demo team', () => {
    const folders = {
        customer: '/data/workspaces/customer-care-demo--customer',
        operations: '/data/workspaces/customer-care-demo--operations',
        policy: '/data/workspaces/customer-care-demo--policy'
    }

    it('passes the harness check and builds three specialists with the picked model key', async () => {
        const plan = customerCarePlan(folders)
        expect(harnessProblems(plan, ctx)).toEqual([])
        const built = await runBuilder(harnessRecipe, 'Try the demo', ctx, async () => JSON.stringify(plan))
        expect(built.ok ? [] : built.problems).toEqual([])
        if (!built.ok) return
        expect(built.repaired).toBe(false)
        expect(built.missingCredentials).toEqual([])
        expect(built.starterQuestions).toEqual(CUSTOMER_CARE_STARTERS)
        const byName = (name: string) => built.nodes.filter((node) => node.data.name === name)
        const specialists = byName('harnessSpecialist')
        const named = (name: string) => specialists.find((node) => node.data.inputs.specialistName === name)
        expect(specialists.map((node) => node.data.inputs.specialistName).sort()).toEqual(['customer', 'operations', 'policy'])
        // Each specialist has its own system: the support desk, the fulfillment systems, or the written policy.
        expect(named('customer').data.inputs.enableCodeExecution).toBe(true)
        expect(named('customer').data.inputs.instructions).toContain(`${folders.customer}/support.sqlite`)
        expect(named('customer').data.inputs.instructions).not.toContain('fulfillment')
        expect(named('operations').data.inputs.enableCodeExecution).toBe(true)
        expect(named('operations').data.inputs.instructions).toContain(`${folders.operations}/fulfillment.sqlite`)
        expect(named('operations').data.inputs.instructions).not.toContain('support')
        expect(named('policy').data.inputs.enableCodeExecution).toBe(true)
        expect(named('policy').data.inputs.instructions).toContain(
            `'${folders.policy}'); from policy_book import read_policy, remedy_table`
        )
        for (const name of ['customer', 'operations']) expect(named(name).data.inputs.instructions).not.toContain('policy_book')
        // Harness Prime sends policy after operations, so the policy judges the case from the operations finding.
        const prime = byName('harnessChief')[0]
        expect(prime.data.inputs.instructions).toContain('"after": "operations"')
        // Prime, three specialists and the model, all connected.
        expect(built.nodes).toHaveLength(5)
        expect(built.edges).toHaveLength(4)
    })

    it('makes the customer care team unless the request names the bakery', () => {
        expect(demoById(undefined).harness).toBe('customer-care-demo')
        expect(demoById('nope').harness).toBe('customer-care-demo')
        expect(demoById('__proto__').harness).toBe('customer-care-demo')
        expect(demoById('bakery').harness).toBe('bakery-demo')
        expect(demoById('bakery').starters).toEqual(DEMO_STARTERS)
        const config = JSON.parse(withDemoStarters(undefined, CUSTOMER_CARE_STARTERS))
        expect(Object.values(config.starterPrompts).map((entry: any) => entry.prompt)).toEqual(CUSTOMER_CARE_STARTERS)
    })

    it('ships every file the demos stage, and the pipeline sample a demo imports', () => {
        for (const demo of Object.values(DEMOS)) {
            for (const files of Object.values(demo.files))
                for (const file of files) expect(fs.existsSync(path.join(sampleDir(demo.dataDir), file))).toBe(true)
            if (!demo.pipelineSample) continue
            const sample = JSON.parse(
                fs.readFileSync(path.join(repoRoot, 'samples', 'etl', `${demo.pipelineSample}.pipeline.json`), 'utf8')
            )
            expect(sample.name).toBe(demo.pipelineName)
        }
        const policy = fs.readFileSync(path.join(sampleDir('customer-care'), 'service-policy.md'), 'utf8')
        for (const section of [
            '1.2 Larkfield fault',
            '1.3 Carrier fault',
            '2.3',
            '2.4',
            '2.5',
            '3.1 Repeat',
            '3.2 Refund',
            '3.3 Escalation'
        ])
            expect(policy).toContain(`### ${section}`)
        // remedy_table works from the same numbers as the policy tables.
        for (const row of [
            '| Standard | 10% of the item price',
            '| Plus     | 15% of the item price',
            '| Premier  | 20% of the item price'
        ])
            expect(policy).toContain(row)
        for (const row of ['| Standard | $10 ', '| Plus     | $15 ', '| Premier  | $25 ']) expect(policy).toContain(row)
        expect(policy).toContain('The credit is at most $75 per order.')
        expect(policy).toContain('with the credit cap raised to $100')
        const book = fs.readFileSync(path.join(sampleDir('customer-care'), 'policy_book.py'), 'utf8')
        expect(book).toContain("CREDIT_SHARE = {'Standard': 0.10, 'Plus': 0.15, 'Premier': 0.20}")
        expect(book).toContain('CREDIT_CAP = 75.0')
        expect(book).toContain('PREMIER_REPEAT_CAP = 100.0')
        expect(book).toContain("GOODWILL = {'Standard': 10.0, 'Plus': 15.0, 'Premier': 25.0}")
    })

    it("stages each specialist's own database and tools, and the tools tell the story the demo depends on", async () => {
        const { stageDemoFiles } = await import('./index')
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-care-demo-'))
        try {
            const staged: Record<string, string> = {}
            for (const [specialist, files] of Object.entries(DEMOS['customer-care'].files)) {
                staged[specialist] = path.join(root, specialist)
                await stageDemoFiles(staged[specialist], sampleDir('customer-care'), files)
                // Staging again replaces the files instead of failing.
                await stageDemoFiles(staged[specialist], sampleDir('customer-care'), files)
            }
            expect(fs.readdirSync(staged.customer).sort()).toEqual(['support.sqlite', 'support_desk.py'])
            expect(fs.readdirSync(staged.operations).sort()).toEqual(['fulfillment.py', 'fulfillment.sqlite'])
            expect(fs.readdirSync(staged.policy).sort()).toEqual(['policy_book.py', 'service-policy.md'])
            const python = (folder: string, code: string) => {
                const run = spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(folder)}); ${code}`], {
                    encoding: 'utf8'
                })
                expect(run.stderr).toBe('')
                return run.stdout
            }
            // The customer: Plus, with a late delivery 52 days before the complaint that already got a goodwill credit.
            const account = python(staged.customer, "from support_desk import account_snapshot; account_snapshot('LH-20417')")
            expect(account).toContain('Tier: Plus')
            expect(account).toContain('Credit given: $10.00 (goodwill)')
            expect(account).toContain(
                'Late deliveries in the 120 days before the complaint: LH-18802 (delivered 2026-08-15, 52 days before)'
            )
            // Operations: the parcel never left the warehouse, four other orders from the same wave are held, Reno can reship.
            const trace = python(staged.operations, "from fulfillment import investigate; investigate('LH-20417')")
            expect(trace).toContain('handed to carrier: never')
            expect(trace).toContain('it never received the parcel')
            expect(trace).toContain('Expected 9.8 kg, measured 4.1 kg')
            expect(trace).toContain('$279.00, shipping paid $9.95')
            expect(trace).toContain('RNO (Reno fulfillment center): 14 on hand, Express 2 business days, arrives 2026-10-08 (Thursday)')
            expect(trace).toContain('4 other orders held in the same packing wave (W-0929-B)')
            expect(python(staged.operations, 'from fulfillment import held_orders; held_orders()')).toContain(
                '5 orders held in CMH, packing wave W-0929-B'
            )
            // The second starter: a carrier delay after pickup, for contrast.
            const carrier = python(staged.operations, "from fulfillment import investigate; investigate('LH-20398')")
            expect(carrier).toContain('Picked up')
            expect(carrier).toContain('Delayed: road closure for snow')
            expect(carrier).not.toContain('never received')
            expect(carrier).toContain('No other order held in the same packing wave (W-0929-A).')
            // Policy: the rules the decision turns on, whole or one section at a time.
            const rules = python(staged.policy, "from policy_book import read_policy; read_policy('2.5'); read_policy('9.9')")
            expect(rules).toContain('an earlier goodwill credit never reduces it')
            expect(rules).toContain('The policy has no section 9.9.')
            expect(python(staged.policy, 'from policy_book import read_policy; read_policy()')).toContain('### 3.1 Repeat late delivery')
            // The remedy table: a Larkfield fault for a Plus customer with a repeat late delivery gets the Premier remedy.
            const remedy = python(staged.policy, "from policy_book import remedy_table; remedy_table('larkfield', 279, 9.95, 5)")
            expect(remedy).toContain('refund the shipping, $9.95 (2.1)')
            expect(remedy).toContain('recall the held parcel')
            expect(remedy).toContain('held 5 orders, more than 3, so open an operations incident naming the packing wave (3.3)')
            expect(remedy).toContain(
                '- Plus, another late delivery in 120 days: Premier remedy, raised one tier by 3.1: store credit $55.80 (20% of $279.00, 2.3); a call from the Customer Care Lead (2.3) and escalate to the Customer Care Lead (3.3).'
            )
            expect(remedy).toContain('- Plus, no other late delivery in 120 days: Plus remedy: store credit $41.85 (15% of $279.00, 2.3).')
            // A carrier fault instead: goodwill by tier, no Larkfield credit, and no incident.
            const goodwill = python(staged.policy, "from policy_book import remedy_table; remedy_table('carrier', 129, 9.95)")
            expect(goodwill).toContain('open a trace with the carrier today (2.2)')
            expect(goodwill).toContain(
                '- Standard, no other late delivery in 120 days: Standard remedy: goodwill credit $10.00 (2.4); no shipping refund (2.2).'
            )
            expect(goodwill).not.toContain('store credit')
            expect(goodwill).not.toContain('incident')
            // The cap: 20% of a large order stops at $75, or $100 for a Premier customer with a repeat late delivery.
            const capped = python(staged.policy, "from policy_book import remedy_table; remedy_table('larkfield', 900, 0)")
            expect(capped).toContain('store credit $75.00 (20% of $900.00, capped at $75.00, 2.3)')
            expect(capped).toContain('store credit $100.00 (20% of $900.00, capped at $100.00, 2.3)')
            // Each database holds only its own system's tables.
            const { DatabaseSync } = require('node:sqlite')
            const tables = (file: string) => {
                const db = new DatabaseSync(file)
                const names = db
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                    .all()
                    .map((row: any) => row.name)
                db.close()
                return names
            }
            expect(tables(path.join(staged.customer, 'support.sqlite'))).toEqual(['contacts', 'customers', 'orders'])
            expect(tables(path.join(staged.operations, 'fulfillment.sqlite'))).not.toContain('customers')
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    })
})
