#!/usr/bin/env node
// Real-model check for the analyst on the made-up demo databases (docs/how-to/analyst.md, "Real-model check").
//
//   psql -v ON_ERROR_STOP=1 -d bakery -f samples/demo/bakery/bakery-postgres.sql
//   psql -v ON_ERROR_STOP=1 -d budget -f samples/demo/budget/budget-postgres.sql
//   CUTTLELY_BAKERY_URL=postgresql://127.0.0.1:5432/bakery node scripts/analyst-real-model-check.mjs bakery
//   CUTTLELY_BAKERY_URL=... CUTTLELY_BUDGET_URL=postgresql://127.0.0.1:5432/budget \
//       node scripts/analyst-real-model-check.mjs two-analyst
//
// It calls the OpenAI chat API with OPENAI_API_KEY (model gpt-4.1 at temperature 0 unless CUTTLELY_CHECK_MODEL is set),
// so use it only on made-up data like these demo databases. OPENAI_BASE_URL points it at another compatible endpoint.
// A URL without a login uses PGUSER and PGPASSWORD.
//
// bakery: one analyst, five questions (four data questions and one about a table that is not ticked).
// two-analyst: the bakery analyst and a budget analyst in one harness; the routing prompt picks the analyst for each
// of nine questions, the same way Harness Prime does. Each answer is checked for the expected figure or name.
// Prints JSON with each answer, the tool calls, seconds per question and prompt tokens. Exits 1 when a check fails or a
// question errors; the report still prints.
import * as P from '../packages/harness/profile.mjs'
import * as R from '../packages/harness/run.mjs'
import * as S from '../packages/harness/runtime/analyst-store.mjs'

const MODEL = process.env.CUTTLELY_CHECK_MODEL || 'gpt-4.1'
const mode = process.argv[2]
if (!['bakery', 'two-analyst'].includes(mode)) {
    console.error('Usage: node scripts/analyst-real-model-check.mjs bakery|two-analyst')
    process.exit(2)
}
if (!process.env.OPENAI_API_KEY) {
    console.error('Set OPENAI_API_KEY.')
    process.exit(2)
}

const analyst = (name, summary, url, sel) => ({
    name,
    summary,
    url,
    sel,
    mcpServers: [{ nodeName: 'postgreSQLMCP', label: 'PostgreSQL MCP', inputs: { analystRelations: JSON.stringify(sel) } }]
})
const bakery = analyst(
    'Bakery Analyst',
    'Answers questions about the bakery chain: shop sales, products, stores, weekly revenue and wholesale account balances.',
    process.env.CUTTLELY_BAKERY_URL || 'postgresql://127.0.0.1:5432/bakery',
    [
        'public.monthly_sales',
        'public.top_products',
        'public.account_balances',
        'public.weekly_store_revenue',
        'public.wholesale_accounts',
        'public.stores'
    ]
)
const budget = analyst(
    'Budget Analyst',
    'Answers questions about the company budget: departments, planned budget lines, actual expenses and vendors.',
    process.env.CUTTLELY_BUDGET_URL || 'postgresql://127.0.0.1:5432/budget',
    ['public.departments', 'public.budget_lines', 'public.expenses', 'public.budget_vs_actual']
)

// [question, analyst that should answer, check]. The check is a pattern one answer must contain, or a function over
// every result. A null analyst means the question should go to every analyst.
const BAKERY = [
    ['Which month had the highest total sales, and how much?', bakery, /June[\s\S]*(?<![\d,])49,?557\.50?(?!\d)/i],
    ['What are the top 3 products by revenue?', bakery, /Sourdough Loaf[\s\S]*Seeded Rye[\s\S]*Lemon Tart/],
    ['Which wholesale account owes us the most right now, and how much?', bakery, /Hilltop Deli[\s\S]*(?<![\d,])600\.12(?!\d)/],
    ['Which store had the most revenue in the most recent week?', bakery, /Old Town[\s\S]*(?<![\d,])5,?976\.50?(?!\d)/],
    ['How many staff work at each store?', bakery, /\b(not|no|cannot|can't|don't|isn't|unable)\b/i]
]
const answered = (results, s, pattern) => results.some((r) => r.analyst === s.name && pattern.test(r.answer))
const TWO = [
    ['What are the top 3 products by revenue?', bakery, /Sourdough Loaf[\s\S]*Seeded Rye[\s\S]*Lemon Tart/],
    ['Which wholesale account owes us the most right now, and how much?', bakery, /Hilltop Deli[\s\S]*(?<![\d,])600\.12(?!\d)/],
    ['Which store had the most revenue in the most recent week?', bakery, /Old Town[\s\S]*(?<![\d,])5,?976\.50?(?!\d)/],
    ['Which department has used the largest share of its 2026 budget so far?', budget, /Engineering/],
    ['Which vendor have we paid the most, and how much?', budget, /SkyCloud[\s\S]*(?<![\d,])215,?000(?!\d)/],
    ['What is the total planned budget for fiscal 2026?', budget, /(?<![\d,])625,?000(?!\d)/],
    ['How much did we spend on software this year?', budget, /(?<![\d,])26,?000(?!\d)/],
    ['Analyst: what were total sales in June 2026?', bakery, /(?<![\d,])49,?557\.50?(?!\d)/],
    [
        'Analyst: list the tables you can see.',
        null,
        (results) => answered(results, bakery, /monthly_sales|account_balances/) && answered(results, budget, /budget_vs_actual/)
    ]
]

const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
const tokens = { route: 0, choose: 0, analyst: 0 }
async function chat(kind, body) {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: MODEL, temperature: 0, ...body }),
        signal: AbortSignal.timeout(120000)
    })
    if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`OpenAI chat API returned ${response.status}: ${text.slice(0, 300)}`)
    }
    const data = await response.json()
    if (data.error) throw new Error(data.error.message)
    tokens[kind] += data.usage?.prompt_tokens ?? 0
    return data.choices[0].message
}

