import { Plan } from '../builder/plan'
import { PartDefinition } from '../builder/recipe'

// Try the demo: ready-made agent teams over made-up data. Everything they read is bundled with Cuttlely (samples/demo
// and the ETL samples), so the person only brings one model key. The customer care team is the main demo; the bakery
// is the gentle quickstart.
export type DemoId = 'customer-care' | 'bakery'

export interface DemoDefinition {
    id: DemoId
    // The harness name the demo saves, shared by every workspace.
    harness: string
    title: string
    // What the Try the demo card calls it ("the customer care team").
    noun: string
    // The ETL sample the demo imports and runs once, and the pipeline name that sample saves. Empty when the demo has
    // no pipeline.
    pipelineSample: string
    pipelineName: string
    starters: string[]
    // samples/demo/<dataDir>, and the files each specialist gets in its own folder. A .sql file is loaded into a SQLite
    // database of the same name; any other file is copied.
    dataDir: string
    files: Record<string, string[]>
    plan: (pipelineName: string, folders: Record<string, string>) => Plan
}

export const DEFAULT_DEMO: DemoId = 'customer-care'

// ---- Customer care: a late-order complaint resolved by three specialists and Harness Prime -------------------------

export const CUSTOMER_CARE_HARNESS = 'customer-care-demo'
export const CUSTOMER_CARE_TITLE = 'Customer care demo team'
export const CUSTOMER = 'customer'
export const OPERATIONS = 'operations'
export const POLICY = 'policy'

export const CUSTOMER_CARE_STARTERS = [
    'Maya Okafor wrote in on 6 Oct about order LH-20417: "My espresso machine was due Friday. Tracking hasn\'t moved in a week, and it\'s your second late order. I want a refund."',
    'Daniel Reyes wrote in on 6 Oct about order LH-20398: "My duvet set was due Saturday and it still isn\'t here. Where is it?"',
    'Which orders are held in a warehouse right now, and which of those customers are Plus or Premier?'
]

const CUSTOMER_CARE_PRIME = [
    'You resolve customer complaints for Larkfield Home, a made-up online home goods store. All of its data is made up for this demo.',
    'For a complaint about an order, send customer and operations at the same time, and send policy with "after": "operations", never after customer, so it judges the case from the scans and amounts operations found.',
    "Give each specialist the order number and the customer's words.",
    'For any other question, ask only the specialists it needs, and use "after" when one needs the result of another.',
    'For a complaint, answer in four parts with these bold headings: **Decision**: one line with whose fault it is and the remedy.',
    '**Reply to the customer**: a short, warm email that says plainly what happened, what we will do and by when, and offers every choice the policy gives.',
    '**Actions**: a checklist of everything the team does now, with amounts and dates: every step of the remedy the policy gives for this customer, including recalling or stopping a parcel, and every escalation and incident.',
    '**Evidence**: one line each for customer, operations and policy, with the facts each found and the policy section numbers.',
    "The policy specialist gives the steps for every customer and one line per customer case. Use every step for every customer, plus the one line that matches the customer's tier and whether the customer specialist found another late delivery in the 120 days before; say why that line applies, and use its amounts and every step in it exactly, such as a call or escalation to the Customer Care Lead.",
    'Use only facts, dates and amounts the specialists gave. Do not write email addresses or JSON in the answer.'
].join(' ')

export const customerInstructions = (folder: string) =>
    [
        'You are the customer specialist. You read only the Larkfield Home support desk. The store and its data are made up.',
        `Run Python with execute_code. Start your code with: import sys; sys.path.insert(0, '${folder}'); from support_desk import account_snapshot, query.`,
        'account_snapshot(order_id=None, email=None) prints the account behind an order number or an email: the tier, every order,',
        'every past contact with any credit given, and the late deliveries in the 120 days before the complaint.',
        `query(sql) returns (column names, rows) from ${folder}/support.sqlite. Tables: customers(id, name, email, tier, member_since,`,
        'city, state), orders(id, customer_id, placed_on, promised_by, delivered_on, status, total), contacts(id, customer_id,',
        'contacted_on, channel, order_id, reason, summary, credit, credit_type).',
        'Always run code and never guess. Only what your code prints comes back to you.',
        'Reply in short lines: the customer, tier and member since; orders and spend; each past contact with its date, what happened',
        'and any credit; and every late delivery in the 120 days before the complaint. Do not judge fault or remedies.'
    ].join(' ')

export const operationsInstructions = (folder: string) =>
    [
        "You are the operations specialist. You read only Larkfield Home's fulfillment systems: warehouse scans, carrier tracking,",
        'stock and transit times. The store and its data are made up.',
        `Run Python with execute_code. Start your code with: import sys; sys.path.insert(0, '${folder}'); from fulfillment import investigate, trace_order, stock, held_orders, query.`,
        'trace_order(order_id) prints the items, every warehouse scan, the shipment and every carrier scan.',
        'stock(sku, ship_to_state) prints the stock in each warehouse and when a reship sent today would arrive, by service.',
        'held_orders() prints every order held at a warehouse check, by packing wave.',
        `query(sql) returns (column names, rows) from ${folder}/fulfillment.sqlite. Tables: order_lines, warehouse_events,`,
        'shipments, carrier_events, inventory, transit, warehouses.',
        'investigate(order_id) prints all of that for one order in a single call: its journey, the reship dates for its items, and',
        'the other orders held in the same packing wave. For a complaint about an order, call investigate once.',
        'Always run code and never guess. Only what your code prints comes back to you.',
        'Reply in short lines: the cause of the delay in one sentence; the scans that prove it, with times; whether the carrier ever',
        'had the parcel; the item, its price and the shipping paid; other orders held for the same reason; and the fastest reship',
        '(warehouse, service, arrival date).'
    ].join(' ')

