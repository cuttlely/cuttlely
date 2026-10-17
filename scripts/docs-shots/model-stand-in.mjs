// Local chat-completions stand-in for the docs screenshot script.
// It speaks the OpenAI chat API on 127.0.0.1 only. It does not call any other host.
// A real OPENAI_API_KEY in the environment is used instead of this process.
import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'

const PORT = Number(process.env.DOCS_SHOTS_MODEL_PORT || 8791)
const HOLD_FILE = process.env.DOCS_SHOTS_HOLD_FILE || '/tmp/docs-shots/hold'
const LOG = process.env.DOCS_SHOTS_MODEL_LOG || '/tmp/docs-shots/model.log'

const log = (line) => {
    fs.mkdirSync('/tmp/docs-shots', { recursive: true })
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
}

const textOf = (content) => {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map((part) => textOf(part)).join('\n')
    if (content && typeof content === 'object') return textOf(content.text || content.content || '')
    return ''
}

const systemText = (messages) =>
    messages
        .filter((m) => m.role === 'system')
        .map((m) => textOf(m.content))
        .join('\n')

const lastUser = (messages) => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user') return textOf(messages[i].content)
    }
    return ''
}

const toolResultsSinceUser = (messages) => {
    let start = 0
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user') {
            start = i + 1
            break
        }
    }
    return messages.slice(start).filter((m) => m.role === 'tool' || m.role === 'function')
}

const toolNames = (tools) => (Array.isArray(tools) ? tools.map((t) => t?.function?.name || t?.name).filter(Boolean) : [])

const queryToolName = (names) => names.find((name) => /query/i.test(name) && !/execute_sql/i.test(name)) || ''

const describeToolName = (names) => names.find((name) => /describe$/i.test(name) && name !== 'tool_describe') || ''

const otherTool = (names) => names.find((name) => name !== queryToolName(names) && !/execute_sql/i.test(name)) || ''

function splitSql(text) {
    const src = String(text || '')
    const starts = []
    const re = /\b(WITH\s+RECURSIVE|WITH|DROP|CREATE|INSERT|UPDATE|DELETE|SELECT|ALTER|VACUUM|PRAGMA)\b/gi
    let match
    while ((match = re.exec(src))) starts.push(match.index)
    if (!starts.length) return []
    const chunks = []
    for (let i = 0; i < starts.length; i += 1) {
        const end = i + 1 < starts.length ? starts[i + 1] : src.length
        let sql = src
            .slice(starts[i], end)
            .trim()
            .replace(/[;\s]+$/g, '')
        sql = sql
            .replace(/\s+and show all rows\.?$/i, '')
            .replace(/\s+then\s*$/i, '')
            .trim()
        if (sql) chunks.push(sql)
    }
    return chunks
}

