import {
    BUILD_PROMPTS,
    buildProblemsText,
    canvasIsEmpty,
    missingCredentialsText,
    modelToRemember,
    recallModel,
    rememberModel,
    withStarterQuestions,
    starterQuestionsOf
} from './buildWithAI'

const memory = () => {
    const store = {}
    return { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = v), store }
}

describe('Build with AI', () => {
    test('uses one prompt line per canvas', () => {
        expect(BUILD_PROMPTS).toEqual({
            workflow: 'Describe your workflow',
            harness: 'Describe your team',
            etl: 'Describe your data',
            chat: 'Describe your assistant'
        })
    })

    test('remembers the building model by name and credential id, and forgets nothing else', () => {
        const storage = memory()
        expect(recallModel(storage)).toBeNull()
        rememberModel({ name: 'chatOpenAI', credential: 'c1', inputs: { modelName: 'gpt-4.1-mini' }, inputParams: [{}] }, storage)
        expect(recallModel(storage)).toEqual({
            name: 'chatOpenAI',
            credential: 'c1',
            inputs: { modelName: 'gpt-4.1-mini', FLOWISE_CREDENTIAL_ID: 'c1' }
        })
        expect(modelToRemember({})).toBeNull()
        storage.setItem('cuttlely.builderModel', 'not json')
        expect(recallModel(storage)).toBeNull()
    })

    test('treats a canvas with only the Start card as empty', () => {
        expect(canvasIsEmpty([])).toBe(true)
        expect(canvasIsEmpty([{ data: { name: 'startAgentflow' } }], [])).toBe(true)
        expect(canvasIsEmpty([{ data: { name: 'startAgentflow' } }, { data: { name: 'llmAgentflow' } }], [])).toBe(false)
    })

    test('adds starter questions only when the flow has none', () => {
        expect(JSON.parse(withStarterQuestions(undefined, ['One?', ' Two? ', '']))).toEqual({
            starterPrompts: { 0: { prompt: 'One?' }, 1: { prompt: 'Two?' } }
        })
        expect(JSON.parse(withStarterQuestions('{"botMessage":"hi"}', ['One?']))).toEqual({
            botMessage: 'hi',
            starterPrompts: { 0: { prompt: 'One?' } }
        })
        expect(withStarterQuestions('{"starterPrompts":{"0":{"prompt":"Mine"}}}', ['One?'])).toBeNull()
        expect(withStarterQuestions(undefined, [])).toBeNull()
    })

    test('reads the starter questions back from the chat settings', () => {
        expect(starterQuestionsOf(withStarterQuestions(undefined, ['Tents?', 'Stoves?']))).toEqual(['Tents?', 'Stoves?'])
        expect(starterQuestionsOf({ starterPrompts: { 0: { prompt: ' Bags? ' }, 1: { prompt: '' } } })).toEqual(['Bags?'])
        expect(starterQuestionsOf('not json')).toEqual([])
        expect(starterQuestionsOf(undefined)).toEqual([])
    })

    test('says what is missing and why a build failed in plain words', () => {
        expect(missingCredentialsText([])).toBe('')
        expect(missingCredentialsText([{ part: 'Researcher: Serp API', credential: 'Serp API' }])).toBe(
            'Add on the Credentials page, then pick on the card: Researcher: Serp API needs Serp API.'
        )
        expect(buildProblemsText('workflow', ['A.', 'B.'])).toBe('It could not build a workflow that passes the check. The problems: A. B.')
    })
})

describe('Start a new one', () => {
    test('hands the cards over like a duplicate and the rest beside them, once', () => {
        const store = {}
        const storage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = v), removeItem: (k) => delete store[k] }
        const { stashNewCanvas, takeLanding } = jest.requireActual('./buildWithAI')
        stashNewCanvas(
            { title: 'Researcher', nodes: [{ id: 'a' }], edges: [], starterQuestions: ['One?'], missingCredentials: [] },
            storage
        )
        expect(JSON.parse(store.duplicatedFlowData)).toEqual({
            cuttlelyMigration: true,
            name: 'Researcher',
            flow: { nodes: [{ id: 'a' }], edges: [] }
        })
        expect(takeLanding(storage)).toEqual({ title: 'Researcher', starterQuestions: ['One?'], missingCredentials: [] })
        expect(takeLanding(storage)).toBeNull()
    })
})

