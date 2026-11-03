import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fakeServer, installDom, json, sseResponse, until } from './dom.js'
import { ENHANCED_LINES, ENHANCED_ROTATE_MS } from '../src/live-status.js'

const FLOW = '11111111-2222-3333-4444-555555555555'
let env
let mount

beforeEach(async () => {
    env = installDom()
    ;({ mount } = await import('../src/index.js'))
})
afterEach(() => env.restore())

function setup(routes, options = {}) {
    const server = fakeServer(routes)
    const host = document.createElement('div')
    document.body.append(host)
    const widget = mount(host, { flowId: FLOW, apiHost: 'https://cuttlely.example', mode: 'page', fetch: server.fetchImpl, ...options })
    const $ = (sel) => host.shadowRoot.querySelector(sel)
    const $$ = (sel) => Array.from(host.shadowRoot.querySelectorAll(sel))
    return { server, widget, host, $, $$ }
}

async function type(t, text) {
    await until(() => t.$('textarea'))
    t.$('textarea').value = text
    t.$('.dc-send').click()
}

describe('chat widget', () => {
    it('sorts completed answer tables locally and keeps links, original answer and independent tables intact', async () => {
        const answer =
            '| Account | ACV | Risk score |\n| --- | ---: | ---: |\n| [Alpha](https://example.com/alpha) | $10,000.00 | 0.19 |\n| Bravo | $900.00 | 0.58 |\n| Charlie | Unknown | Unknown |\n\n| Other | Value |\n| --- | --- |\n| First | 2 |\n| Second | 1 |'
        const t = setup({
            predict: () =>
                sseResponse([
                    { event: 'token', data: answer },
                    { event: 'end', data: '[DONE]' }
                ])
        })
        await type(t, 'Show accounts')
        await until(() => t.$('.md-table-sort') && !t.widget.busy)
        const requests = t.server.calls.length
        const table = t.$('table')
        const names = () => Array.from(table.tBodies[0].rows, (row) => row.cells[0].textContent)
        assert.deepEqual(names(), ['Alpha', 'Bravo', 'Charlie'])
        table.tHead.rows[0].cells[1].querySelector('button').click()
        assert.deepEqual(names(), ['Bravo', 'Alpha', 'Charlie'])
        assert.equal(table.tHead.rows[0].cells[1].getAttribute('aria-sort'), 'ascending')
        table.tHead.rows[0].cells[1].querySelector('button').click()
        assert.deepEqual(names(), ['Alpha', 'Bravo', 'Charlie'])
        assert.equal(table.tHead.rows[0].cells[1].getAttribute('aria-sort'), 'descending')
        table.tHead.rows[0].cells[2].querySelector('button').click()
        table.tHead.rows[0].cells[2].querySelector('button').click()
        assert.deepEqual(names(), ['Bravo', 'Alpha', 'Charlie'])
        assert.equal(table.querySelector('a').getAttribute('href'), 'https://example.com/alpha')
        assert.equal(t.$$('table')[1].tBodies[0].rows[0].cells[0].textContent, 'First')
        assert.equal(t.server.calls.length, requests)
        assert.equal(t.widget.messages.find((message) => message.role === 'assistant')?.text || t.widget.messages[1].text, answer)
        // Rendering a new last-message state must not reset a previous table's chosen order.
        const bot = t.widget.messages[1]
        bot.rev++
        t.widget.renderThread()
        assert.equal(t.$('table').tBodies[0].rows[0].cells[0].textContent, 'Bravo')
        t.widget.destroy()
    })

    it('shows the flow title, welcome text and starter prompts from the share settings', async () => {
        const t = setup({
            config: () =>
                json(200, {
                    title: 'Crumb & Co',
                    welcomeMessage: 'Fresh bread daily.',
                    starterPrompts: { 0: { prompt: 'What is fresh?' } }
                })
        })
        await until(() => t.$('.dc-prompt'))
        assert.equal(t.$('.dc-title').textContent, 'Crumb & Co')
        assert.equal(t.$('.dc-welcome p').textContent, 'Fresh bread daily.')
        assert.equal(t.$('.dc-prompt').textContent, 'What is fresh?')
        assert.match(t.server.calls[0].path, new RegExp(`/api/v1/public-chatbotConfig/${FLOW}$`))
    })

    it('streams an answer, then sends the server-issued session back on the next turn', async () => {
        const t = setup({
            predict: (body, n) =>
                sseResponse([
                    { event: 'start', data: '' },
                    { event: 'token', data: n === 1 ? 'We have **sourdough**' : 'Yes' },
                    { event: 'token', data: n === 1 ? ' today.' : '.' },
                    { event: 'metadata', data: { chatId: 'chat-1', chatMessageId: `msg-${n}`, sessionToken: 'tok-1' } },
                    { event: 'end', data: '[DONE]' }
                ])
        })
        await type(t, 'What is fresh?')
        await until(() => t.$$('.dc-msg.bot .dc-md strong').length === 1 && !t.widget.busy)
        assert.equal(t.$('.dc-user-bubble').textContent, 'What is fresh?')
        assert.match(t.$('.dc-msg.bot .dc-md').textContent, /We have sourdough today\./)
        const first = t.server.calls.find((c) => c.path.includes('/prediction/'))
        assert.equal(first.body.streaming, true)
        assert.equal(first.body.chatId, undefined)

        await type(t, 'Is it vegan?')
        await until(() => t.$$('.dc-msg.bot').length === 2 && !t.widget.busy)
        const second = t.server.calls.filter((c) => c.path.includes('/prediction/'))[1]
        assert.equal(second.body.chatId, 'chat-1')
        assert.equal(second.body.sessionToken, 'tok-1')
        const saved = JSON.parse(localStorage.getItem(`cuttlely-chat:v1:https://cuttlely.example:${FLOW}`))
        assert.equal(saved.chatId, 'chat-1')
        assert.equal(saved.messages.length, 4)
    })

    it('never turns model output into live HTML', async () => {
        const t = setup({
            predict: () =>
                sseResponse([
                    { event: 'token', data: '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>' },
                    { event: 'token', data: '[a](javascript:window.__xss=3) <a href="javascript:1">b</a>' },
                    { event: 'sourceDocuments', data: [{ pageContent: '<b>x</b>', metadata: { source: 'javascript:alert(1)' } }] }
                ])
        })
        await type(t, 'hi')
        await until(() => t.$('.dc-msg.bot .dc-md') && !t.widget.busy)
        const root = t.host.shadowRoot
        assert.equal(root.querySelectorAll('.dc-msg.bot script, .dc-msg.bot iframe').length, 0)
        assert.equal(root.querySelectorAll('.dc-msg.bot .dc-md img').length, 0)
        for (const a of root.querySelectorAll('.dc-msg.bot a')) assert.match(a.getAttribute('href'), /^(https?:|mailto:)/)
        for (const el of root.querySelectorAll('.dc-msg.bot *')) {
            for (const attr of el.attributes) assert.ok(!/^on/i.test(attr.name), `${el.tagName} has ${attr.name}`)
        }
        assert.equal(window.__xss, undefined)
        assert.match(t.$('.dc-msg.bot .dc-md').textContent, /<img src=x/)
    })

    it('shows the private state when the flow needs a key', async () => {
        const t = setup({ predict: () => json(401, { message: 'Unauthorized' }) })
        await type(t, 'hi')
        await until(() => t.$('.dc-notice'))
        assert.equal(t.$('.dc-notice h2').textContent, 'This chat is private')
        assert.match(t.$('.dc-notice p').textContent, /private or needs a key/)
        assert.equal(t.$('textarea'), null)
        assert.match(t.$('.dc-status').textContent, /Unavailable/)
        assert.ok(t.$('.dc-status').classList.contains('dc-off'))
    })

    it('shows the private state up front when the page says so', async () => {
        const t = setup({}, { blocked: 'private' })
        await until(() => t.$('.dc-notice'))
        assert.equal(t.server.calls.length, 0)
    })

    it('shows not found when the config cannot be read', async () => {
        const t = setup({ config: () => json(500, { message: 'Chatflow not found' }) })
        await until(() => t.$('.dc-notice'))
        assert.equal(t.$('.dc-notice h2').textContent, 'Chat not found')
    })

    it('offers Try again after a server error and resends the same question', async () => {
        let fail = true
        const t = setup({
            predict: () => {
                if (fail) {
                    fail = false
                    return json(500, { message: 'boom' })
                }
                return sseResponse([{ event: 'token', data: 'Recovered' }])
            }
        })
        await type(t, 'Opening hours?')
        await until(() => t.$('.dc-error .dc-chip'))
        t.$('.dc-error .dc-chip').click()
        await until(() => /Recovered/.test(t.$('.dc-msg.bot .dc-md')?.textContent || '') && !t.widget.busy)
        assert.equal(t.$$('.dc-msg.user').length, 1)
        assert.equal(t.server.calls.filter((c) => c.path.includes('/prediction/'))[1].body.question, 'Opening hours?')
    })

    it('renders sources, follow-ups and sends thumbs feedback when enabled', async () => {
        const t = setup({
            config: () => json(200, { chatFeedback: { status: true }, followUpPrompts: { status: true } }),
            predict: () =>
                sseResponse([
                    { event: 'token', data: 'Rye is baked at 6.' },
                    {
                        event: 'sourceDocuments',
                        data: [
                            { pageContent: 'Rye: 6am', metadata: { source: 'docs/schedule.md' } },
                            { pageContent: 'x', metadata: { url: 'https://bakery.example/faq', title: 'FAQ' } }
                        ]
                    },
                    { event: 'metadata', data: { chatId: 'c', chatMessageId: 'm-1', followUpPrompts: JSON.stringify(['And sourdough?']) } }
                ]),
            feedback: () => json(200, {})
        })
        await type(t, 'When is rye baked?')
        await until(() => t.$('.dc-source') && !t.widget.busy)
        const chips = t.$$('.dc-source')
        assert.equal(chips[0].textContent, '1schedule.md')
        assert.equal(chips[1].getAttribute('href'), 'https://bakery.example/faq')
        assert.equal(t.$('.dc-followups .dc-chip').textContent, 'And sourdough?')
        t.$('[aria-label="Good answer"]').click()
        await until(() => t.server.calls.some((c) => c.path.startsWith('/api/v1/feedback')))
        const fb = t.server.calls.find((c) => c.path.startsWith('/api/v1/feedback'))
        assert.deepEqual(fb.body, { chatflowid: FLOW, chatId: 'c', messageId: 'm-1', rating: 'THUMBS_UP' })
    })

    it('renders a harness run card and the chart it produced', async () => {
        const t = setup({
            predict: () =>
                sseResponse([
                    { event: 'harness.route', data: { phase: 'start', harness: 'bakery-desk' } },
                    { event: 'harness.route', data: { phase: 'done', steps: [{ specialist: 'Sales analyst' }] } },
                    { event: 'harness.specialist', data: { phase: 'start', name: 'Sales analyst' } },
                    { event: 'harness.specialist', data: { phase: 'done', name: 'Sales analyst', ms: 2100 } },
                    { event: 'harness.partial', data: { phase: 'answer', text: 'Croissants lead.', streamedAsToken: true } },
                    { event: 'start', data: 'Croissants lead.' },
                    { event: 'token', data: 'Croissants lead.' },
                    { event: 'artifacts', data: [{ type: 'png', data: 'FILE-STORAGE::harness_chart.png' }] },
                    {
                        event: 'harness.final',
                        data: { text: 'Croissants lead.', trace: { wallMs: 4200, specialists: [{ name: 'Sales analyst', ms: 2100 }] } }
                    },
                    { event: 'metadata', data: { chatId: 'chat-h', chatMessageId: 'm' } }
                ])
        })
        await type(t, 'Weekly sales chart')
        await until(() => t.$('.dc-run') && !t.widget.busy)
        assert.equal(t.$('.dc-run-title').textContent, 'Run complete')
        assert.match(t.$('.dc-run-meta').textContent, /1 specialist .*4\.2 s/)
        assert.equal(t.$('.dc-msg.bot .dc-md').textContent, 'Croissants lead.', 'answer text shown once')
        const img = t.$('.dc-figure img')
        assert.match(img.getAttribute('src'), /\/api\/v1\/get-upload-file\?chatflowId=.*&chatId=chat-h&fileName=harness_chart\.png$/)
    })

    it('shows a live status line, and an enhanced line that gives way to the next real event', async () => {
        const encoder = new TextEncoder()
        let stream
        const send = (evt) => stream.enqueue(encoder.encode('message:\ndata:' + JSON.stringify(evt) + '\n\n'))
        const t = setup({
            predict: () =>
                new Response(new ReadableStream({ start: (controller) => (stream = controller) }), {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' }
                })
        })
        await type(t, 'Weekly totals')
        await until(() => stream)
        send({ event: 'harness.route', data: { phase: 'start', harness: 'desk' } })
        await until(() => t.$('.dc-run-line')?.textContent === 'Picking specialists…')
        send({ event: 'harness.route', data: { phase: 'done', steps: [{ specialist: 'sql_analyst' }] } })
        send({ event: 'harness.specialist', data: { phase: 'start', name: 'sql_analyst' } })
        send({ event: 'harness.tool', data: { phase: 'start', specialist: 'sql_analyst', name: 'mcp__sql_analyst__query' } })
        await until(() => t.$('.dc-run-line')?.textContent === 'sql_analyst is running a SQL query…')
        assert.equal(t.$('.dc-run li .dc-step-live').textContent, 'Running a SQL query…')
        assert.match(t.$('.dc-run-elapsed').textContent, /^0:0\d$/)
        const bot = t.widget.messages[1]
        t.widget.liveSince.at -= 10000
        t.widget.tickLive(bot)
        const playful = t.$('.dc-run-enhanced').textContent
        assert.ok(ENHANCED_LINES.tool.includes(playful), playful)
        t.widget.liveSince.at -= ENHANCED_ROTATE_MS
        t.widget.tickLive(bot)
        assert.ok(ENHANCED_LINES.tool.includes(t.$('.dc-run-enhanced').textContent))
        assert.notEqual(t.$('.dc-run-enhanced').textContent, playful, 'the next rotation draws a new line')
        assert.equal(t.$('.dc-run-enhanced').getAttribute('aria-hidden'), 'true')
        send({ event: 'harness.tool', data: { phase: 'done', specialist: 'sql_analyst', name: 'mcp__sql_analyst__query' } })
        await until(() => t.$('.dc-run-line')?.textContent === 'sql_analyst is thinking about the results…')
        assert.equal(t.$('.dc-run-enhanced').textContent, '')
        send({ event: 'token', data: 'Done.' })
        send({ event: 'end', data: '[DONE]' })
        stream.close()
        await until(() => !t.widget.busy)
        assert.equal(t.$('.dc-run-live'), null, 'the finished card has no live line')
    })

    it('keeps the enhanced line off when the flow turns it off', async () => {
        const encoder = new TextEncoder()
        let stream
        const t = setup({
            config: () => json(200, { enhancedStatusMessages: { status: false } }),
            predict: () =>
                new Response(new ReadableStream({ start: (controller) => (stream = controller) }), {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' }
                })
        })
        await until(() => t.widget.config && t.widget.config.enhancedStatus === false)
        await type(t, 'Weekly totals')
        await until(() => stream)
        stream.enqueue(encoder.encode('message:\ndata:' + JSON.stringify({ event: 'harness.handoff', data: { phase: 'start' } }) + '\n\n'))
        await until(() => t.$('.dc-run-line')?.textContent === 'Pulling it together and writing the answer…')
        t.widget.liveSince.at -= 60000
        t.widget.tickLive(t.widget.messages[1])
        assert.equal(t.$('.dc-run-enhanced').textContent, '')
        stream.close()
        await until(() => !t.widget.busy)
    })

    it('reads a chart the plain image request could not load with the session token, for the current chat', async () => {
        const t = setup({
            predict: () =>
                sseResponse([
                    { event: 'start', data: '' },
                    { event: 'token', data: 'Here is the chart.' },
                    { event: 'artifacts', data: [{ type: 'png', data: 'FILE-STORAGE::harness_chart.png' }] },
                    { event: 'metadata', data: { chatId: 'chat-x', chatMessageId: 'm', sessionToken: 'tok-x' } }
                ]),
            file: () => new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), { status: 200 })
        })
        await type(t, 'Weekly sales chart')
        await until(() => t.$('.dc-figure img') && !t.widget.busy)
        const img = t.$('.dc-figure img')
        // The image was drawn for an earlier chat id (as the first answer's chart is, before metadata arrives).
        t.widget.chatId = 'chat-y'
        img.dispatchEvent(new window.Event('error'))
        await until(() => t.server.calls.some((c) => c.path === '/api/v1/get-upload-file'))
        const read = t.server.calls.find((c) => c.path === '/api/v1/get-upload-file')
        assert.equal(read.headers['x-cuttlely-session-token'], 'tok-x')
        assert.match(read.search, /chatId=chat-y&fileName=harness_chart\.png$/)
        await until(() => img.getAttribute('src').startsWith('blob:'))
        assert.equal(t.$$('.dc-figure-missing').length, 0)
    })

    it('shows a placeholder when the chart cannot be read', async () => {
        const t = setup({
            predict: () =>
                sseResponse([
                    { event: 'token', data: 'Here is the chart.' },
                    { event: 'artifacts', data: [{ type: 'png', data: 'FILE-STORAGE::harness_chart.png' }] },
                    { event: 'metadata', data: { chatId: 'chat-x', chatMessageId: 'm', sessionToken: 'tok-x' } }
                ]),
            file: () => json(403, { message: 'Forbidden' })
        })
        await type(t, 'Weekly sales chart')
        await until(() => t.$('.dc-figure img') && !t.widget.busy)
        t.$('.dc-figure img').dispatchEvent(new window.Event('error'))
        await until(() => t.$('.dc-figure-missing'))
        assert.equal(t.$('.dc-figure-missing').textContent, 'This chart could not be shown here.')
    })

    it('offers files a harness specialist made as download links', async () => {
        const t = setup({
            predict: () =>
                sseResponse([
                    { event: 'token', data: 'The report is ready.' },
                    {
                        event: 'artifacts',
                        data: [
                            { type: 'pdf', data: 'FILE-STORAGE::harness_assets_1700000000000_0_q1-report.pdf', name: 'q1-report.pdf' },
                            { type: 'csv', data: 'FILE-STORAGE::harness_assets_1700000000000_1_orders.csv' },
                            { type: 'xlsx', data: 'https://elsewhere.example/table.xlsx', name: 'table.xlsx' },
                            { type: 'pptx', data: 'FILE-STORAGE::harness_assets_1700000000000_2_q3-deck.pptx', name: 'q3-deck.pptx' }
                        ]
                    },
                    { event: 'metadata', data: { chatId: 'chat-f', chatMessageId: 'm' } }
                ])
        })
        await type(t, 'Quarterly report')
        await until(() => t.$$('.dc-file').length === 3 && !t.widget.busy)
        const [pdf, csv, pptx] = t.$$('.dc-file')
        assert.equal(pptx.getAttribute('download'), 'q3-deck.pptx')
        assert.equal(pptx.querySelector('.dc-file-type').textContent, 'PPTX')
        assert.equal(pdf.getAttribute('download'), 'q1-report.pdf')
        assert.equal(pdf.querySelector('.dc-file-type').textContent, 'PDF')
        assert.equal(csv.getAttribute('download'), 'orders.csv', 'name falls back to the stored file name')
        // jsdom does not navigate; the test only reads the link the click leaves.
        pdf.addEventListener('click', (event) => event.preventDefault())
        pdf.click()
        assert.match(
            pdf.getAttribute('href'),
            /\/api\/v1\/get-upload-file\?chatflowId=.*&chatId=chat-f&fileName=harness_assets_1700000000000_0_q1-report\.pdf&download=true$/
        )
        assert.equal(t.$$('.dc-artifacts a[href^="https://elsewhere"]').length, 0, 'a file from outside the chat storage is not offered')
    })

    it('offers a download link under stored and data URL images only', async () => {
        const t = setup({
            predict: () =>
                sseResponse([
                    { event: 'token', data: 'Here is the chart.' },
                    {
                        event: 'artifacts',
                        data: [
                            { type: 'png', data: 'FILE-STORAGE::harness_assets_1700000000000_0_sales-chart.png' },
                            { type: 'jpeg', data: 'data:image/jpeg;base64,/9j/4AAQ', name: 'photo' },
                            { type: 'png', data: 'https://elsewhere.example/a.png' }
                        ]
                    },
                    { event: 'metadata', data: { chatId: 'chat-i', chatMessageId: 'm' } }
                ])
        })
        await type(t, 'Chart the sales')
        await until(() => t.$$('.dc-figure').length === 3 && !t.widget.busy)
        const links = t.$$('.dc-image-download')
        assert.equal(links.length, 2, 'an image from another site gets no download link')
        const [chart, photo] = links
        assert.equal(chart.getAttribute('download'), 'sales-chart.png')
        assert.equal(chart.querySelector('.dc-file-type').textContent, 'PNG')
        chart.addEventListener('click', (event) => event.preventDefault())
        chart.click()
        assert.match(chart.getAttribute('href'), /chatId=chat-i&fileName=harness_assets_1700000000000_0_sales-chart\.png&download=true$/)
        assert.equal(photo.getAttribute('download'), 'photo.jpg')
        assert.equal(photo.getAttribute('href'), 'data:image/jpeg;base64,/9j/4AAQ')
    })

    it('offers no download for a data URL that is not an image of the artifact type', async () => {
        const big = `data:image/png;base64,${'iVBORw0KGgo'.repeat(800)}AAAA`
        const t = setup({
            predict: () =>
                sseResponse([
                    { event: 'token', data: 'Charts.' },
                    {
                        event: 'artifacts',
                        data: [
                            { type: 'png', data: 'data:text/html;base64,PGgxPmhpPC9oMT4=' },
                            { type: 'png', data: 'data:image/svg+xml;base64,PHN2Zz4=' },
                            { type: 'jpeg', data: 'data:image/png;base64,iVBORw0KGgo=' },
                            { type: 'png', data: 'javascript:alert(1)' },
                            { type: 'png', data: big }
                        ]
                    },
                    { event: 'metadata', data: { chatId: 'chat-u', chatMessageId: 'm' } }
                ])
        })
        await type(t, 'Unsafe charts')
        await until(() => t.$$('.dc-figure').length === 5 && !t.widget.busy)
        const links = t.$$('.dc-image-download')
        assert.equal(links.length, 1, 'only the long PNG data URL is offered')
        assert.equal(links[0].getAttribute('href'), big)
        assert.equal(links[0].getAttribute('download'), 'image.png')
        assert.equal(t.$$('.dc-figure img')[4].getAttribute('src'), big, 'a long image data URL shows as it is')
        assert.equal(
            t.$$('.dc-artifacts a[href^="data:text"], .dc-artifacts a[href^="javascript"], .dc-artifacts a[href^="data:image/svg"]').length,
            0
        )
    })

    it('keeps the download link when a stored image cannot be shown', async () => {
        const t = setup({
            predict: () =>
                sseResponse([
                    { event: 'token', data: 'Chart.' },
                    { event: 'artifacts', data: [{ type: 'png', data: 'FILE-STORAGE::harness_assets_1_0_gone.png' }] },
                    { event: 'metadata', data: { chatId: 'chat-g', chatMessageId: 'm' } }
                ])
        })
        await type(t, 'Chart')
        await until(() => t.$('.dc-figure img') && !t.widget.busy)
        t.$('.dc-figure img').dispatchEvent(new window.Event('error'))
        await until(() => t.$('.dc-figure-missing'))
        assert.equal(t.$('.dc-figure .dc-image-download').getAttribute('download'), 'gone.png')
    })

    it('downloads a stored image with the session token when the chat has one', async () => {
        const t = setup({
            predict: () =>
                sseResponse([
                    { event: 'token', data: 'Chart ready.' },
                    { event: 'artifacts', data: [{ type: 'png', data: 'FILE-STORAGE::harness_assets_1_0_chart.png' }] },
                    { event: 'metadata', data: { chatId: 'chat-t', chatMessageId: 'm', sessionToken: 'tok-t' } }
                ]),
            file: () => new Response(new Blob([new Uint8Array([137, 80, 78, 71])]), { status: 200 })
        })
        await type(t, 'Chart it')
        await until(() => t.$('.dc-image-download') && !t.widget.busy)
        const saved = []
        const original = URL.createObjectURL
        const click = window.HTMLAnchorElement.prototype.click
        URL.createObjectURL = () => 'blob:chart'
        window.HTMLAnchorElement.prototype.click = function () {
            if (this.getAttribute('href') === 'blob:chart') return saved.push(this.getAttribute('download'))
            return click.call(this)
        }
        try {
            t.$('.dc-image-download').click()
            await until(() => saved.length === 1)
        } finally {
            URL.createObjectURL = original
            window.HTMLAnchorElement.prototype.click = click
        }
        assert.deepEqual(saved, ['chart.png'])
        const read = t.server.calls.find((c) => c.path === '/api/v1/get-upload-file' && /download=true$/.test(c.search))
        assert.equal(read.headers['x-cuttlely-session-token'], 'tok-t')
        assert.match(read.search, /chatId=chat-t&fileName=harness_assets_1_0_chart\.png&download=true$/)
    })

    it('downloads a file with the session token when the chat has one', async () => {
        const t = setup({
            predict: () =>
                sseResponse([
                    { event: 'token', data: 'The memo is ready.' },
                    { event: 'artifacts', data: [{ type: 'docx', data: 'FILE-STORAGE::harness_assets_1_0_memo.docx', name: 'memo.docx' }] },
                    { event: 'metadata', data: { chatId: 'chat-d', chatMessageId: 'm', sessionToken: 'tok-d' } }
                ]),
            file: () => new Response(new Blob([new Uint8Array([80, 75, 3, 4])]), { status: 200 })
        })
        await type(t, 'Write the memo')
        await until(() => t.$('.dc-file') && !t.widget.busy)
        const created = []
        const saved = []
        const original = URL.createObjectURL
        const click = window.HTMLAnchorElement.prototype.click
        URL.createObjectURL = (blob) => {
            created.push(blob)
            return 'blob:memo'
        }
        // The saved blob link is not followed in jsdom; record what it would save.
        window.HTMLAnchorElement.prototype.click = function () {
            if (this.getAttribute('href') === 'blob:memo') return saved.push(this.getAttribute('download'))
            return click.call(this)
        }
        try {
            t.$('.dc-file').click()
            await until(() => saved.length === 1)
        } finally {
            URL.createObjectURL = original
            window.HTMLAnchorElement.prototype.click = click
        }
        assert.equal(created.length, 1)
        assert.deepEqual(saved, ['memo.docx'])
        const read = t.server.calls.find((c) => c.path === '/api/v1/get-upload-file')
        assert.equal(read.headers['x-cuttlely-session-token'], 'tok-d')
        assert.match(read.search, /chatId=chat-d&fileName=harness_assets_1_0_memo\.docx&download=true$/)
    })

    it('retries a public chat file without the signed-in cookie when the first download is forbidden', async () => {
        const reads = []
        const t = setup({
            predict: () =>
                sseResponse([
                    { event: 'artifacts', data: [{ type: 'pdf', data: 'FILE-STORAGE::harness_assets_1_0_summary.pdf' }] },
                    { event: 'metadata', data: { chatId: 'public-chat', chatMessageId: 'm', sessionToken: 'public-token' } }
                ]),
            file: (_url, init) => {
                reads.push(init)
                return init.credentials === 'omit'
                    ? new Response(new Blob(['%PDF-1.4']), { status: 200 })
                    : json(403, { message: 'Forbidden' })
            }
        })
        await type(t, 'Save as PDF')
        await until(() => t.$('.dc-file') && !t.widget.busy)
        const saved = []
        const original = URL.createObjectURL
        const click = window.HTMLAnchorElement.prototype.click
        URL.createObjectURL = () => 'blob:summary'
        window.HTMLAnchorElement.prototype.click = function () {
            if (this.getAttribute('href') === 'blob:summary') return saved.push(this.getAttribute('download'))
            return click.call(this)
        }
        try {
            t.$('.dc-file').click()
            await until(() => saved.length === 1)
        } finally {
            URL.createObjectURL = original
            window.HTMLAnchorElement.prototype.click = click
        }
        assert.deepEqual(saved, ['summary.pdf'])
        assert.deepEqual(
            reads.map((init) => init.credentials),
            [undefined, 'omit']
        )
        assert(reads.every((init) => init.headers['x-cuttlely-session-token'] === 'public-token'))
        assert.equal(t.$('.dc-figure-missing'), null)
    })

    it('handles a JSON answer from a flow that does not stream', async () => {
        const t = setup({ predict: () => json(200, { text: 'Closed on Mondays.', chatId: 'c2', sessionToken: 't2', chatMessageId: 'm2' }) })
        await type(t, 'Open Monday?')
        await until(() => t.$('.dc-msg.bot .dc-md') && !t.widget.busy)
        assert.equal(t.$('.dc-msg.bot .dc-md').textContent, 'Closed on Mondays.')
        assert.equal(t.widget.sessionToken, 't2')
    })

    it('bubble mode opens and closes from the launcher and Escape', async () => {
        const t = setup({}, { mode: 'bubble' })
        await until(() => t.$('.dc-launcher'))
        const launcher = t.$('.dc-launcher')
        const panel = t.$('.dc-panel')
        assert.equal(panel.hidden, true)
        launcher.click()
        assert.equal(panel.hidden, false)
        assert.equal(launcher.getAttribute('aria-expanded'), 'true')
        panel.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        assert.equal(panel.hidden, true)
        assert.equal(launcher.getAttribute('aria-label'), 'Open chat')
    })

    it('applies saved colors but not the old stock defaults', async () => {
        const t = setup({
            config: () => json(200, { userMessage: { backgroundColor: '#3B81F6' }, textInput: { sendButtonColor: '#7a3b00' } })
        })
        await until(() => t.$('textarea'))
        const style = t.$('.dc').getAttribute('style')
        assert.match(style, /--dc-accent:#7a3b00/)
        assert.doesNotMatch(style, /--dc-user-bg/)
    })

    it('shows the attach button when the flow takes full file uploads and sends the file with the question', async () => {
        const t = setup({
            config: () => json(200, { uploads: { isFullFileUploadAllowed: true, fullFileUploadTypes: ['.pdf', '.txt'] } }),
            predict: () =>
                sseResponse([
                    { event: 'token', data: 'Read it.' },
                    { event: 'end', data: '[DONE]' }
                ])
        })
        await until(() => t.$('textarea'))
        const attach = t.$('.dc-attach')
        assert.ok(attach, 'attach button is shown')
        assert.equal(attach.getAttribute('aria-label'), 'Attach a file')
        assert.equal(t.$('input[type=file]').getAttribute('accept'), '.pdf,.txt')
        await t.widget.addFiles([new File(['made-up notes'], 'notes.txt', { type: 'text/plain' }), new File(['x'], 'run.exe')])
        assert.equal(t.$$('.dc-pending-item').length, 1)
        await t.widget.addFiles(['a', 'b', 'c', 'd'].map((n) => new File(['made-up'], `${n}.txt`, { type: 'text/plain' })))
        assert.equal(t.$$('.dc-pending-item').length, 4)
        assert.match(t.$('.dc-pending-note').textContent, /Up to 4 attachments per message\. d\.txt/)
        t.widget.pending.splice(1)
        t.widget.renderPending()
        await type(t, 'Summarize the file')
        await until(() => !t.widget.busy)
        const call = t.server.calls.find((c) => c.path.startsWith('/api/v1/prediction/'))
        assert.ok(call.body instanceof FormData)
        assert.deepEqual(
            call.body.getAll('files').map((file) => file.name),
            ['notes.txt']
        )
        assert.equal(call.body.get('question'), 'Summarize the file')
    })
})