function actionsFor(task) {
    if (/WA-1004/i.test(task) && /unpaid invoices/i.test(task)) {
        return [
            { kind: 'describe', name: 'public.account_balances' },
            { kind: 'sql', sql: `SELECT account_code, name, unpaid_invoices FROM account_balances WHERE account_code = 'WA-1004'` }
        ]
    }
    const cursorCall = task.match(/Call the query tool with cursor\s+(\S+?)(?:\s+and page\s+(\d+))?\./i)
    if (cursorCall) {
        const action = { kind: 'sql', sql: '', cursor: cursorCall[1].replace(/[.,]$/, '') }
        if (cursorCall[2]) action.page = Number(cursorCall[2])
        return [action]
    }
    if (/VACUUM/i.test(task)) return [{ kind: 'sql', sql: `VACUUM INTO '/tmp/docs-shots/not-a-file.db'` }]
    if (/tasks table/i.test(task) && /draft agenda/i.test(task)) {
        return [
            { kind: 'sql', sql: `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT)` },
            {
                kind: 'sql',
                sql: `INSERT INTO tasks (title, status) VALUES ('draft agenda', 'open'), ('book room', 'done'), ('send invites', 'open')`
            },
            { kind: 'sql', sql: `SELECT id, title, status FROM tasks WHERE status = 'open' ORDER BY id` }
        ]
    }
    if (/sales table/i.test(task) && /units/i.test(task)) {
        return [
            { kind: 'sql', sql: `DROP TABLE IF EXISTS sales` },
            { kind: 'sql', sql: `CREATE TABLE sales (id INTEGER PRIMARY KEY, region TEXT, units INTEGER)` },
            { kind: 'sql', sql: `INSERT INTO sales (region, units) VALUES ('west', 10), ('east', 20), ('west', 5)` },
            { kind: 'sql', sql: `SELECT region, SUM(units) AS units FROM sales GROUP BY region ORDER BY region` },
            { kind: 'sql', sql: `UPDATE sales SET units = units + 10 WHERE region = 'west'` },
            { kind: 'sql', sql: `SELECT id, region, units FROM sales ORDER BY id` }
        ]
    }
    if (/tmp_targets/i.test(task) && /demo_orders/i.test(task)) {
        return [
            { kind: 'sql', sql: `CREATE TEMP TABLE tmp_targets (item TEXT, target INTEGER)` },
            {
                kind: 'sql',
                sql: `INSERT INTO tmp_targets (item, target) VALUES ('apple tart', 900), ('lemon cake', 400), ('rye loaf', 300)`
            },
            {
                kind: 'sql',
                sql: `SELECT o.item, SUM(o.qty) AS ordered, t.target FROM demo_orders o JOIN tmp_targets t ON t.item = o.item GROUP BY o.item, t.target ORDER BY o.item`
            }
        ]
    }
    if (/tmp_targets/i.test(task)) return [{ kind: 'sql', sql: `SELECT * FROM tmp_targets` }]
    if (/count\(\*\)\s+AS\s+n\s+FROM\s+demo_orders/i.test(task) || (/demo_orders/i.test(task) && /count/i.test(task))) {
        return [{ kind: 'sql', sql: `SELECT count(*) AS n FROM demo_orders` }]
    }
    if (/recursive count/i.test(task) || /no end/i.test(task)) {
        return [{ kind: 'sql', sql: `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT count(*) AS n FROM c` }]
    }
    if (/how many rows are in the tickets table/i.test(task)) {
        return [{ kind: 'sql', sql: `SELECT count(*) AS n FROM tickets` }]
    }
    if (/tickets/i.test(task) && /150/.test(task)) {
        return [
            { kind: 'sql', sql: `DROP TABLE IF EXISTS tickets` },
            { kind: 'sql', sql: `CREATE TABLE tickets (id INTEGER PRIMARY KEY, title TEXT)` },
            {
                kind: 'sql',
                sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150) INSERT INTO tickets (id, title) SELECT i, 'Ticket ' || i FROM n`
            },
            { kind: 'sql', sql: `SELECT id, title FROM tickets ORDER BY id` }
        ]
    }
    if (/select every row from tickets/i.test(task)) {
        return [{ kind: 'sql', sql: `SELECT id, title FROM tickets ORDER BY id` }]
    }
    if (/how many tasks are open/i.test(task)) {
        return [{ kind: 'sql', sql: `SELECT id, title, status FROM tasks WHERE status = 'open' ORDER BY id` }]
    }
    if (/demo_orders/i.test(task) && /qty/i.test(task)) {
        return [{ kind: 'sql', sql: `SELECT * FROM demo_orders ORDER BY qty DESC, order_id` }]
    }
    const explicit = splitSql(task).filter((sql) => /\b(FROM|TABLE|INTO|SET|VALUES|WHERE)\b/i.test(sql))
    if (explicit.length) return explicit.map((sql) => ({ kind: 'sql', sql }))
    if (/seed bakery orders/i.test(task)) {
        return [
            { kind: 'sql', sql: `DROP TABLE IF EXISTS demo_orders` },
            { kind: 'sql', sql: `CREATE TABLE demo_orders (order_id INTEGER PRIMARY KEY, item TEXT, qty INTEGER)` },
            {
                kind: 'sql',
                sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150) INSERT INTO demo_orders (order_id, item, qty) SELECT i, CASE i % 3 WHEN 0 THEN 'apple tart' WHEN 1 THEN 'lemon cake' ELSE 'rye loaf' END, 13 FROM n`
            }
        ]
    }
    if (/seed sqlite shot/i.test(task)) {
        return [
            { kind: 'sql', sql: `DROP TABLE IF EXISTS sales` },
            { kind: 'sql', sql: `DROP TABLE IF EXISTS tickets` },
            { kind: 'sql', sql: `CREATE TABLE sales (id INTEGER PRIMARY KEY, region TEXT, units INTEGER)` },
            { kind: 'sql', sql: `INSERT INTO sales (region, units) VALUES ('west', 10), ('east', 20), ('west', 5)` },
            { kind: 'sql', sql: `CREATE TABLE tickets (id INTEGER PRIMARY KEY, title TEXT)` },
            { kind: 'sql', sql: `INSERT INTO tickets (id, title) VALUES (1, 'Ticket 1'), (2, 'Ticket 2'), (3, 'Ticket 3')` }
        ]
    }
    return []
}

