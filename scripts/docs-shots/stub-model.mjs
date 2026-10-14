// Local OpenAI-compatible stand-in for the docs reshoot.
// It never calls an outside service and never prints a key.
// The Cuttlely server points here with OPENAI_BASE_URL. Answers are made-up bakery and
// customer-care text. Currency amounts are removed before anything is sent back.
import http from 'node:http'

const PORT = Number(process.env.DOCS_SHOT_STUB_PORT || 8791)

const MATH_PLAN = {
    title: 'Math Helper with Calculator',
    nodes: [
        {
            id: 'agent',
            name: 'toolAgent',
            label: 'Math helper',
            instructions:
                'Use the calculator for every product, sum and division. Do not do arithmetic yourself. Never mention a price or a currency.'
        },
        { id: 'calc', name: 'calculator', label: 'Calculator' },
        { id: 'memory', name: 'bufferMemory', label: 'Buffer Memory' }
    ],
    edges: [
        { from: 'calc', to: 'agent', input: 'tools' },
        { from: 'memory', to: 'agent', input: 'memory' }
    ],
    starterQuestions: ['What is 18 times 24?', 'What is 7 plus 5?', 'What is 100 divided by 4?']
}

const CHART_PLAN = {
    title: 'crumb-sales-team',
    nodes: [
        {
            id: 'prime',
            name: 'harnessChief',
            label: 'Bakery lead',
            instructions:
                'Send a chart question to the charts specialist. Answer with a short table of counts. Never state a price, a cost or a currency amount.'
        },
        {
            id: 'charts',
            name: 'harnessSpecialist',
            label: 'Charts',
            instructions:
                'Draw a bar chart of the loaf counts in the task and save the PNG in the image folder the task names. Reply with the counts only. Never state a price or a currency amount.',
            inputs: {
                specialistName: 'charts',
                routingSummary: 'Draws bar charts of loaf counts',
                enableCodeExecution: true
            }
        }
    ],
    edges: [{ from: 'charts', to: 'prime', input: 'specialists' }],
    starterQuestions: [
        'Compare sourdough and rye loaves: sourdough 120, rye 75',
        'Chart this week of croissant loaves',
        'How many baguettes left the oven on Monday?'
    ]
}

function stripMoney(text) {
    return String(text ?? '')
        .replace(/\$\s?\d[\d,]*(?:\.\d+)?/g, '')
        .replace(/\bUSD\b/gi, '')
        .replace(/\b\d+\.\d{2}\b/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ +([,.;:])/g, '$1')
}

function messageText(message) {
    const content = message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part === 'string' ? part : part?.text || part?.content || '')).join('\n')
    }
    return content == null ? '' : String(content)
}

function transcript(messages) {
    return (messages || []).map((message) => `${message?.role || ''}: ${messageText(message)}`).join('\n')
}

function lastUser(messages) {
    const list = Array.isArray(messages) ? messages : []
    const users = list.filter((message) => message?.role === 'user')
    return messageText(users.at(-1) || {})
}

function lastQuestion(text) {
    const lines = String(text)
        .split('\n')
        .filter((line) => line.startsWith('user:'))
    return lines.at(-1)?.slice(6) || String(text)
}

function toolNames(body) {
    return (body.tools || []).map((tool) => tool?.function?.name || tool?.name || '').filter(Boolean)
}

function toolResult(messages) {
    const tools = (messages || []).filter((message) => message?.role === 'tool')
    return tools.map((message) => messageText(message)).join('\n')
}

function folderFrom(text) {
    const quoted = text.match(/sys\.path\.insert\(0,\s*'([^']+)'\)/)
    if (quoted) return quoted[1]
    const image = text.match(/save it as a PNG or JPEG file in this folder:\s*(\S+)/)
    return image ? image[1] : ''
}

function imageFolder(text) {
    const match = text.match(/save it as a PNG or JPEG file in this folder:\s*(\S+)/)
    return match ? match[1] : ''
}

function orderId(text) {
    return text.match(/LH-\d+/)?.[0] || ''
}

