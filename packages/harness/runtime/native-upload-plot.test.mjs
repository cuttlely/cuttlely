import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { openUploadPlot } from './native-upload-plot.mjs'

const require = createRequire(import.meta.url)
const source = 'uploads/sales.csv'
const mixed = { name: 'assets', fileAccess: true, codeExecution: true, shell: true, browser: true }
const code = { ...mixed, shell: false, browser: false }
const bar = 'Create a bar chart of "Net" by "Region" from the attached CSV.'
const line = '/plot_csv {"kind":"line","x":"Region","y":"Net"}'
const data = 'Region,Net\nA,-30\nB,53\nC,100\nD,0\n'
function turn(question, csv = data) {
    return {
        checkRole() {},
        managedFileOwner: 'test-owner',
        sampleInputs: new Set([source]),
        managedUploads: { [source]: Buffer.from(csv).toString('base64') },
        moduleOptions: { nativeSourceTurn: { question } },
        reportUpload: { source, proof: { length: question.length, hash: createHash('sha256').update(question).digest('hex') } },
        assertNativeAuthority() {}
    }
}
function args(tool) {
    return { code: tool.tool.function.description.split('code argument:\n')[1] }
}

test('the saved code role draws a requested CSV bar or line from ordered rows and returns a real PNG', async () => {
    const { loadImage, createCanvas } = require('@napi-rs/canvas')
    for (const [question, role] of [
        [bar, code],
        [line, mixed]
    ]) {
        const context = turn(question),
            tool = openUploadPlot(context, role),
            input = args(tool)
        assert.ok(input.code.includes(question === bar ? 'ax.bar(' : 'ax.plot('))
        const reply = JSON.parse(await tool.execute(input))
        assert.equal(reply.status, 'success')
        assert.equal(reply.output, '')
        assert.equal(reply.tool_calls_made, 0)
        assert.equal(JSON.parse(await tool.execute({ ...input, reset: false })).status, 'success')
        const { artifact, text } = tool.finish()
        assert.equal(artifact.name, 'chart.png')
        assert.equal(artifact.specialist, role.name)
        assert.match(text, /4 uploaded CSV rows/)
        const png = await loadImage(Buffer.from(artifact.base64, 'base64'))
        assert.equal(png.width, 1024)
        assert.equal(png.height, 480)
        const canvas = createCanvas(png.width, png.height),
            ctx = canvas.getContext('2d')
        ctx.drawImage(png, 0, 0)
        const colored = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3).join(',') === '35,116,151'
        // The second plotted point is 53 on a scale from -30 to 100.
        assert.ok(colored(431, 160) || colored(431, 161))
        assert.equal(colored(431, 175), question === bar)
        if (question === line) assert.ok(colored(544, 103) || colored(544, 104))
    }
})

test('chart scope requires the original question, current single upload and complete saved grants', () => {
    for (const role of [
        { ...mixed, fileAccess: false },
        { ...mixed, codeExecution: false },
        { ...mixed, browser: false },
        { ...mixed, modules: [{}] },
        { ...mixed, trustedOutputs: [{}] }
    ])
        assert.equal(openUploadPlot(turn(bar), role), undefined)
    const modifications = [
        (c) => {
            delete c.reportUpload
        },
        (c) => {
            delete c.checkRole
        },
        (c) => {
            c.replay = true
        },
        (c) => {
            delete c.managedFileOwner
        },
        (c) => {
            c.sampleInputs.clear()
        },
        (c) => {
            c.moduleOptions.nativeSourceTurn.question = line
        }
    ]
    for (const modify of modifications) {
        const c = turn(bar)
        modify(c)
        assert.equal(openUploadPlot(c, code), undefined)
    }
    for (const question of [
        bar + ' Also browse the web.',
        '/plot_csv {"kind":"barh","x":"Region","y":"Net"}',
        '/plot_csv {"kind":"line","x":"Region","y":"Region"}',
        '/plot_csv {"kind":"bar","x":"Region","y":"Net","file":"other.png"}'
    ])
        assert.equal(openUploadPlot(turn(question), mixed), undefined)
})