function parseToolPayload(raw) {
    const text = textOf(raw)
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    let payload
    if (start !== -1 && end > start) {
        try {
            payload = JSON.parse(text.slice(start, end + 1))
        } catch {
            payload = { text }
        }
    } else payload = { text }
    if (payload && typeof payload.result === 'string') {
        try {
            const inner = JSON.parse(payload.result)
            if (inner && typeof inner === 'object') payload = { ...payload, ...inner }
        } catch {
            // The tool result was not JSON.
        }
    }
    return payload
}

function ticketTable(from, to) {
    const lines = ['| id | title |', '| --- | --- |']
    for (let i = from; i <= to; i += 1) lines.push(`| ${i} | Ticket ${i} |`)
    return lines.join('\n')
}

const PAGE_1 = 'rows 1-100 of 150 (page 1 of 2, say "show more" for the next page)'
const PAGE_2 = 'rows 101-150 of 150 (page 2 of 2, last page)'
const TASKS_TABLE = ['| title | status |', '| --- | --- |', '| draft agenda | open |', '| send invites | open |'].join('\n')
const JOIN_LINE = 'apple tart 650 ordered, target 900; lemon cake 650, target 400; rye loaf 650, target 300.'

function rowsOf(payload) {
    if (Array.isArray(payload?.rows)) return payload.rows
    if (Array.isArray(payload)) return payload
    return []
}

function formatRow(row) {
    return Object.entries(row)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ')
}