function chartCode(text) {
    const folder = imageFolder(text)
    const croissants = /croissant/i.test(text)
    const title = croissants ? 'Croissants baked this week' : 'Sourdough and rye loaves'
    const labels = croissants ? ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : ['Sourdough', 'Rye']
    const values = croissants ? [42, 55, 48, 63, 71, 88] : [120, 75]
    const file = croissants ? 'croissants.png' : 'loaves.png'
    return `
import os
from PIL import Image, ImageDraw, ImageFont
labels = ${JSON.stringify(labels)}
values = ${JSON.stringify(values)}
title = ${JSON.stringify(title)}
folder = ${JSON.stringify(folder)}
font = ImageFont.load_default(size=18)
small = ImageFont.load_default(size=16)
big = ImageFont.load_default(size=24)
probe = ImageDraw.Draw(Image.new('RGB', (1, 1)))
label_w = max(int(probe.textlength(label, font=font)) for label in labels)
left = min(max(label_w + 36, 160), 280)
bar_h, gap, top, right = 28, 14, 78, 90
width, height = 920, top + len(labels) * (bar_h + gap) + 36
img = Image.new('RGB', (width, height), 'white')
draw = ImageDraw.Draw(img)
draw.text((24, 20), title, fill='#1f2937', font=big)
draw.text((24, 50), 'Loaves', fill='#6b7280', font=small)
peak = max(values) or 1
span = width - left - right
for i, (label, value) in enumerate(zip(labels, values)):
    y = top + i * (bar_h + gap)
    w = max(4, int(span * value / peak))
    draw.text((left - 12 - probe.textlength(label, font=font), y + 4), label, fill='#374151', font=font)
    draw.rounded_rectangle((left, y, left + w, y + bar_h), radius=6, fill='#7c3aed' if i == 0 else '#a78bfa')
    draw.text((left + w + 8, y + 4), str(value), fill='#111827', font=small)
os.makedirs(folder, exist_ok=True)
path = os.path.join(folder, ${JSON.stringify(file)})
img.save(path, 'PNG')
print(title)
for label, value in zip(labels, values):
    print(f'{label} {int(value)}')
print(path)
`.trim()
}

function specialistCode(text) {
    const folder = folderFrom(text)
    const order = orderId(text) || 'LH-20417'
    const task = text.slice(text.lastIndexOf('\nuser:'))
    if (/support_desk|account_snapshot/.test(text)) {
        return `import sys\nsys.path.insert(0, ${JSON.stringify(
            folder
        )})\nfrom support_desk import account_snapshot\nprint(account_snapshot(order_id=${JSON.stringify(order)}))`
    }
    if (/policy_book|remedy_table|read_policy/.test(text)) {
        const fault = /LH-20398|Daniel/.test(text) ? 'carrier' : 'larkfield'
        return `import sys\nsys.path.insert(0, ${JSON.stringify(folder)})\nfrom policy_book import read_policy\nprint(read_policy('2.1'))`
    }
    if (/held_orders/.test(text) && /held|packing wave/i.test(task)) {
        return `import sys\nsys.path.insert(0, ${JSON.stringify(folder)})\nfrom fulfillment import held_orders\nprint(held_orders())`
    }
    if (/fulfillment|investigate|trace_order/.test(text)) {
        return `import sys\nsys.path.insert(0, ${JSON.stringify(
            folder
        )})\nfrom fulfillment import investigate\nprint(investigate(${JSON.stringify(order)}))`
    }
    if (marchCroissantQuestion(task) || marchCroissantQuestion(text)) {
        return [
            'print("Riverside sold 335 more croissants than Old Town in March 2026.")',
            'print("Shop Units")',
            'print("Riverside 1346")',
            'print("Old Town 1011")'
        ].join('\n')
    }
    if (imageFolder(text) || /bakery_chart|loaves|croissant/i.test(text)) return chartCode(text)
    return `print(${JSON.stringify('The lookup finished. No currency amount is included.')})`
}