describe('A built harness', () => {
    const { harnessNameFrom, asSavedCards, noteSavedBuild, takeSavedBuild } = jest.requireActual('./buildWithAI')

    test('gets a name the server accepts, clear of names already taken', () => {
        expect(harnessNameFrom('Lumen Support Team')).toBe('Lumen-Support-Team')
        expect(harnessNameFrom('3 Writers: draft & edit!')).toBe('Writers-draft-edit')
        expect(harnessNameFrom('')).toBe('team')
        expect(harnessNameFrom('Study Team', ['study-team', 'Study-Team-2'])).toBe('Study-Team-3')
        expect(harnessNameFrom('x'.repeat(90))).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
    })

    test('saves card credentials where the canvas keeps them', () => {
        const [card] = asSavedCards([{ id: 'm', data: { inputs: { FLOWISE_CREDENTIAL_ID: 'cred-1', modelName: 'gpt' }, selected: true } }])
        expect(card.data).toEqual({ inputs: { modelName: 'gpt' }, credential: 'cred-1', selected: false })
    })

    test('carries its note to its own canvas once', () => {
        const store = {}
        const storage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = v), removeItem: (k) => delete store[k] }
        noteSavedBuild('id-1', { title: 'Study-Team', missingCredentials: [{ part: 'Serp API', credential: 'Serp Api' }] }, storage)
        expect(takeSavedBuild('id-2', storage)).toBeNull()
        expect(takeSavedBuild('id-1', storage)).toEqual({
            id: 'id-1',
            title: 'Study-Team',
            missingCredentials: [{ part: 'Serp API', credential: 'Serp Api' }]
        })
        expect(takeSavedBuild('id-1', storage)).toBeNull()
    })
})

describe('A built canvas in the new look', () => {
    const { compactForNewLook, compactCardHeight } = jest.requireActual('./buildWithAI')
    const card = (id, x, y, anchors = 1) => ({
        id,
        position: { x, y },
        data: { inputAnchors: Array.from({ length: anchors }, (_, i) => ({ name: `a${i}` })), outputAnchors: [{ name: 'out' }] }
    })

    test('presses the layout together and keeps every card clear of the next in its column', () => {
        const nodes = [card('s1', 0, 0), card('s2', 0, 900), card('prime', 400, 450), card('tool', -400, 0)]
        const packed = compactForNewLook(nodes)
        const at = Object.fromEntries(packed.map((n) => [n.id, n.position.y]))
        expect(at.s2).toBeLessThan(900)
        expect(at.s2 - at.s1).toBeGreaterThanOrEqual(compactCardHeight(nodes[0].data) + 48)
        expect(at.prime).toBe(Math.round(at.s2 / 2))
        expect(at.tool).toBe(at.s1)
        expect(packed.map((n) => n.position.x)).toEqual([0, 0, 400, -400])
    })

    test('never spreads a layout that is already tight', () => {
        const nodes = [card('a', 0, 0, 6), card('b', 0, 120)]
        expect(compactForNewLook(nodes).map((n) => n.position.y)).toEqual([0, 120])
    })
})

describe('A built pipeline', () => {
    const { pipelineNameFrom, BUILD_EXAMPLES, BUILD_PROMPTS } = jest.requireActual('./buildWithAI')

    test('keeps its title as its name and gets a number when the title is taken', () => {
        expect(pipelineNameFrom('Outdoor catalog search')).toBe('Outdoor catalog search')
        expect(pipelineNameFrom('Outdoor catalog search', ['outdoor catalog search', 'Outdoor catalog search 2'])).toBe(
            'Outdoor catalog search 3'
        )
        expect(pipelineNameFrom('  ')).toBe('Built pipeline')
    })

    test('asks to describe the data and offers examples', () => {
        expect(BUILD_PROMPTS.etl).toBe('Describe your data')
        expect(BUILD_EXAMPLES.etl.length).toBeGreaterThan(0)
    })
})

describe('A built chatflow', () => {
    const { BUILD_EXAMPLES, BUILD_PROMPTS } = jest.requireActual('./buildWithAI')

    test('asks to describe the assistant and offers examples', () => {
        expect(BUILD_PROMPTS.chat).toBe('Describe your assistant')
        expect(BUILD_EXAMPLES.chat).toHaveLength(3)
    })
})