function answerFromTools(task, results) {
    const payloads = results.map((item) => parseToolPayload(item.content))
    const errors = []
    for (const payload of payloads) {
        const message = payload?.error || payload?.message || ''
        if (message) errors.push(String(message))
        const text = typeof payload?.text === 'string' ? payload.text : ''
        if (/error|refused|no such table|timeout/i.test(text) && !payload?.rows) errors.push(text)
    }
    if (errors.length) {
        const line = errors[errors.length - 1]
        if (/no such table:\s*demo_orders/i.test(line)) {
            return 'The query failed because there is no table named demo_orders in the database.'
        }
        if (/no such table/i.test(line)) return `The query failed with ${line}`
        if (/timeout/i.test(line)) return line
        if (/refused/i.test(line)) return line
        return `The query failed because ${line}`
    }
    const last = payloads[payloads.length - 1] || {}
    const rows = rowsOf(last)
    const summary = typeof last.summary === 'string' ? last.summary : ''
    if (/WA-1004/i.test(task) && rows[0]?.unpaid_invoices != null) {
        const row = rows[0]
        return `${row.account_code} (${row.name}) has ${row.unpaid_invoices} unpaid invoices.`
    }
    if (/how many tasks are open/i.test(task)) {
        const titles = rows.map((row) => row.title).filter(Boolean)
        return `There are ${titles.length} open tasks:\n\n${titles.map((title, i) => `${i + 1}. ${title}`).join('\n')}`
    }
    if (/how many rows are in the tickets table/i.test(task)) {
        const n = rows[0]?.n ?? rows[0]?.count ?? rows.length
        return `The tickets table contains ${n} rows.`
    }
    if (/count\(\*\)|count of/i.test(task) && /demo_orders/i.test(task)) {
        const n = rows[0]?.n ?? rows[0]?.count
        return `The query returned a count of ${n} rows in the demo_orders table.`
    }
    if (/highest qty/i.test(task)) {
        const top = rows.filter((row) => Number(row.qty) === Number(rows[0]?.qty)).slice(0, 5)
        const named = top.map((row) => `order_id ${row.order_id} (${row.item})`).join(', ')
        return `The orders with the highest quantity of ${rows[0]?.qty} are ${named}.`
    }
    if (/tmp_targets/i.test(task) && rows.length && rows[0].item && rows[0].ordered != null) return JOIN_LINE
    if (/sales table/i.test(task)) {
        const totals = payloads.map(rowsOf).find((list) => list[0] && 'units' in list[0] && !('id' in list[0])) || []
        const before = totals.map((row) => `${row.region} ${row.units}`).join(', ')
        const finalRows = rows.map((row) => formatRow(row)).join('\n')
        return `Total units by region before the update: ${before}.\n\n${finalRows}`
    }
    if (/sample note|researcher reads|vectors built/i.test(task)) {
        const blob = results.map((item) => textOf(item.content)).join('\n')
        const compact = blob.replace(/\s+/g, ' ').slice(0, 700)
        return `The researcher reads the sample note. ${compact} The vectors were built with Local Hash Embeddings.`
    }
    if (rows.length) {
        const lines = rows.slice(0, 20).map((row) => formatRow(row))
        const lead = /tickets/i.test(task)
            ? 'The tickets table was created and populated. Here are the rows ordered by id:'
            : 'Here are the rows:'
        return [lead, '', ...lines, summary].filter(Boolean).join('\n')
    }
    if (summary) return summary
    return 'Done.'
}

function routeJson(user, system) {
    const names = [...system.matchAll(/^- ([a-z0-9_-]+):/gim)].map((m) => m[1])
    const has = (name) => names.includes(name)
    const task = user.trim()
    let chosen = []
    if (/show more|next page|page \d+/i.test(task) && has('analyst')) chosen = ['analyst']
    else if (
        /analyst|database|sql|table|select |insert |tickets|orders|vacuum|tmp_targets|demo_orders|seed sqlite/i.test(task) &&
        has('analyst')
    )
        chosen = ['analyst']
    else if (/note|document|vector|researcher reads/i.test(task) && has('researcher')) chosen = ['researcher']
    else if (/itinerary|italy|venice|travel tips/i.test(task) && has('itinerary-planner')) chosen = ['itinerary-planner']
    else if (/quiz|explain|study/i.test(task) && has('science-explainer')) chosen = ['science-explainer']
    else if (has('researcher') && /note|document/i.test(task)) chosen = ['researcher']
    else if (names.length === 1) chosen = names
    else if (has('analyst')) chosen = ['analyst']
    const steps = chosen.map((name) => ({ specialist: name, task, after: '' }))
    return JSON.stringify({ steps })
}