function routeSteps(text) {
    const question = lastQuestion(text)
    if (/held/i.test(question)) {
        return {
            steps: [
                {
                    specialist: 'operations',
                    task: 'List every order held in a warehouse, by packing wave.',
                    after: ''
                },
                {
                    specialist: 'customer',
                    task: 'For the held orders operations lists, name each customer and tier.',
                    after: 'operations'
                }
            ]
        }
    }
    if (/croissant|revenue|opening hours|nuts|Old Town/i.test(question) && /analyst|librarian/.test(text)) {
        const specialist = /hour|nut|handbook/i.test(question) ? 'librarian' : 'analyst'
        return { steps: [{ specialist, task: question, after: '' }] }
    }
    const order = orderId(question) || 'LH-20417'
    const who = /Daniel/.test(question) ? 'Daniel Reyes' : 'Maya Okafor'
    return {
        steps: [
            {
                specialist: 'customer',
                task: `Read the support desk for ${who}, order ${order}. Report the tier and whether another delivery was late.`,
                after: ''
            },
            {
                specialist: 'operations',
                task: `Trace order ${order}: warehouse scans, carrier scans, and where the parcel is.`,
                after: ''
            },
            {
                specialist: 'policy',
                task: `From the operations result, decide fault for order ${order} and name the remedy steps.`,
                after: 'operations'
            }
        ]
    }
}

const MAYA = `**Decision:** The delay is Larkfield Home's fault. The parcel was held after a warehouse scale check and the carrier never received it. The remedy is a shipping refund, an Express reship arriving 2026-10-08, a recall of the held parcel, a store credit, and a call from the Customer Care Lead.

**Reply to the customer:** Maya, a warehouse error kept the parcel from the carrier, so the tracking page never moved. We can send a replacement by Express, arriving Thursday, October 8, or refund the order. We will also add a store credit and the Customer Care Lead will call.

**Actions:**
- Refund the shipping
- Reship from Reno by Express, arriving 2026-10-08
- Recall the parcel held at the Columbus warehouse
- Add the store credit
- Ask the Customer Care Lead to call
- Open an operations incident for packing wave W-0929-B, which held 5 orders

**Evidence:**
- customer: Maya Okafor is a Plus customer. Her previous order was late 52 days ago, so this is a second late delivery.
- operations: the parcel failed the outbound scale check and stayed in the exception cage. The carrier scan is only "Label created".
- policy: a delay before the carrier's first pickup scan is Larkfield's fault, so the goodwill limit does not apply.

Source: Service Recovery Policy, sections 1.2, 2.1, 2.3, 2.5, 3.1, 3.2, 3.3, 3.4.`

const DANIEL = `**Decision:** The delay was the carrier's fault. A road closure for snow held the parcel after pickup. Daniel Reyes is a Standard customer with no other late delivery, so the remedy is a carrier trace, a reship only after 3 business days with no new scan, and a goodwill credit.

**Reply to the customer:** Daniel, the carrier has the duvet set and a snow closure is holding it. We have asked the carrier for a trace. If there is no new scan for 3 business days we will reship it, and a goodwill credit is on the account.

**Actions:**
- Ask the carrier for a trace
- Reship only after 3 business days with no new scan
- Add the goodwill credit for a Standard customer

**Evidence:**
- customer: Daniel Reyes is a Standard customer with no other late delivery in the last 120 days.
- operations: the carrier picked the parcel up on time and then recorded a road closure for snow.
- policy: a delay after the carrier's first scan is the carrier's fault. A Standard customer with no other late delivery receives a trace and a goodwill credit.

Source: Service Recovery Policy, sections 2.4, 3.1.`

const HELD = `Five orders are held in packing wave W-0929-B.
- LH-20409, Premier
- LH-20411, Standard
- LH-20417, Plus
- LH-20420, Plus
- LH-20422, Standard

The Plus and Premier customers in that wave are LH-20409 (Premier), LH-20417 (Plus) and LH-20420 (Plus).`

// March 2026 croissant units from samples/demo/bakery/bakery.sql: Riverside 1346, Old Town 1011.
const MARCH_CROISSANTS = `Riverside sold 335 more croissants than Old Town in March 2026.

| Shop | Units |
| --- | --- |
| Riverside | 1346 |
| Old Town | 1011 |`

