import fs from 'fs'
import os from 'os'
import path from 'path'
import { runBuilder } from '../builder/core'
import { harnessProblems, harnessRecipe } from '../builder/recipes/harness'
import { realParts } from '../builder/testRealParts'
import { DEMO_STARTERS, demoCredentialNames, demoModelFor, demoPlan, withDemoStarters } from './plan'

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
            await stageBakery(folder, path.join(__dirname, '..', '..', '..', '..', '..', 'samples', 'demo', 'bakery'))
            expect(fs.readdirSync(folder).sort()).toEqual(['bakery.sqlite', 'bakery_chart.py'])
            const { DatabaseSync } = require('node:sqlite')
            const db = new DatabaseSync(path.join(folder, 'bakery.sqlite'))
            const row = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT week_start) AS weeks FROM weekly_sales').get()
            db.close()
            expect(row).toEqual(expect.objectContaining({ n: 416, weeks: 26 }))
            // Staging again replaces the files instead of failing.
            await stageBakery(folder, path.join(__dirname, '..', '..', '..', '..', '..', 'samples', 'demo', 'bakery'))
            expect(fs.readdirSync(folder).sort()).toEqual(['bakery.sqlite', 'bakery_chart.py'])
        } finally {
            fs.rmSync(folder, { recursive: true, force: true })
        }
    })
})