function planFor(request) {
    const study = {
        title: 'Study Team Harness',
        nodes: [
            {
                id: 'prime',
                name: 'harnessChief',
                label: 'Harness Prime',
                instructions: 'Send a teaching question to the science explainer and a practice question to the quiz writer.'
            },
            {
                id: 'explainer',
                name: 'harnessSpecialist',
                label: 'Science explainer',
                instructions: 'Explain one topic in plain words, with a short example. Do not mention prices.',
                inputs: { specialistName: 'science-explainer', routingSummary: 'Explains a topic in plain words' }
            },
            {
                id: 'quiz',
                name: 'harnessSpecialist',
                label: 'Quiz writer',
                instructions: 'Write three practice questions about the topic. Do not mention prices.',
                inputs: { specialistName: 'quiz-writer', routingSummary: 'Writes three practice questions' }
            }
        ],
        edges: [
            { from: 'explainer', to: 'prime', input: 'specialists' },
            { from: 'quiz', to: 'prime', input: 'specialists' }
        ],
        starterQuestions: [
            'Explain how yeast makes dough rise, in plain words.',
            'Give me three practice questions about yeast and dough.',
            'What is one everyday example of fermentation?'
        ]
    }
    const trip = {
        title: 'Trip Planning Harness',
        nodes: [
            {
                id: 'prime',
                name: 'harnessChief',
                label: 'Harness Prime',
                instructions: 'Send itinerary questions to the itinerary planner. Do not discuss prices.'
            },
            {
                id: 'plan',
                name: 'harnessSpecialist',
                label: 'Itinerary Planner',
                instructions: 'Write a day-by-day plan. Do not mention prices, costs, or money.',
                inputs: { specialistName: 'itinerary-planner', routingSummary: 'Plans the days of a trip' }
            },
            {
                id: 'budget',
                name: 'harnessSpecialist',
                label: 'Budget Specialist',
                instructions: 'Checks quantities with the calculator. Do not mention prices or money.',
                inputs: { specialistName: 'budget-specialist', routingSummary: 'Checks quantities with a calculator' }
            },
            { id: 'calc', name: 'calculator', label: 'Calculator' }
        ],
        edges: [
            { from: 'plan', to: 'prime', input: 'specialists' },
            { from: 'budget', to: 'prime', input: 'specialists' },
            { from: 'calc', to: 'budget', input: 'attached' }
        ],
        starterQuestions: [
            'Plan seven days in Italy that end in Venice, with day 7 for departure.',
            'What should we see on the last full day in Venice?',
            'List travel tips for moving between cities by train.'
        ]
    }
    const news = {
        title: 'News Team Harness',
        nodes: [
            {
                id: 'prime',
                name: 'harnessChief',
                label: 'Harness Prime',
                instructions: 'Send headline research to the web researcher and the write-up to the news writer.'
            },
            {
                id: 'research',
                name: 'harnessSpecialist',
                label: 'Web Researcher',
                instructions: 'Look up headlines with the search tool. Do not mention prices.',
                inputs: { specialistName: 'web-researcher', routingSummary: 'Searches the web for headlines' }
            },
            {
                id: 'writer',
                name: 'harnessSpecialist',
                label: 'News Writer',
                instructions: 'Turn the headlines into a short note. Do not mention prices.',
                inputs: { specialistName: 'news-writer', routingSummary: 'Writes a short note from headlines' }
            },
            { id: 'search', name: 'tavilyAPI', label: 'Tavily API' }
        ],
        edges: [
            { from: 'research', to: 'prime', input: 'specialists' },
            { from: 'writer', to: 'prime', input: 'specialists' },
            { from: 'search', to: 'research', input: 'attached' }
        ],
        starterQuestions: [
            'What are three headlines about neighborhood bakeries today?',
            'Write a short note from those headlines.',
            'Which headline is about bread?'
        ]
    }
    if (/tavily|news team/i.test(request)) return news
    if (/trip planning|itinerary|calculator/i.test(request)) return trip
    return study
}

function tripAnswer() {
    return [
        'Seven days in Italy, ending in Venice. Day 7 is the departure day.',
        '',
        'Day 1. Arrive in Rome and walk the center in the afternoon.',
        'Day 2. Rome: a morning museum and an evening neighborhood stroll.',
        'Day 3. Train to Florence. The old center on foot.',
        'Day 4. Florence: a gallery in the morning and the river in the afternoon.',
        'Day 5. Train to Venice. The first evening is for getting lost on foot.',
        'Day 6. Venice: one island in the morning and the Rialto in the afternoon.',
        'Day 7. Departure.',
        '',
        'Travel tips:',
        '- Book the train seats when you buy the ticket.',
        '- Walk early, before the squares fill.',
        '- Keep one small bag for the train days.'
    ].join('\n')
}

