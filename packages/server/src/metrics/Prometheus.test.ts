jest.mock('flowise-components', () => ({
    getVersion: async () => ({ version: '1.0.2' })
}))

import { Prometheus } from './Prometheus'

function metricNames(text: string): string[] {
    const names = new Set<string>()
    for (const line of text.split('\n')) {
        const documented = line.match(/^# (?:HELP|TYPE) (\S+)/)
        if (documented) {
            names.add(documented[1])
            continue
        }
        if (!line || line.startsWith('#')) continue
        const name = line.split('{')[0].split(' ')[0]
        if (name) names.add(name)
    }
    return [...names].sort()
}

describe('Prometheus metric names', () => {
    const previous = process.env.METRICS_PREFIX

    afterEach(() => {
        if (previous === undefined) delete process.env.METRICS_PREFIX
        else process.env.METRICS_PREFIX = previous
    })

    async function published(prefix?: string): Promise<string[]> {
        if (prefix === undefined) delete process.env.METRICS_PREFIX
        else process.env.METRICS_PREFIX = prefix
        const app = { use: () => undefined } as any
        const provider = new Prometheus(app)
        await provider.initializeCounters()
        const text = await (provider as any).register.metrics()
        return metricNames(text)
    }

    it('matches today when METRICS_PREFIX is unset', async () => {
        const names = await published()
        for (const name of [
            'chatflow_created',
            'vector_upserted',
            'flowise_version_info',
            'http_request_duration_ms',
            'http_requests_total'
        ]) {
            expect(names).toContain(name)
        }
        const nodeMetrics = names.filter((name) => name.startsWith('flowise_process_') || name.startsWith('flowise_nodejs_'))
        expect(nodeMetrics.length).toBeGreaterThan(0)
        expect(names.some((name) => name.startsWith('acme_'))).toBe(false)
    })

    it('uses METRICS_PREFIX when it is set', async () => {
        const names = await published('acme_')
        expect(names).toContain('acme_chatflow_created')
        expect(names).toContain('acme_version_info')
        expect(names).toContain('acme_http_requests_total')
        expect(names).not.toContain('chatflow_created')
        expect(names).not.toContain('flowise_version_info')
        expect(names.some((name) => name.startsWith('acme_process_') || name.startsWith('acme_nodejs_'))).toBe(true)
        expect(names.some((name) => name.startsWith('flowise_'))).toBe(false)
    })
})
