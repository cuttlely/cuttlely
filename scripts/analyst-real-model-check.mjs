#!/usr/bin/env node
// Real-model check for the analyst on the made-up demo databases (docs/how-to/analyst.md, "Real-model check").
//
//   psql -v ON_ERROR_STOP=1 -d bakery -f samples/demo/bakery/bakery-postgres.sql
//   psql -v ON_ERROR_STOP=1 -d budget -f samples/demo/budget/budget-postgres.sql
//   CUTTLELY_BAKERY_URL=postgresql://127.0.0.1:5432/bakery node scripts/analyst-real-model-check.mjs bakery
//   CUTTLELY_BAKERY_URL=... CUTTLELY_BUDGET_URL=postgresql://127.0.0.1:5432/budget \
//       node scripts/analyst-real-model-check.mjs two-analyst
//   CUTTLELY_BAKERY_URL=... node scripts/analyst-real-model-check.mjs rules
//
// It calls the OpenAI chat API with OPENAI_API_KEY (model gpt-4.1 at temperature 0 unless CUTTLELY_CHECK_MODEL is set),
// so use it only on made-up data like these demo databases. OPENAI_BASE_URL points it at another compatible endpoint.
// A reasoning model gets a reasoning effort instead of a temperature: none for gpt-5.1 and later, minimal for gpt-5,
// gpt-5-mini and gpt-5-nano, and low for an o-series model. gpt-5-chat-latest gets neither. CUTTLELY_CHECK_REASONING_EFFORT
// sets that effort, and sends it in place of the temperature for any model.
// A URL without a login uses PGUSER and PGPASSWORD.
//
// bakery: one analyst, five questions (four data questions and one about a table that is not ticked).
// two-analyst: the bakery analyst and a budget analyst in one harness; the routing prompt picks the analyst for each
// of nine questions, the same way Harness Prime does. Each answer is checked for the expected figure or name.
// rules: the bakery analyst with Rules set, three questions, each checked for the figure and for the rules it follows.
// Prints JSON with each answer, the tool calls, seconds per question and prompt tokens. Exits 1 when a check fails or a
// question errors; the report still prints.
import * as P from '../packages/harness/profile.mjs'
import * as R from '../packages/harness/run.mjs'
import * as S from '../packages/harness/runtime/analyst-store.mjs'