function decide(body) {
    const messages = Array.isArray(body.messages) ? body.messages : []
    const system = systemText(messages)
    const user = lastUser(messages)
    const all = messages.map((m) => textOf(m.content)).join('\n')
    const names = toolNames(body.tools)
    if (all.includes('You build a Cuttlely')) return { content: JSON.stringify(planFor(user || all)) }
    if (all.includes('You route work') || all.includes('Reply with JSON only')) return { content: routeJson(user, all) }
    if (/^Request:/i.test(user) || all.includes('Your specialists already did the work') || all.includes('You are Harness Prime')) {
        if (/sample note|vectors built/i.test(user + all)) {
            return {
                content:
                    'The sample note says the researcher reads this note from an in-memory store. Its vectors were built with Local Hash Embeddings, with no provider key.'
            }
        }
        const unpaid = all.match(/WA-1004 \([^)]*\) has \d+ unpaid invoices\./)
        if (unpaid) return { content: unpaid[0] }
        if (/how many tasks are open/i.test(user)) {
            return { content: 'There are 2 open tasks:\n\n1. draft agenda\n2. send invites' }
        }
        if (/tasks table/i.test(user)) return { content: TASKS_TABLE }
        if (/italy|venice/i.test(user + all)) return { content: tripAnswer() }
        if (/sales table|total units/i.test(user + all)) {
            return { content: 'Total units by region before the update: west 15, east 20.' }
        }
        if (/statement timeout/i.test(all)) return { content: 'canceling statement due to statement timeout' }
        if (/refused ATTACH or VACUUM|refused VACUUM/i.test(all)) {
            return { content: 'Analyst mode refused ATTACH or VACUUM. The analyst store cannot open another file.' }
        }
        if (/show all rows/i.test(user) && /tickets/i.test(user)) {
            return {
                content: `The tickets table was created and populated with 150 rows. Here are the rows ordered by id:\n\nid: 1, title: Ticket 1\nid: 2, title: Ticket 2\nid: 3, title: Ticket 3\nid: 4, title: Ticket 4\n\n${ticketTable(
                    1,
                    100
                )}\n\n${PAGE_1}`
            }
        }
        if (/^Request:\s*show more\b/i.test(user) || /Call the query tool with cursor/i.test(user)) {
            return { content: `${ticketTable(101, 150)}\n\n${PAGE_2}` }
        }
        if (/tmp_targets/i.test(user) && /demo_orders/i.test(user)) return { content: JOIN_LINE }
        if (/no such table: tmp_targets/i.test(all)) return { content: 'The query failed with no such table: tmp_targets.' }
        if (/no table named demo_orders/i.test(all)) {
            return { content: 'The query failed because there is no table named demo_orders in the database.' }
        }
        if (/count of \d+ rows in the demo_orders/i.test(all)) {
            const found = all.match(/The query returned a count of \d+ rows in the demo_orders table\./)
            return { content: found ? found[0] : 'The query returned a count of 150 rows in the demo_orders table.' }
        }
        if (/tickets table contains/i.test(all)) {
            const found = all.match(/The tickets table contains \d+ rows\./)
            return { content: found ? found[0] : 'The tickets table contains 150 rows.' }
        }
        if (/execute_sql tool is not available/i.test(all) || /execute_sql/i.test(user)) {
            return { content: 'The execute_sql tool is not available in this session.' }
        }
    }
    if (/execute_sql/i.test(user) && !names.some((name) => /execute_sql/i.test(name))) {
        return { content: 'The execute_sql tool is not available in this session.' }
    }
    if (system.includes('You are Harness Prime') && /italy|venice/i.test(user + system)) return { content: tripAnswer() }
    const results = toolResultsSinceUser(messages)
    const actions = names.length ? actionsFor(user) : []
    if (names.length && actions.length && results.length < actions.length) {
        const action = actions[results.length]
        if (action.kind === 'describe' && describeToolName(names)) {
            return { tool: { name: describeToolName(names), arguments: { name: action.name } } }
        }
        const name = queryToolName(names) || names[0]
        const args = {}
        if (action.cursor) args.cursor = action.cursor
        if (action.page) args.page = action.page
        if (action.sql) {
            args.sql = action.sql
            args.statement = action.sql
            args.query = action.sql
            args.input = action.sql
        }
        return { tool: { name, arguments: args } }
    }
    if (names.length && !actions.length && !results.length && /note|document|vector|researcher/i.test(user)) {
        const name = otherTool(names) || names[0]
        return { tool: { name, arguments: { input: user, query: user } } }
    }
    if (results.length) return { content: answerFromTools(user, results) }
    if (system.includes('You are Harness Prime')) {
        const blob = messages.map((m) => textOf(m.content)).join('\n')
        if (/italy|venice/i.test(blob)) return { content: tripAnswer() }
        const specialist = blob.split('Specialist').pop() || blob
        return { content: specialist.slice(-4000) }
    }
    if (/italy|venice|travel tips/i.test(user)) return { content: tripAnswer() }
    return { content: 'Done.' }
}