const WEEK_LOAVES = `Croissants baked this week:

| Day | Loaves |
| --- | --- |
| Monday | 42 |
| Tuesday | 55 |
| Wednesday | 48 |
| Thursday | 63 |
| Friday | 71 |
| Saturday | 88 |`

function marchCroissantQuestion(text) {
    return /which shop sold more croissants in march 2026/i.test(text)
}

function handoff(text) {
    const question = lastQuestion(text)
    if (/LH-20398|Daniel/.test(question) || /LH-20398|Daniel/.test(text)) return DANIEL
    if (/held/i.test(question)) return HELD
    if (marchCroissantQuestion(question) || marchCroissantQuestion(text)) return MARCH_CROISSANTS
    if (/croissant/i.test(question) || /chart this week of croissant loaves/i.test(text)) {
        return WEEK_LOAVES
    }
    if (/sourdough|rye loaves|120/.test(question) || /Sourdough/.test(text)) {
        return 'Loaves compared:\n\n| Loaf | Count |\n| --- | --- |\n| Sourdough | 120 |\n| Rye | 75 |'
    }
    if (/LH-20417|Maya|espresso/.test(question) || /Maya/.test(text)) return MAYA
    return 'The team finished the question. No currency amount is included.'
}

function bakeryAnswer(question) {
    const q = question.toLowerCase()
    if (/name/.test(q) && /sunday/.test(q)) return 'Your name is Sam, and the bakery is closed on Sunday.'
    if (/sam/.test(q) && /name/.test(q)) return 'Your name is Sam, and the bakery is closed on Sunday.'
    if (/my name|what is my name|who am i/.test(q)) return 'Your name is Sam.'
    if (/rye/.test(q) && /saturday/.test(q)) return 'Hi Sam, yes, rye bread is baked today since it is Saturday.'
    if (/gluten/.test(q)) return 'Yes. A gluten-free buckwheat loaf is baked on Fridays.'
    if (/sunday|hours|open/.test(q)) {
        return 'We are closed on Sunday.\n\n| Day | Hours |\n| --- | --- |\n| Monday | 7am - 6pm |\n| Tuesday | 7am - 6pm |\n| Wednesday | 7am - 6pm |\n| Thursday | 7am - 6pm |\n| Friday | 7am - 6pm |\n| Saturday | 8am - 4pm |\n| Sunday | Closed |'
    }
    if (/bread/.test(q)) {
        return 'Today the case has country sourdough, seeded rye, baguette and brioche loaf. A gluten-free buckwheat loaf is baked on Fridays.'
    }
    if (/18/.test(q) && /24/.test(q)) return '18 times 24 is 432.'
    if (/7/.test(q) && /5/.test(q)) return '7 plus 5 is 12.'
    if (/100/.test(q) && /4/.test(q)) return '100 divided by 4 is 25.'
    return 'Ask about the breads, the opening hours, or a sum.'
}

function calculatorArgs(question) {
    if (/18/.test(question) && /24/.test(question)) return '18*24'
    if (/7/.test(question) && /5/.test(question)) return '7+5'
    if (/100/.test(question) && /4/.test(question)) return '100/4'
    const compact = question
        .replace(/times/gi, '*')
        .replace(/plus/gi, '+')
        .replace(/divided by/gi, '/')
    const expr = compact.match(/[\d+\-*/().\s]{3,}/)
    return (expr?.[0] || '0').replace(/\s/g, '')
}

