import { HarnessError } from '../errors.mjs'

const sourceLimit = 8192
const itemLimit = 128
const digitsLimit = 64
const usage =
    'Use print(operation([integer, ...])), where operation is sum, len, min, max, or sorted. Supply up to 128 signed decimal integers, 64 digits per integer, and 8192 source characters. Each call is stateless.'
const form = /^print[ \t]*\([ \t]*(sum|len|min|max|sorted)[ \t]*\([ \t]*\[([\d,+\- \t]*)\][ \t]*\)[ \t]*\)[ \t]*(?:\r?\n)?$/
const integer = /^[+-]?(?:0|[1-9]\d*)$/

function unsupported() {
    throw new HarnessError('native_unsupported', 'The native numeric tool accepts bounded operations on a literal integer list. ' + usage)
}

// Parse one literal-list form. BigInt keeps the integer result exact at the documented size limit.
function parseCollection(name, args) {
    if (name !== 'execute_code' || !args || typeof args !== 'object' || Array.isArray(args)) unsupported()
    if (Object.keys(args).some((key) => key !== 'code' && key !== 'reset') || (Object.hasOwn(args, 'reset') && args.reset !== false))
        unsupported()
    if (typeof args.code !== 'string' || args.code.length > sourceLimit) unsupported()
    const match = form.exec(args.code)
    if (!match || match[0] !== args.code) unsupported()
    const operation = match[1]
    const body = match[2].trim()
    if (!body) return { operation, values: [] }
    const items = body.split(',')
    if (!items.at(-1).trim()) items.pop()
    if (items.length > itemLimit) unsupported()
    const values = []
    for (const item of items) {
        const literal = item.trim()
        if (!integer.test(literal) || literal.replace(/^[+-]/, '').length > digitsLimit) unsupported()
        values.push(BigInt(literal))
    }
    return { operation, values }
}

function calculate({ operation, values }) {
    if (!values.length && (operation === 'min' || operation === 'max'))
        return { error: `ValueError: ${operation}() iterable argument is empty` }
    switch (operation) {
        case 'sum':
            return { value: values.reduce((a, b) => a + b, 0n) }
        case 'len':
            return { value: values.length }
        case 'min':
            return { value: values.reduce((a, b) => (a < b ? a : b)) }
        case 'max':
            return { value: values.reduce((a, b) => (a > b ? a : b)) }
        case 'sorted':
            values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            return { value: '[' + values.join(', ') + ']' }
    }
}

export function openNativeNumericCode(specialist, rolePolicy) {
    if (rolePolicy !== 'on-demand' || specialist?.codeExecution !== true || specialist.shell || specialist.browser) return null
    return {
        tools: [
            {
                type: 'function',
                function: {
                    name: 'execute_code',
                    description: usage,
                    parameters: {
                        type: 'object',
                        properties: {
                            code: {
                                type: 'string',
                                maxLength: sourceLimit,
                                description: 'One supported operation on a literal integer list.'
                            },
                            reset: {
                                type: 'boolean',
                                enum: [false],
                                description: 'Optional. The numeric tool has no persistent kernel.'
                            }
                        },
                        additionalProperties: false,
                        required: ['code']
                    }
                }
            }
        ],
        validate(name, args) {
            parseCollection(name, args)
        },
        execute(name, args) {
            const start = performance.now()
            const { value, error } = calculate(parseCollection(name, args))
            const output = error ? '\n--- stderr ---\n' + error : String(value) + '\n'
            const bytes = error ? 0 : Buffer.byteLength(output)
            return JSON.stringify({
                status: error ? 'error' : 'success',
                ...(error && { error }),
                output,
                exit_code: error ? 1 : 0,
                tool_calls_made: 0,
                duration_seconds: Math.round((performance.now() - start) / 10) / 100,
                kernel: {
                    mode: 'stateless',
                    reused: false,
                    execution_count: 1,
                    state_reset: false
                },
                stdout_truncated: false,
                stdout_bytes_captured: bytes,
                stdout_bytes_total: bytes,
                stdout_bytes_omitted: 0
            })
        }
    }
}