export const policyInstructions = (folder: string) =>
    [
        'You are the policy specialist. You read only the Larkfield Home Service Recovery Policy. The store and the policy are made up.',
        `Run Python with execute_code. Start your code with: import sys; sys.path.insert(0, '${folder}'); from policy_book import read_policy, remedy_table.`,
        'read_policy() prints the whole policy; read_policy("2.3") prints one section.',
        'remedy_table(fault, item_price, shipping_paid, orders_held) prints the remedy for every tier, with and without another late',
        'delivery in the last 120 days, worked out from the policy tables. fault is "larkfield", "carrier" or "customer"; orders_held',
        'counts this order and the other orders held by the same warehouse problem.',
        'The task includes what operations found. First run read_policy() and decide whose fault the delay is under part 1, from the',
        'warehouse and carrier scans. Then run remedy_table once with that fault and the numbers operations gave.',
        'If the task has no result from operations with the scans, the item price and the shipping paid, say so, give the part 1',
        'rules and the tables in 2.3 and 2.4, and do not run remedy_table or make up numbers.',
        'Reply with: the fault, the section and the scan that decide it; then everything remedy_table printed, copied exactly; then',
        'any other rule that applies (2.5, 3.2, 3.3, 3.4). You do not know the customer, so do not pick a line. Never work out amounts yourself.',
        'End with one line that starts with "Source: Service Recovery Policy, sections" and lists the sections you used.'
    ].join(' ')

export function customerCarePlan(folders: Record<string, string>): Plan {
    return {
        title: CUSTOMER_CARE_TITLE,
        nodes: [
            { id: 'prime', name: 'harnessChief', label: 'Harness Prime', instructions: CUSTOMER_CARE_PRIME },
            {
                id: 'customer',
                name: 'harnessSpecialist',
                label: 'Customer Specialist',
                instructions: customerInstructions(folders[CUSTOMER]),
                inputs: {
                    specialistName: CUSTOMER,
                    routingSummary: 'The account behind an order or email: tier, order history and past contacts, from the support desk',
                    enableCodeExecution: true
                }
            },
            {
                id: 'operations',
                name: 'harnessSpecialist',
                label: 'Operations Specialist',
                instructions: operationsInstructions(folders[OPERATIONS]),
                inputs: {
                    specialistName: OPERATIONS,
                    routingSummary: 'Where an order is and why: warehouse scans, carrier tracking, held orders, stock and reship dates',
                    enableCodeExecution: true
                }
            },
            {
                id: 'policy',
                name: 'harnessSpecialist',
                label: 'Policy Specialist',
                instructions: policyInstructions(folders[POLICY]),
                inputs: {
                    specialistName: POLICY,
                    routingSummary:
                        'Whose fault a delay is, and the remedy, credit, refund and escalation the written policy allows. Always runs after operations, because it needs the scans and amounts operations finds',
                    enableCodeExecution: true
                }
            }
        ],
        edges: [
            { from: 'customer', to: 'prime', input: 'specialists' },
            { from: 'operations', to: 'prime', input: 'specialists' },
            { from: 'policy', to: 'prime', input: 'specialists' }
        ],
        starterQuestions: CUSTOMER_CARE_STARTERS
    }
}

// ---- Bakery: the quickstart -----------------------------------------------------------------------------------------

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

// The bakery plan the builder materializes: Harness Prime, an analyst with code execution, and a librarian with the
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

export const DEMOS: Record<DemoId, DemoDefinition> = {
    'customer-care': {
        id: 'customer-care',
        harness: CUSTOMER_CARE_HARNESS,
        title: CUSTOMER_CARE_TITLE,
        noun: 'customer care team',
        pipelineSample: '',
        pipelineName: '',
        starters: CUSTOMER_CARE_STARTERS,
        dataDir: 'customer-care',
        files: {
            [CUSTOMER]: ['support.sql', 'support_desk.py'],
            [OPERATIONS]: ['fulfillment.sql', 'fulfillment.py'],
            [POLICY]: ['service-policy.md', 'policy_book.py']
        },
        plan: (_pipelineName, folders) => customerCarePlan(folders)
    },
    bakery: {
        id: 'bakery',
        harness: DEMO_HARNESS,
        title: DEMO_TITLE,
        noun: 'bakery team',
        pipelineSample: DEMO_PIPELINE_SAMPLE,
        pipelineName: 'Bakery Handbook',
        starters: DEMO_STARTERS,
        dataDir: 'bakery',
        files: { [ANALYST]: ['bakery.sql', 'bakery_chart.py'] },
        plan: (pipelineName, folders) => demoPlan(pipelineName, folders[ANALYST])
    }
}

// The demo a request names; an unknown or missing name is the main demo.
export function demoById(id: unknown): DemoDefinition {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DEMOS, id) ? DEMOS[id as DemoId] : DEMOS[DEFAULT_DEMO]
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
export function withDemoStarters(chatbotConfig: string | undefined, starters: string[] = DEMO_STARTERS): string {
    let config: Record<string, any> = {}
    try {
        config = chatbotConfig ? JSON.parse(chatbotConfig) : {}
    } catch {
        config = {}
    }
    return JSON.stringify({
        ...config,
        starterPrompts: Object.fromEntries(starters.map((prompt, index) => [String(index), { prompt }]))
    })
}
