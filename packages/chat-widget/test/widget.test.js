import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fakeServer, installDom, json, sseResponse, until } from './dom.js'

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
                            { type: 'xlsx', data: 'https://elsewhere.example/table.xlsx', name: 'table.xlsx' }
                        ]
                    },
                    { event: 'metadata', data: { chatId: 'chat-f', chatMessageId: 'm' } }
                ])
        })
        await type(t, 'Quarterly report')
        await until(() => t.$$('.dc-file').length === 2 && !t.widget.busy)
        const [pdf, csv] = t.$$('.dc-file')
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
})