test('other code, axes, files, output types and styling fail before a receipt or chart is available', () => {
    const tool = openUploadPlot(turn(bar), mixed),
        approved = args(tool)
    for (const c of [
        approved.code + '\nprint(1)',
        approved.code.replace('sales.csv', 'other.csv'),
        approved.code.replace('ax.bar', 'ax.barh'),
        approved.code.replace('chart.png', 'other.png'),
        approved.code.replace('ax.set_xlabel', 'ax.set_title')
    ])
        assert.throws(() => tool.validate({ code: c }), { code: 'native_unsupported' })
    assert.throws(() => tool.validate({ ...approved, reset: true }), { code: 'native_unsupported' })
    assert.throws(() => tool.finish(), { code: 'empty_output' })
})
test('malformed or over-limit chart data cannot deliver partial graphics', async () => {
    for (const bad of [
        data.replace('C,100', 'C,NaN'),
        data.replace('B,53', 'A,53'),
        data.replace('Net', 'Other'),
        data.replace('D,0', 'D,0,extra'),
        'Region,Net\nA,2\n',
        'Region,Net\n' + Array.from({ length: 33 }, (_, i) => i + ',' + i).join('\n')
    ]) {
        const tool = openUploadPlot(turn(line, bad), code)
        await assert.rejects(tool.execute(args(tool)), { code: 'invalid_report' })
        assert.throws(() => tool.finish(), { code: 'empty_output' })
    }
})
test('cancelled and revoked publication refuse completed staged bytes', async () => {
    for (const change of [
        (c) => {
            c.workSignal = AbortSignal.abort()
        },
        (c) => {
            c.assertNativeAuthority = () => {
                throw new Error('publication changed')
            }
        }
    ]) {
        const c = turn(bar),
            tool = openUploadPlot(c, mixed)
        await tool.execute(args(tool))
        change(c)
        assert.throws(() => tool.finish())
    }
})

test('the original signed title and fitted label margins affect the rendered PNG', async () => {
    const { loadImage, createCanvas } = require('@napi-rs/canvas')
    const title = 'November forecast "A"'
    const request = (extra = {}) => '/plot_csv ' + JSON.stringify({ kind: 'bar', x: 'Region', y: 'Net', ...extra })
    const c = turn(request({ layout: 'tight', title }))
    const tool = openUploadPlot(c, mixed),
        input = args(tool)
    assert.ok(input.code.includes('fig.tight_layout()'))
    assert.ok(input.code.includes('fontsize=14, fontweight="bold", loc="left"'))
    assert.throws(() => tool.validate({ code: input.code.replace('November forecast', 'Other title') }), { code: 'native_unsupported' })
    assert.throws(() => tool.validate({ code: input.code.replace('fig.tight_layout()', 'fig.tight_layout(pad=20)') }), {
        code: 'native_unsupported'
    })
    await tool.execute(input)
    const result = await loadImage(Buffer.from(tool.finish().artifact.base64, 'base64'))
    const canvas = createCanvas(1024, 480),
        ctx = canvas.getContext('2d')
    ctx.drawImage(result, 0, 0)
    const expected = createCanvas(1024, 480).getContext('2d')
    expected.fillStyle = 'white'
    expected.fillRect(0, 0, 1024, 480)
    expected.font = '14px sans-serif'
    const margin = Math.ceil(Math.max(...['-30', '100'].map((x) => expected.measureText(x).width))) + 24
    expected.font = 'bold 19px sans-serif'
    expected.fillStyle = '#27374a'
    expected.fillText(title, margin, 25)
    const actualTitle = ctx.getImageData(0, 0, 1024, 31).data,
        want = expected.getImageData(0, 0, 1024, 31).data
    assert.ok(want.some((v) => v < 200))
    assert.deepEqual(actualTitle, want)
    const styled = openUploadPlot(turn(request({ title })), mixed)
    await styled.execute(args(styled))
    assert.notEqual(styled.finish().artifact.base64, tool.finish().artifact.base64)
    for (const bad of [
        { title: '' },
        { title: 'x'.repeat(81) },
        { title: ['x'] },
        { layout: 'outside' },
        { title: 'hidden\u202Etitle' },
        { format: 'svg' }
    ])
        assert.equal(openUploadPlot(turn(request(bad)), mixed), undefined)
})
