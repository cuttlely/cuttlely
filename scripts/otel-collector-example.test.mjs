// The run-traces guide points at examples/otel/collector.yaml. This parses that file
// and checks every variable and attribute the guide names is set somewhere in the server.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const examplePath = path.join(ROOT, 'examples', 'otel', 'collector.yaml')
const guidePath = path.join(ROOT, 'docs', 'how-to', 'observability.md')

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

test('the example collector config parses and receives traces on the local OTLP ports', () => {
    const text = fs.readFileSync(examplePath, 'utf8')
    const doc = yaml.load(text)
    assert.equal(typeof doc, 'object')
    assert.equal(doc.receivers.otlp.protocols.http.endpoint, '0.0.0.0:4318')
    assert.equal(doc.receivers.otlp.protocols.grpc.endpoint, '0.0.0.0:4317')
    assert.equal(doc.exporters.debug.verbosity, 'detailed')
    assert.deepEqual(doc.service.pipelines.traces.receivers, ['otlp'])
    assert.deepEqual(doc.service.pipelines.traces.exporters, ['debug'])
    assert.equal(doc.service.pipelines.metrics, undefined)
    assert.doesNotMatch(text, /api[_-]?key|authorization|secret|password|token/i)
})

test('the guide uses that file and names only attributes the server sets', () => {
    const guide = fs.readFileSync(guidePath, 'utf8')
    const fence = guide.match(/```yaml\n([\s\S]*?)```/)
    assert.ok(fence, 'the guide has no collector yaml')
    const fromGuide = yaml.load(fence[1])
    const fromFile = yaml.load(fs.readFileSync(examplePath, 'utf8'))
    assert.deepEqual(fromGuide, fromFile)
    assert.match(guide, /examples\/otel\/collector\.yaml/)
    assert.ok(read('docs/README.md').includes('how-to/observability.md'), 'docs index')
    assert.ok(read('docs/how-to/docker.md').includes('./observability.md'), 'docker guide')

    const sources = [
        read('packages/server/src/metrics/tracing.ts'),
        read('packages/components/src/otelRunSpans.ts'),
        read('packages/server/src/settings/registry.ts'),
        read('packages/server/src/metrics/OpenTelemetry.ts'),
        read('packages/server/src/index.ts')
    ].join('\n')

    const attributes = [
        'flow.id',
        'flow.kind',
        'status',
        'error',
        'node.id',
        'node.type',
        'model.name',
        'tokens.input',
        'tokens.output',
        'tokens.total.input',
        'tokens.total.output',
        'tool.name',
        'tool.id',
        'tool.rows',
        'harness.name',
        'workspace.id',
        'run.id',
        'specialist.name',
        'content.input',
        'content.output'
    ]
    for (const name of attributes) {
        assert.match(guide, new RegExp('`' + name.replace(/\./g, '\\.') + '`'), name)
        assert.ok(sources.includes("'" + name + "'"), name + ' is not set in the server')
    }

    const variables = [
        'CUTTLELY_OTEL_TRACES',
        'CUTTLELY_OTEL_TRACES_ENDPOINT',
        'CUTTLELY_OTEL_TRACES_PROTOCOL',
        'CUTTLELY_OTEL_TRACES_CONTENT',
        'METRICS_SERVICE_NAME',
        'ENABLE_METRICS',
        'METRICS_PROVIDER',
        'METRICS_OPEN_TELEMETRY_METRIC_ENDPOINT',
        'METRICS_OPEN_TELEMETRY_PROTOCOL',
        'METRICS_PREFIX'
    ]
    for (const name of variables) {
        assert.ok(guide.includes('`' + name + '`'), name)
        assert.ok(sources.includes("'" + name + "'") || sources.includes(name), name + ' is not a server setting')
    }

    assert.match(guide, /CUTTLELY_HARNESS_QUEUE=external/)
    assert.match(guide, /do not carry `node\.id` or `node\.type`/)
})