const team = mode === 'bakery' ? [bakery] : [bakery, budget]
const analystCount = team.filter(P.hasAnalystTool).length
const line = (s) =>
    `- ${s.name}: ${P.specialistSummary(s, 'No instructions.')} Tools: PostgreSQL MCP.${analystCount > 1 ? P.analystTablesNote(s) : ''}`
const routeSystem = [
    'You route work for the "Company Data" harness.',
    'Specialists:',
    ...team.map(line),
    'Pick every specialist the request needs. Steps run at the same time, so write each task so it stands on its own.',
    R.ROUTE_AFTER,
    P.routerDialectNote(team),
    R.routeAnalystNote(team),
    R.ROUTE_WHOLE_TASK,
    R.ROUTE_FOLLOW_UP,
    'Reply with JSON only: {"steps":[{"specialist":"NAME","task":"...","after":""}]}. Leave "after" empty unless the step needs an earlier step\'s result. Use an empty list when no specialist is needed.'
]
    .filter(Boolean)
    .join('\n')

async function route(question) {
    const raw = (
        await chat('route', {
            messages: [
                { role: 'system', content: routeSystem },
                { role: 'user', content: question }
            ],
            response_format: { type: 'json_object' }
        })
    ).content
    let steps = R.forceAnalystRoute(question, R.parseSteps(raw, team, question), team)
    const choices = R.analystsToChoose(question, steps, team)
    if (choices.length) {
        const system = [
            `You choose the analyst for a database request in the "Company Data" harness.`,
            R.ROUTE_CHOOSE_ANALYST,
            'Analysts:',
            ...choices.map(line)
        ].join('\n')
        const reply = await chat('choose', {
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: question }
            ],
            response_format: { type: 'json_object' }
        })
        steps = R.parseAnalystChoice(reply.content, choices, question)
    }
    if (steps.length === 1) steps[0].task = R.expandSingleSpecialistTask(question, steps[0].task)
    return steps
}

async function runAnalyst(s, task) {
    const relations = await S.analystUrlRelations(s.url, s.sel)
    const q = S.analystUrlToolSpec(100, relations)
    const d = S.analystDescribeToolSpec()
    const tools = [
        { type: 'function', function: { name: 'query', description: q.description, parameters: q.schema } },
        { type: 'function', function: { name: 'describe', description: d.description, parameters: d.schema } }
    ]
    const system = [
        `You are ${s.name}. ${s.summary}`,
        'The analyst database is PostgreSQL. Write PostgreSQL only.',
        'This connection is read-only PostgreSQL. It cannot create or change tables.',
        P.SPECIALIST_REPAIR_ONCE,
        P.ANALYST_TOOL_REQUIRED,
        P.ANALYST_EMPTY_FILTER,
        P.ANALYST_RESULT_SHAPE,
        P.SPECIALIST_NO_INVENTION
    ].join('\n')
    const messages = [
        { role: 'system', content: system },
        { role: 'user', content: task }
    ]
    const calls = []
    for (let i = 0; i < 8; i++) {
        const message = await chat('analyst', { messages, tools })
        messages.push(message)
        if (!message.tool_calls) return { analyst: s.name, calls, answer: message.content || '' }
        for (const call of message.tool_calls) {
            let args = {}
            let result
            try {
                args = JSON.parse(call.function.arguments)
                result =
                    call.function.name === 'describe'
                        ? await S.describeAnalystUrlRelation(s.url, args, s.sel)
                        : await S.queryAnalystUrl(s.url, args, { relations: s.sel, scope: 'check' })
            } catch (error) {
                result = { error: error.message }
            }
            const text = JSON.stringify(result)
            calls.push(`${call.function.name}: ${args.sql || args.name || ''}`)
            messages.push({ role: 'tool', tool_call_id: call.id, content: text.slice(0, 12000) })
        }
    }
    return { analyst: s.name, calls, answer: '(no answer after 8 turns)' }
}

const out = { model: MODEL, mode, questions: [] }
let passed = 0
const list = mode === 'bakery' ? BAKERY : TWO
for (const [question, expected, check] of list) {
    const started = Date.now()
    try {
        const steps = mode === 'bakery' ? [{ specialist: bakery, task: question }] : await route(question)
        const results = []
        for (const step of steps) results.push(await runAnalyst(step.specialist, step.task))
        const routedTo = steps.map((step) => step.specialist.name)
        const routedOk = expected ? routedTo.length === 1 && routedTo[0] === expected.name : routedTo.length === team.length
        const answerOk = typeof check === 'function' ? check(results) : results.some((r) => check.test(r.answer))
        const ok = routedOk && answerOk
        if (ok) passed++
        out.questions.push({ question, ok, routedTo, seconds: (Date.now() - started) / 1000, results })
    } catch (error) {
        out.questions.push({ question, ok: false, error: error.message, seconds: (Date.now() - started) / 1000 })
    }
}
out.score = `${passed}/${list.length}`
out.promptTokens = tokens
console.log(JSON.stringify(out, null, 1))
process.exit(passed === list.length ? 0 : 1)
