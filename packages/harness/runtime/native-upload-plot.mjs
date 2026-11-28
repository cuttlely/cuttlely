import { createRequire } from 'node:module'
import { HarnessError } from '../errors.mjs'
import { resultPacket } from './native-numeric-code.mjs'
import { TURN_IMAGE_LIMITS } from '../images.mjs'
import { csvRecords, originalUploadQuestion, visibleLabel } from './native-tabular-report.mjs'

const require = createRequire(import.meta.url)
const column = /^[^"\\\x00-\x1f\x7f]{1,80}$/u
const maxRows = 32
const pngName = 'chart.png'
const imageWidth = 1024
const imageHeight = 480

export function requestedUploadPlot(context, role) {
    if (
        !context.checkRole ||
        context.replay ||
        !context.managedFileOwner ||
        role.fileAccess !== true ||
        role.codeExecution !== true ||
        !((!role.browser && !role.shell) || (role.browser === true && role.shell === true)) ||
        role.pinFirst ||
        role.trustedOutputs?.length ||
        role.modules?.length ||
        role.mcpServers?.length
    )
        return
    const source = context.reportUpload?.source
    if (!source || !context.sampleInputs?.has(source) || !/^uploads\/[a-zA-Z0-9][\w .()-]{0,100}\.csv$/i.test(source)) return
    const text = originalUploadQuestion(context.reportUpload.proof, context.moduleOptions.nativeSourceTurn?.question)
    if (!text) return
    let spec
    if (text.startsWith('/plot_csv ')) {
        try {
            spec = JSON.parse(text.slice(10))
        } catch {
            return
        }
    } else {
        const match =
            /^(?:create|make|generate) a (bar|line) chart of "([^"]+)" by "([^"]+)" from (?:the |my |this )?(?:attached|uploaded) CSV[.!]?$/i.exec(
                text
            )
        if (match) spec = { kind: match[1].toLowerCase(), x: match[3], y: match[2] }
    }
    if (
        !spec ||
        typeof spec !== 'object' ||
        Object.keys(spec).some((k) => !['kind', 'x', 'y', 'title', 'layout'].includes(k)) ||
        (Object.hasOwn(spec, 'layout') && spec.layout !== 'tight') ||
        (Object.hasOwn(spec, 'title') &&
            (typeof spec.title !== 'string' ||
                !spec.title.trim() ||
                spec.title.length > 80 ||
                /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(spec.title))) ||
        !['bar', 'line'].includes(spec.kind) ||
        !['x', 'y'].every((k) => typeof spec[k] === 'string' && column.test(spec[k]) && spec[k].trim()) ||
        spec.x === spec.y
    )
        return
    return {
        source,
        kind: spec.kind,
        x: spec.x,
        y: spec.y,
        ...(spec.title && { title: spec.title }),
        ...(spec.layout && { layout: spec.layout })
    }
}

// This template describes the approved data operation to a released execute_code caller.
// The source is compared as data. No part of it is evaluated or sent to an interpreter.
function program({ source, kind, x, y, title, layout }) {
    const quote = JSON.stringify
    return [
        'import csv',
        'import matplotlib.pyplot as plt',
        'with open(' + quote(source) + ', newline="") as f:',
        '    rows = list(csv.DictReader(f))',
        'labels = [r[' + quote(x) + '] for r in rows]',
        'values = [float(r[' + quote(y) + ']) for r in rows]',
        'fig, ax = plt.subplots()',
        'ax.' + (kind === 'line' ? 'plot' : 'bar') + '(labels, values)',
        'ax.set_xlabel(' + quote(x) + ')',
        'ax.set_ylabel(' + quote(y) + ')',
        ...(title ? ['ax.set_title(' + quote(title) + ', color="#27374a", fontsize=14, fontweight="bold", loc="left")'] : []),
        ...(layout === 'tight' ? ['fig.tight_layout()'] : []),
        'fig.savefig("chart.png", format="png")',
        'plt.close(fig)'
    ].join('\n')
}

function invalid() {
    throw new HarnessError(
        'invalid_report',
        'Choose distinct existing CSV columns with 1–32 unique category labels and finite numeric values. Line charts need at least two rows.'
    )
}

function points(bytes, spec) {
    const records = csvRecords(bytes)
    const headers = records.next().value
    if (
        !headers?.length ||
        headers.length > 128 ||
        new Set(headers).size !== headers.length ||
        headers.some((h) => !h.trim() || h.length > 120)
    )
        invalid()
    const x = headers.indexOf(spec.x),
        y = headers.indexOf(spec.y)
    if (x < 0 || y < 0) invalid()
    const seen = new Set(),
        rows = []
    for (const row of records) {
        if (rows.length >= maxRows || row.length !== headers.length) invalid()
        const label = row[x],
            cell = row[y].trim()
        if (!label.trim() || label.length > 80 || seen.has(label) || !/^[+-]?(?:\d{1,12}(?:\.\d{1,8})?|\.\d{1,8})$/.test(cell)) invalid()
        seen.add(label)
        rows.push({ label, value: Number(cell) })
    }
    if (rows.length < (spec.kind === 'line' ? 2 : 1)) invalid()
    return rows
}

async function draw(rows, spec) {
    const { createCanvas } = require('@napi-rs/canvas')
    const canvas = createCanvas(imageWidth, imageHeight),
        ctx = canvas.getContext('2d')
    const values = rows.map((r) => r.value)
    const low = Math.min(0, ...values),
        high = Math.max(0, ...values) || (low === 0 ? 1 : 0)
    ctx.font = '14px sans-serif'
    const tight = spec.layout === 'tight'
    const left = tight ? Math.ceil(Math.max(ctx.measureText(String(low)).width, ctx.measureText(String(high)).width)) + 24 : 92
    const right = imageWidth - (tight ? 20 : 28)
    const top = (tight ? 40 : 46) + (spec.title ? 30 : 0)
    // Rotate category labels. Allocate the longest measured width vertically with a cap
    // that leaves enough pixels to distinguish the actual series.
    const labelRoom = tight ? Math.ceil(Math.min(140, Math.max(22, ...rows.map((r) => ctx.measureText(visibleLabel(r.label)).width)))) : 78
    const bottom = tight ? imageHeight - 48 - labelRoom : 362
    const y = (value) => bottom - ((value - low) / (high - low)) * (bottom - top)
    const step = (right - left) / rows.length
    const x = (index) => left + (index + 0.5) * step
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, imageWidth, imageHeight)
    ctx.strokeStyle = '#657183'
    ctx.beginPath()
    ctx.moveTo(left, top)
    ctx.lineTo(left, bottom)
    ctx.moveTo(left, y(0))
    ctx.lineTo(right, y(0))
    ctx.stroke()
    ctx.font = '14px sans-serif'
    ctx.fillStyle = '#27374a'
    ctx.textAlign = 'right'
    ctx.fillText(String(high), left - 8, top + 5, left - 12)
    ctx.fillText(String(low), left - 8, bottom + 5, left - 12)
    if (spec.title) {
        ctx.font = 'bold 19px sans-serif'
        ctx.textAlign = 'left'
        ctx.fillText(spec.title, left, 25, right - left)
        ctx.font = '14px sans-serif'
    }
    ctx.textAlign = 'center'
    ctx.fillText(visibleLabel(spec.y), imageWidth / 2, spec.title ? 54 : 26, imageWidth - 32)
    ctx.fillText(visibleLabel(spec.x), imageWidth / 2, imageHeight - 8, imageWidth - 32)
    rows.forEach(({ label }, i) => {
        ctx.save()
        ctx.translate(x(i), bottom + 12)
        ctx.rotate(-Math.PI / 2)
        ctx.textAlign = 'right'
        ctx.fillText(visibleLabel(label), 0, 4, labelRoom)
        ctx.restore()
    })
    ctx.fillStyle = ctx.strokeStyle = '#237497'
    ctx.lineWidth = 3
    if (spec.kind === 'bar') {
        rows.forEach(({ value }, i) => ctx.fillRect(x(i) - step * 0.36, Math.min(y(value), y(0)), step * 0.72, Math.abs(y(value) - y(0))))
    } else {
        ctx.beginPath()
        rows.forEach(({ value }, i) => {
            if (i) ctx.lineTo(x(i), y(value))
            else ctx.moveTo(x(i), y(value))
        })
        ctx.stroke()
    }
    return canvas.encode('png')
}