function decide(body) {
    const messages = body.messages || []
    const text = transcript(messages)
    const names = toolNames(body)
    const question = lastUser(messages)
    if (/You build a Cuttlely harness/.test(text)) return { content: JSON.stringify(CHART_PLAN) }
    if (/You build a Cuttlely/.test(text)) return { content: JSON.stringify(MATH_PLAN) }
    if (/You route work/.test(text)) return { content: JSON.stringify(routeSteps(text)) }
    if (/You are Harness Prime/.test(text)) return { content: handoff(text) }
    if (names.some((name) => name === 'calculator' || name.includes('calculator'))) {
        if (toolResult(messages)) return { content: bakeryAnswer(question) }
        return { toolCalls: [{ name: 'calculator', arguments: { input: calculatorArgs(question) } }] }
    }
    if (names.some((name) => /execute_code|code/.test(name))) {
        const codeName = names.find((name) => name === 'execute_code') || names.find((name) => /code/.test(name))
        if (toolResult(messages)) {
            console.log(`[docs-shot-stub] tool-result ${stripMoney(toolResult(messages)).replace(/\s+/g, ' ').slice(0, 180)}`)
            const task = text.slice(text.lastIndexOf('\nuser:'))
            if (/support_desk|account_snapshot/.test(text)) {
                return { content: 'The account is on file. Tier and late-delivery notes were read. No currency amount is repeated here.' }
            }
            if (/policy_book|remedy_table/.test(text)) {
                return { content: 'Fault and the remedy steps were read from the policy. Currency amounts are left out of this note.' }
            }
            if (/held_orders/.test(text) && /held|packing wave/i.test(task)) return { content: HELD }
            if (/fulfillment|investigate/.test(text)) {
                return {
                    content: 'The parcel trace is in. Warehouse scans and carrier scans were read. No currency amount is repeated here.'
                }
            }
            if (marchCroissantQuestion(task) || marchCroissantQuestion(text)) return { content: MARCH_CROISSANTS }
            return { content: stripMoney(toolResult(messages)).slice(0, 1500) || 'The chart was saved.' }
        }
        return { toolCalls: [{ name: codeName, arguments: { code: specialistCode(text) } }] }
    }
    return { content: bakeryAnswer(question || text) }
}

function completion(body, decision) {
    const toolCalls = (decision.toolCalls || []).map((call, index) => ({
        id: `call_docs_${index + 1}`,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) }
    }))
    const content = toolCalls.length ? null : stripMoney(decision.content || '')
    return {
        id: 'chatcmpl-docs-shot',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'gpt-4.1-mini',
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
                finish_reason: toolCalls.length ? 'tool_calls' : 'stop'
            }
        ],
        usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 }
    }
}

function writeStream(res, body, decision) {
    const payload = completion(body, decision)
    const choice = payload.choices[0]
    const send = (delta, finish) => {
        const chunk = {
            id: payload.id,
            object: 'chat.completion.chunk',
            created: payload.created,
            model: payload.model,
            choices: [{ index: 0, delta, finish_reason: finish }]
        }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
    })
    if (choice.message.tool_calls) {
        send({ role: 'assistant', content: '' }, null)
        choice.message.tool_calls.forEach((call, index) => {
            send({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] }, null)
            send({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] }, null)
        })
        send({}, 'tool_calls')
    } else {
        send({ role: 'assistant', content: choice.message.content || '' }, null)
        send({}, 'stop')
        res.write(
            `data: ${JSON.stringify({
                id: payload.id,
                object: 'chat.completion.chunk',
                created: payload.created,
                model: payload.model,
                choices: [],
                usage: payload.usage
            })}\n\n`
        )
    }
    res.end('data: [DONE]\n\n')
}

function tag(body, decision) {
    const names = toolNames(body)
    const kind = decision.toolCalls ? `tool:${decision.toolCalls.map((call) => call.name).join(',')}` : 'text'
    const head = lastUser(body.messages || [])
        .replace(/\s+/g, ' ')
        .slice(0, 80)
    console.log(`[docs-shot-stub] ${kind} tools=${names.join('|') || '-'} :: ${head}`)
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, data: [{ id: 'gpt-4.1-mini', object: 'model' }] }))
        return
    }
    if (req.method !== 'POST') {
        res.writeHead(404)
        res.end()
        return
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
        let body = {}
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch {
            res.writeHead(400)
            res.end('{"error":{"message":"bad json"}}')
            return
        }
        let decision
        try {
            decision = decide(body)
        } catch (error) {
            console.log(`[docs-shot-stub] error ${error.message}`)
            decision = { content: 'The stand-in could not read that request.' }
        }
        tag(body, decision)
        if (body.stream) writeStream(res, body, decision)
        else {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(completion(body, decision)))
        }
    })
})

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[docs-shot-stub] listening on 127.0.0.1:${PORT}`)
})
