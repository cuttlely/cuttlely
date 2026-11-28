import { HarnessError } from '../errors.mjs'

const unsupported = () =>
    new HarnessError('native_unsupported', 'Use wc -c, wc -l, wc -lc, head or tail on one verified text upload. Request a short sample.')
const maxSampleBytes = 4096
const textPath = /^uploads\/[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}\.(?:csv|tsv|txt)$/i
const request = /^(wc -(?:l -c|c -l|lc|cl|c|l)|(?:head|tail)(?: -n (?:10|[1-9])| -(?:10|[1-9]))?) (.+)$/

// This is an immutable, per-turn text inspector. A path selects verified bytes in memory.
export function openUploadShell(context, role) {
    if (
        !context.checkRole ||
        context.replay ||
        !context.managedFileOwner ||
        role.shell !== true ||
        role.browser ||
        role.codeExecution ||
        role.fileAccess ||
        role.modules?.length ||
        role.mcpServers?.length ||
        role.playbooks?.length ||
        role.preset ||
        role.pinFirst ||
        role.trustedOutputs?.length
    )
        return null
    const paths = [...(context.checkedUploadFiles || [])].filter((source) => textPath.test(source))
    if (!paths.length) return null
    const verified = new Map()
    function parse(args) {
        if (
            !args ||
            typeof args !== 'object' ||
            Object.keys(args).some((key) => !['command', 'workdir'].includes(key)) ||
            (args.workdir !== undefined && !['.', ''].includes(args.workdir)) ||
            typeof args.command !== 'string' ||
            args.command.length > 320 ||
            /[\r\n]/.test(args.command)
        )
            throw unsupported()
        const match = request.exec(args.command)
        if (!match) throw unsupported()
        const source = paths.find((path) => [...(!path.includes(' ') ? [path] : []), '"' + path + '"', "'" + path + "'"].includes(match[2]))
        if (!source || !Object.hasOwn(context.managedUploads, source)) throw unsupported()
        return { operation: match[1], source }
    }
    function inspect({ operation, source }) {
        if (!verified.has(source)) {
            const body = Buffer.from(context.managedUploads[source], 'base64')
            let newlines = 0
            for (const byte of body) if (byte === 10) newlines++
            verified.set(source, { body, newlines })
        }
        const { body, newlines } = verified.get(source)
        if (operation.startsWith('wc')) {
            const flags = operation.slice(3)
            return [...(flags.includes('l') ? [newlines] : []), ...(flags.includes('c') ? [body.length] : []), source].join(' ')
        }
        const count = Number(operation.match(/\d+$/)?.[0] || 10)
        const fromStart = operation.startsWith('head')
        const lines = newlines + (body.length && body.at(-1) !== 10 ? 1 : 0)
        // The two windows never meet, even across repeated tool calls. A small upload may allow counts only.
        const maxLines = fromStart ? Math.ceil((lines - 1) / 2) : Math.floor((lines - 1) / 2)
        if (count > maxLines) throw unsupported()
        let start = 0,
            end = body.length
        if (fromStart) {
            end = 0
            for (let i = 0; i < count; i++) end = body.indexOf(10, end) + 1
        } else {
            let before = body.length - (body.at(-1) === 10 ? 1 : 0)
            for (let i = 0; i < count; i++) before = body.lastIndexOf(10, before - 1)
            start = before + 1
        }
        if (end - start > maxSampleBytes) throw unsupported()
        let output
        try {
            output = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body.subarray(start, end))
        } catch {
            throw unsupported()
        }
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(output)) throw unsupported()
        return output.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
    }
    function read(args) {
        context.workSignal?.throwIfAborted()
        context.assertNativeAuthority()
        return inspect(parse(args))
    }
    return {
        tool: {
            type: 'function',
            function: {
                name: 'terminal',
                description:
                    'Count bytes or newline characters with wc -c, -l or -lc. Use head or tail -n N to sample 1–10 lines, up to 4096 bytes, leaving the middle private. Supply one of these verified uploads: ' +
                    JSON.stringify(paths),
                parameters: {
                    type: 'object',
                    properties: { command: { type: 'string' }, workdir: { type: 'string', enum: ['.', ''] } },
                    required: ['command'],
                    additionalProperties: false
                }
            }
        },
        validate(args) {
            read(args)
        },
        execute(args) {
            const output = read(args)
            context.workSignal?.throwIfAborted()
            context.assertNativeAuthority()
            return JSON.stringify({ output, exit_code: 0, error: null })
        }
    }
}
