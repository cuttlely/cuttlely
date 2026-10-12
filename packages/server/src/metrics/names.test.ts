import { metricName, nodeMetricsPrefix } from './names'

const BASES = [
    'chatflow_created',
    'agentflow_created',
    'assistant_created',
    'tool_created',
    'vector_upserted',
    'chatflow_prediction_internal',
    'chatflow_prediction_external',
    'agentflow_prediction_internal',
    'agentflow_prediction_external',
    'custom_mcp_server_created',
    'flowise_version_info',
    'flowise_version',
    'http_request_duration_ms',
    'http_requests_total'
]

describe('metric names', () => {
    const previous = process.env.METRICS_PREFIX

    afterEach(() => {
        if (previous === undefined) delete process.env.METRICS_PREFIX
        else process.env.METRICS_PREFIX = previous
    })

    it('leaves every published name unchanged when METRICS_PREFIX is unset or empty', () => {
        delete process.env.METRICS_PREFIX
        expect(nodeMetricsPrefix()).toBe('flowise_')
        for (const base of BASES) expect(metricName(base)).toBe(base)
        process.env.METRICS_PREFIX = ''
        expect(nodeMetricsPrefix()).toBe('flowise_')
        for (const base of BASES) expect(metricName(base)).toBe(base)
    })

    it('applies a set prefix, replacing the historical node prefix', () => {
        process.env.METRICS_PREFIX = 'acme_'
        expect(nodeMetricsPrefix()).toBe('acme_')
        expect(metricName('chatflow_created')).toBe('acme_chatflow_created')
        expect(metricName('flowise_version_info')).toBe('acme_version_info')
        expect(metricName('http_requests_total')).toBe('acme_http_requests_total')
    })
})