export function openUploadPlot(context, role) {
    const spec = requestedUploadPlot(context, role)
    if (!spec) return
    const code = program(spec)
    const approved = new Set([code, code.replace('fig.savefig("chart.png", format="png")', 'fig.savefig("chart.png")')])
    const check = () => {
        context.workSignal?.throwIfAborted()
        context.assertNativeAuthority()
    }
    function validate(args) {
        check()
        if (
            !args ||
            Array.isArray(args) ||
            typeof args !== 'object' ||
            Object.keys(args).some((k) => !['code', 'reset'].includes(k)) ||
            (Object.hasOwn(args, 'reset') && args.reset !== false) ||
            typeof args.code !== 'string' ||
            args.code.length > 2048 ||
            !approved.has(args.code.replaceAll('\r\n', '\n').trimEnd())
        )
            throw new HarnessError('native_unsupported', 'Use the exact uploaded CSV chart operation shown in the tool description.')
    }
    let pending, artifact, text
    async function render() {
        const input = context.managedUploads?.[spec.source]
        if (!context.sampleInputs?.has(spec.source) || typeof input !== 'string' || input.length > Math.ceil((4 * 1024 * 1024) / 3) * 4)
            throw new HarnessError('upload_changed', 'The original chart upload is unavailable. Send the file again.', 409)
        const rows = points(Buffer.from(input, 'base64'), spec)
        const png = await draw(rows, spec)
        check()
        if (png.length > TURN_IMAGE_LIMITS.bytes) throw new HarnessError('invalid_report', 'The chart exceeds the attachment limit.')
        artifact = {
            name: pngName,
            type: 'png',
            mime: 'image/png',
            base64: png.toString('base64'),
            specialist: role.name,
            mtime: Date.now()
        }
        text = 'Created a ' + spec.kind + ' chart from ' + rows.length + ' uploaded CSV rows in file order. Download ' + pngName + '.'
    }
    return {
        tool: {
            type: 'function',
            function: {
                name: 'execute_code',
                description:
                    'Draw the exact caller-approved uploaded CSV chart. Supply this complete fixed program as the code argument:\n' + code,
                parameters: {
                    type: 'object',
                    properties: { code: { type: 'string' }, reset: { type: 'boolean', enum: [false] } },
                    required: ['code'],
                    additionalProperties: false
                }
            }
        },
        validate,
        async execute(args) {
            validate(args)
            const start = performance.now()
            await (pending ||= render())
            check()
            return resultPacket(start, '')
        },
        finish() {
            check()
            if (!artifact) throw new HarnessError('empty_output', 'The selected specialist did not produce the requested chart.')
            return { artifact, text }
        }
    }
}
