import { capTraceText, TRACE_CONTENT_MAX_DEFAULT, traceContentMax, writeContent } from './otelRunSpans'

const ENV = ['CUTTLELY_OTEL_TRACES', 'CUTTLELY_OTEL_TRACES_CONTENT', 'CUTTLELY_OTEL_TRACES_CONTENT_MAX']

function recordingSpan() {
    const attributes: Record<string, string | number | boolean> = {}
    return {
        attributes,
        setAttribute: (key: string, value: string | number | boolean) => {
            attributes[key] = value
        },
        setStatus: () => undefined,
        end: () => undefined
    }
}

describe('trace content limit', () => {
    const saved: Record<string, string | undefined> = {}

    beforeEach(() => {
        for (const key of ENV) {
            saved[key] = process.env[key]
            delete process.env[key]
        }
    })

    afterEach(() => {
        for (const key of ENV) {
            if (saved[key] === undefined) delete process.env[key]
            else process.env[key] = saved[key]
        }
    })

    it('keeps 4,000 characters when the setting is not set', () => {
        expect(TRACE_CONTENT_MAX_DEFAULT).toBe(4000)
        expect(traceContentMax()).toBe(4000)
        const long = 'a'.repeat(5000)
        expect(capTraceText(long)).toBe('a'.repeat(4000))
        expect(capTraceText('short')).toBe('short')
    })

    it('uses a custom limit', () => {
        process.env.CUTTLELY_OTEL_TRACES_CONTENT_MAX = '10'
        expect(traceContentMax()).toBe(10)
        expect(capTraceText('0123456789abcdef')).toBe('0123456789')
        process.env.CUTTLELY_OTEL_TRACES_CONTENT_MAX = ' 20000 '
        expect(traceContentMax()).toBe(20000)
        expect(capTraceText('b'.repeat(25000))).toHaveLength(20000)
    })

    it('cuts nothing with 0, the no-limit value', () => {
        process.env.CUTTLELY_OTEL_TRACES_CONTENT_MAX = '0'
        expect(traceContentMax()).toBe(0)
        const long = 'c'.repeat(250000)
        expect(capTraceText(long)).toBe(long)
    })

    it('falls back to 4,000 for a value that is not a whole number', () => {
        for (const bad of ['', '  ', '-1', '1.5', '1e6', 'unlimited', 'lots', '99999999999999999999']) {
            process.env.CUTTLELY_OTEL_TRACES_CONTENT_MAX = bad
            expect(traceContentMax()).toBe(4000)
            expect(capTraceText('d'.repeat(4001))).toHaveLength(4000)
        }
    })

    it('writes the full question and answer to the span with no limit', () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT_MAX = '0'
        const question = 'How many loaves? '.repeat(1000)
        const answer = 'Two loaves. '.repeat(2000)
        const span = recordingSpan()
        writeContent(span, question, answer)
        expect(span.attributes['content.input']).toBe(question.trim())
        expect(span.attributes['content.output']).toBe(answer.trim())

        delete process.env.CUTTLELY_OTEL_TRACES_CONTENT_MAX
        const capped = recordingSpan()
        writeContent(capped, question, answer)
        expect(capped.attributes['content.input']).toBe(question.trim().slice(0, 4000))
        expect(capped.attributes['content.output']).toBe(answer.trim().slice(0, 4000))
    })
})