const MODEL = process.env.CUTTLELY_CHECK_MODEL || 'gpt-4.1'
const mode = process.argv[2]
if (!['bakery', 'two-analyst', 'rules'].includes(mode)) {
    console.error('Usage: node scripts/analyst-real-model-check.mjs bakery|two-analyst|rules')
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
const dollarFigures = (text) => [...text.matchAll(/\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/g)].map((m) => m[1])
// For a "which X" question that does not ask for an amount: the answer must name X, and any dollar figure it gives
// must be one of the given figures.
const named =
    (name, ...figures) =>
    (results) =>
        results.some((r) => name.test(r.answer) && dollarFigures(r.answer).every((f) => figures.some((re) => re.test(f))))
const OLD_TOWN = named(/Old Town/, /^5,?976\.50?$/)
// Engineering's 2026 plan, spend so far and what is left.
const ENGINEERING = named(/Engineering/, /^260,?000(\.00?)?$/, /^237,?000(\.00?)?$/, /^23,?000(\.00?)?$/)
const BAKERY = [
    ['Which month had the highest total sales, and how much?', bakery, /June[\s\S]*(?<![\d,])49,?557\.50?(?!,?\d)/i],
    ['What are the top 3 products by revenue?', bakery, /Sourdough Loaf[\s\S]*Seeded Rye[\s\S]*Lemon Tart/],
    ['Which wholesale account owes us the most right now, and how much?', bakery, /Hilltop Deli[\s\S]*(?<![\d,])600\.12(?!\d)/],
    ['Which store had the most revenue in the most recent week?', bakery, OLD_TOWN],
    ['How many staff work at each store?', bakery, /\b(not|no|cannot|can't|don't|isn't|unable)\b/i]
]
// rules: the bakery analyst with the five rules from docs/how-to/analyst.md, "Write your own rules", in its Rules box.
// Each answer must have the right figure and follow the rules a model does not meet on its own: a describe before
// the first query on each view, and every dollar figure with two decimals. CUTTLELY_CHECK_RULES=off runs the same
// questions with an empty box, for comparison.
const BAKERY_RULES = [
    'Use account_balances for what a wholesale account owes, monthly_sales for sales by month, and weekly_store_revenue for a shop by week.',
    'A question that names an account code such as WA-1004 is about that account. Look up its account_id in wholesale_accounts first when the view needs the id.',
    'Shop and store mean the same thing. Write shop names as stores has them, for example Old Town.',
    'Round money to two decimals.',
    'Before your first query on any view, call describe on it. Never query a view you have not described in this conversation.'
].join('\n')
const VIEWS = ['monthly_sales', 'top_products', 'account_balances', 'weekly_store_revenue']
const twoDecimals = (r) => dollarFigures(r.answer).length > 0 && dollarFigures(r.answer).every((f) => /\.\d{2}$/.test(f))
const describedFirst = (r) =>
    VIEWS.every((view) => {
        const firstQuery = r.calls.findIndex((c) => c.startsWith('query:') && new RegExp(`\\b${view}\\b`, 'i').test(c))
        return firstQuery < 0 || r.calls.slice(0, firstQuery).some((c) => c === `describe: ${view}` || c === `describe: public.${view}`)
    })
const ruled =
    (...checks) =>
    (results) =>
        results.some((r) => checks.every((c) => c(r)))
const says = (pattern) => (r) => pattern.test(r.answer)
const RULES = [
    [
        'Which shop made the most in the most recent week?',
        bakery,
        ruled(says(/Old Town/), says(/5,?976\.50(?!\d)/), twoDecimals, describedFirst)
    ],
    ['What were total sales in June 2026?', bakery, ruled(says(/49,?557\.50(?!\d)/), twoDecimals, describedFirst)],
    ['How much does WA-1004 owe us?', bakery, ruled(says(/Hilltop Deli/), says(/(?<![\d,])600\.12(?!\d)/), twoDecimals, describedFirst)]
]
if (mode === 'rules' && process.env.CUTTLELY_CHECK_RULES !== 'off') bakery.mcpServers[0].inputs.analystRules = BAKERY_RULES

const answered = (results, s, pattern) => results.some((r) => r.analyst === s.name && pattern.test(r.answer))
const TWO = [
    ['What are the top 3 products by revenue?', bakery, /Sourdough Loaf[\s\S]*Seeded Rye[\s\S]*Lemon Tart/],
    ['Which wholesale account owes us the most right now, and how much?', bakery, /Hilltop Deli[\s\S]*(?<![\d,])600\.12(?!\d)/],
    ['Which store had the most revenue in the most recent week?', bakery, OLD_TOWN],
    ['Which department has used the largest share of its 2026 budget so far?', budget, ENGINEERING],
    ['Which vendor have we paid the most, and how much?', budget, /SkyCloud[\s\S]*(?<![\d,])215,?000(?!,?\d)/],
    ['What is the total planned budget for fiscal 2026?', budget, /(?<![\d,])625,?000(?!,?\d)/],
    ['How much did we spend on software this year?', budget, /(?<![\d,])26,?000(?!,?\d)/],
    ['Analyst: what were total sales in June 2026?', bakery, /(?<![\d,])49,?557\.50?(?!,?\d)/],
    [
        'Analyst: list the tables you can see.',
        null,
        (results) => answered(results, bakery, /monthly_sales|account_balances/) && answered(results, budget, /budget_vs_actual/)
    ]
]

const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
// Reasoning models refuse temperature 0, and each family accepts a different lowest effort. gpt-5-chat-latest takes
// neither a temperature nor a reasoning effort. Returns undefined for a model that takes temperature 0.
function defaultEffort(model) {
    if (/^gpt-5-chat/i.test(model)) return null
    const gpt = /^gpt-(\d+)(?:\.(\d+))?/i.exec(model)
    if (gpt && (Number(gpt[1]) > 5 || (Number(gpt[1]) === 5 && Number(gpt[2] ?? 0) >= 1))) return 'none'
    if (gpt && Number(gpt[1]) === 5) return 'minimal'
    if (/^o\d/i.test(model)) return 'low'
    return undefined
}
const REASONING_EFFORT = process.env.CUTTLELY_CHECK_REASONING_EFFORT || defaultEffort(MODEL)
const SAMPLING = REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : REASONING_EFFORT === null ? {} : { temperature: 0 }
const tokens = { route: 0, choose: 0, analyst: 0 }
async function chat(kind, body) {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: MODEL, ...SAMPLING, ...body }),
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

const team = mode === 'two-analyst' ? [bakery, budget] : [bakery]
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
        ...P.analystRulesSection(s),
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

const out = {
    model: MODEL,
    ...SAMPLING,
    mode,
    ...(mode === 'rules' ? { rules: P.analystRules(bakery) ? 'on' : 'off' } : {}),
    questions: []
}
let passed = 0
const list = { bakery: BAKERY, 'two-analyst': TWO, rules: RULES }[mode]
for (const [question, expected, check] of list) {
    const started = Date.now()
    try {
        const steps = mode === 'two-analyst' ? await route(question) : [{ specialist: bakery, task: question }]
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
