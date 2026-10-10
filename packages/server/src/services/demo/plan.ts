import { Plan } from '../builder/plan'
import { PartDefinition } from '../builder/recipe'

// Try the demo: a ready-made agent team over a made-up bakery. Everything it reads is bundled with Cuttlely
// (samples/demo/bakery and the Bakery Handbook ETL sample), so the person only brings one model key.
export const DEMO_HARNESS = 'bakery-demo'
export const DEMO_TITLE = 'Bakery demo team'
export const DEMO_PIPELINE_SAMPLE = 'bakery-handbook'
export const ANALYST = 'analyst'

export const DEMO_STARTERS = [
    'Which products brought in the most revenue from January to June? Show it as a bar chart.',
    'What are the opening hours of the Old Town shop, and which items contain nuts?',
    'Which shop sold more croissants in March 2026, and by how many?'
]

const PRIME_INSTRUCTIONS = [
    'You run the back office of a small bakery with two shops, Riverside and Old Town. All of its data is made up for this demo.',
    'Send questions about sales, revenue, units, trends or charts to the analyst.',
    'Send questions about the shops, opening hours, allergens, ingredients, offers or staff routines to the librarian.',
    'When a question needs both, ask both. Answer briefly, in plain words, with the numbers the analyst found.',
    'When the analyst made a chart, say so in one line. The chart shows in the chat by itself, so never write an image link or a file name.'
].join(' ')

export const analystInstructions = (folder: string) =>
    [
        "You answer questions about the bakery's sales with Python (execute_code) on a SQLite database. The data is made up.",
        `The database is ${folder}/bakery.sqlite. Tables: products(id, name, category, price), stores(id, name, address),`,
        "weekly_sales(week_start TEXT as 'YYYY-MM-DD', the Monday of the week; store_id; product_id; units; revenue).",
        'Weeks run from 2026-01-05 to 2026-06-29.',
        `Start your code with: import sys; sys.path.insert(0, '${folder}'); from bakery_chart import query, bar_chart.`,
        'query(sql) returns (column names, rows). bar_chart(sql, out_path, title, value_label) draws the first two columns of',
        'the query as bars, in the query order, and saves a PNG.',
        'Always run a query and never guess a number. Only what your code prints comes back to you, so print the rows you need.',
        'When the task asks for a chart or a graph, call bar_chart and save the PNG in the image folder your task names.',
        'Reply with the key numbers and one line that says what the chart shows, without an image link or a file path.'
    ].join(' ')

const LIBRARIAN_INSTRUCTIONS = [
    'Search the bakery handbook with your search tool for every task, with a short query built from the task.',
    'Answer only from the passages it returns and name the handbook page each fact came from.',
    'If the handbook does not say, reply that the handbook has no information about that.'
].join(' ')

// The plan the builder materializes: Harness Prime, an analyst with code execution, and a librarian with the
// handbook search tool. The builder adds the person's chat model above Harness Prime.
export function demoPlan(pipelineName: string, analystFolder: string): Plan {
    return {
        title: DEMO_TITLE,
        nodes: [
            { id: 'prime', name: 'harnessChief', label: 'Harness Prime', instructions: PRIME_INSTRUCTIONS },
            {
                id: 'analyst',
                name: 'harnessSpecialist',
                label: 'Sales Analyst',
                instructions: analystInstructions(analystFolder),
                inputs: {
                    specialistName: ANALYST,
                    routingSummary: 'Sales numbers, trends and bar charts from the bakery database',
                    enableCodeExecution: true
                }
            },
            {
                id: 'librarian',
                name: 'harnessSpecialist',
                label: 'Handbook Librarian',
                instructions: LIBRARIAN_INSTRUCTIONS,
                inputs: {
                    specialistName: 'librarian',
                    routingSummary: 'Shops, opening hours, allergens, offers and staff routines from the bakery handbook'
                }
            },
            {
                id: 'handbook',
                name: 'etlRetriever',
                label: 'Bakery Handbook',
                inputs: {
                    pipeline: pipelineName,
                    topK: 4,
                    toolName: 'search_bakery_handbook',
                    toolDescription:
                        'Searches the made-up bakery handbook: shops, opening hours, allergens, ingredients, offers and staff routines.'
                }
            }
        ],
        edges: [
            { from: 'analyst', to: 'prime', input: 'specialists' },
            { from: 'librarian', to: 'prime', input: 'specialists' },
            { from: 'handbook', to: 'librarian', input: 'attached' }
        ],
        starterQuestions: DEMO_STARTERS
    }
}

// A small, quick model where we know one; otherwise the model the card itself defaults to.
const PREFERRED: Array<[string, string | undefined]> = [
    ['chatOpenAI', 'gpt-4.1-mini'],
    ['chatAnthropic', 'claude-haiku-4-5'],
    ['chatXAI', 'grok-4.7'],
    ['chatGoogleGenerativeAI', 'gemini-2.5-flash'],
    ['chatMistralAI', undefined],
    ['groqChat', 'llama-3.3-70b-versatile'],
    ['chatDeepseek', 'deepseek-flash'],
    ['chatOpenRouter', undefined]
]

const credentialNamesOf = (part: PartDefinition | undefined): string[] => {
    const names = part?.credential?.credentialNames
    return Array.isArray(names) ? names : []
}

const defaultModelName = (part: PartDefinition): string | undefined => {
    const input = (part.inputs || []).find((item) => item.name === 'modelName')
    return typeof input?.default === 'string' && input.default ? input.default : undefined
}

// The chat model card for a credential type ("openAIApi"): the first preferred card that takes it, else any chat
// model card that takes it. Undefined when no chat model uses that credential.
export function demoModelFor(
    credentialName: string,
    componentNodes: Record<string, PartDefinition>
): { name: string; modelName?: string } | undefined {
    for (const [name, modelName] of PREFERRED) {
        const part = componentNodes[name]
        if (part && credentialNamesOf(part).includes(credentialName)) return { name, modelName: modelName || defaultModelName(part) }
    }
    const any = Object.values(componentNodes).find(
        (part) =>
            part.category === 'Chat Models' &&
            !/deprecat/i.test(String(part.badge || '')) &&
            credentialNamesOf(part).includes(credentialName)
    )
    return any ? { name: any.name, modelName: defaultModelName(any) } : undefined
}

// Credential types the demo can run on, for the picker.
export function demoCredentialNames(componentNodes: Record<string, PartDefinition>): string[] {
    const names = new Set<string>()
    for (const part of Object.values(componentNodes))
        if (part.category === 'Chat Models' && !/deprecat/i.test(String(part.badge || '')))
            for (const name of credentialNamesOf(part)) names.add(name)
    return [...names].sort()
}

// Starter questions in the chat settings shape the chat window reads.
export function withDemoStarters(chatbotConfig: string | undefined): string {
    let config: Record<string, any> = {}
    try {
        config = chatbotConfig ? JSON.parse(chatbotConfig) : {}
    } catch {
        config = {}
    }
    return JSON.stringify({
        ...config,
        starterPrompts: Object.fromEntries(DEMO_STARTERS.map((prompt, index) => [String(index), { prompt }]))
    })
}