async function maybeHold(body) {
    if (!fs.existsSync(HOLD_FILE)) return
    if (!toolNames(body.tools).length) return
    const deadline = Date.now() + 45000
    while (fs.existsSync(HOLD_FILE) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
    }
}

function completion(body, decision) {
    const id = `chatcmpl-${crypto.randomBytes(6).toString('hex')}`
    const created = Math.floor(Date.now() / 1000)
    const model = body.model || 'gpt-4.1-mini'
    const usage = { prompt_tokens: 800, completion_tokens: 120, total_tokens: 920, prompt_tokens_details: { cached_tokens: 200 } }
    if (decision.tool) {
        const call = {
            id: `call_${crypto.randomBytes(4).toString('hex')}`,
            type: 'function',
            function: { name: decision.tool.name, arguments: JSON.stringify(decision.tool.arguments) }
        }
        return { id, created, model, usage, toolCalls: [call], content: '' }
    }
    return { id, created, model, usage, toolCalls: [], content: decision.content }
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
}

function sendStream(res, packed) {
    const { id, created, model, usage, toolCalls, content } = packed
    const delta = { role: 'assistant' }
    if (toolCalls.length) {
        delta.tool_calls = toolCalls.map((call, index) => ({
            index,
            id: call.id,
            type: 'function',
            function: { name: call.function.name, arguments: call.function.arguments }
        }))
    } else delta.content = content
    const chunk = (choices, extra = {}) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(chunk([{ index: 0, delta, finish_reason: null }]))
    res.write(chunk([{ index: 0, delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }]))
    res.write(chunk([], { usage }))
    res.write('data: [DONE]\n\n')
    res.end()
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
    })
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true })
    if (req.method === 'GET' && url.pathname === '/v1/models') {
        return sendJson(res, 200, { object: 'list', data: [{ id: 'gpt-4.1-mini', object: 'model', owned_by: 'local' }] })
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
        return sendJson(res, 404, { error: { message: 'Not found' } })
    }
    const raw = await readBody(req)
    const body = raw ? JSON.parse(raw) : {}
    await maybeHold(body)
    const results = toolResultsSinceUser(body.messages || [])
    if (results.length) {
        const raw = textOf(results[results.length - 1].content)
        const jsonAt = raw.indexOf('{')
        log(
            `result-json ${raw
                .slice(jsonAt === -1 ? Math.max(0, raw.length - 240) : jsonAt, (jsonAt === -1 ? raw.length : jsonAt) + 280)
                .replace(/\s+/g, ' ')}`
        )
    }
    const decision = decide(body)
    const kind = decision.tool ? `tool ${decision.tool.name}` : 'text'
    log(
        `${kind} tools=${toolNames(body.tools).join(',') || '-'} user=${lastUser(body.messages || [])
            .slice(0, 100)
            .replace(/\s+/g, ' ')}`
    )
    const packed = completion(body, decision)
    if (body.stream) return sendStream(res, packed)
    const message = { role: 'assistant', content: packed.content }
    if (packed.toolCalls.length) message.tool_calls = packed.toolCalls
    sendJson(res, 200, {
        id: packed.id,
        object: 'chat.completion',
        created: packed.created,
        model: packed.model,
        choices: [{ index: 0, message, finish_reason: packed.toolCalls.length ? 'tool_calls' : 'stop' }],
        usage: packed.usage
    })
})

server.listen(PORT, '127.0.0.1', () => {
    log(`listening on 127.0.0.1:${PORT}`)
    console.log(`docs-shots model stand-in on 127.0.0.1:${PORT}`)
})
