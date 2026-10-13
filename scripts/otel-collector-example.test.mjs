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
        assert.ok(guide.includes('`' + name + '`'), name)
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

const RECEIVER_PORTS = new Set([4317, 4318])

function sameDoc(left, right) {
    try {
        assert.deepEqual(left, right)
        return true
    } catch {
        return false
    }
}

function endpointPorts(endpoint) {
    const ports = []
    const pattern = /:(\d+)\b/g
    let match = pattern.exec(String(endpoint))
    while (match) {
        ports.push(Number(match[1]))
        match = pattern.exec(String(endpoint))
    }
    return ports
}

function exporterEndpoints(doc) {
    const found = []
    const walk = (node) => {
        if (!node || typeof node !== 'object') return
        if (typeof node.endpoint === 'string') found.push(node.endpoint)
        for (const value of Object.values(node)) walk(value)
    }
    walk(doc && doc.exporters)
    return found
}

test('recipe exporters do not send traces back to the example receiver ports', () => {
    const guide = fs.readFileSync(guidePath, 'utf8')
    const example = yaml.load(fs.readFileSync(examplePath, 'utf8'))
    const fences = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)]
    assert.ok(fences.length >= 2, 'the guide has no backend recipes')
    let recipes = 0
    for (const fence of fences) {
        const doc = yaml.load(fence[1])
        if (sameDoc(doc, example)) continue
        recipes += 1
        for (const endpoint of exporterEndpoints(doc)) {
            for (const port of endpointPorts(endpoint)) {
                assert.equal(RECEIVER_PORTS.has(port), false, endpoint)
            }
        }
    }
    assert.ok(recipes >= 3, 'expected Jaeger, Tempo, and Zipkin recipes')
    assert.match(guide, /localhost:14317/)
})

test('the Tempo recipe mounts a config that listens on every interface', () => {
    const guide = fs.readFileSync(guidePath, 'utf8')
    const tempo = yaml.load(fs.readFileSync(path.join(ROOT, 'examples', 'otel', 'tempo.yaml'), 'utf8'))
    assert.equal(tempo.storage.trace.backend, 'local')
    assert.equal(tempo.distributor.receivers.otlp.protocols.grpc.endpoint, '0.0.0.0:4317')
    const runs = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)].map((fence) => fence[1])
    const tempoRun = runs.find((block) => block.includes('grafana/tempo:'))
    assert.ok(tempoRun, 'the guide has no Tempo docker run')
    assert.match(tempoRun, /examples\/otel\/tempo\.yaml/)
    assert.match(tempoRun, /-config\.file=/)
    assert.match(tempoRun, /14317:4317/)
    assert.match(tempoRun, /grafana\/tempo:3\.1\.0/)
    const jaegerRun = runs.find((block) => block.includes('jaegertracing/jaeger:'))
    assert.ok(jaegerRun, 'the guide has no Jaeger docker run')
    assert.match(jaegerRun, /jaegertracing\/jaeger:2\.22\.0/)
    assert.match(jaegerRun, /14317:4317/)
    assert.match(guide, /otelcol` binary from release 0\.162\.0/)
    assert.match(guide, /includes the `zipkin` exporter/)
})

test('both compose files pass the trace variables from .env', () => {
    const names = [
        'CUTTLELY_OTEL_TRACES',
        'CUTTLELY_OTEL_TRACES_ENDPOINT',
        'CUTTLELY_OTEL_TRACES_PROTOCOL',
        'CUTTLELY_OTEL_TRACES_CONTENT',
        'METRICS_SERVICE_NAME'
    ]
    for (const file of ['docker-compose.yml', 'docker/docker-compose.yml']) {
        const doc = yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8'))
        const service = doc.services.cuttlely
        for (const name of names) {
            assert.equal(service.environment[name], '${' + name + ':-}', `${file} ${name}`)
        }
        assert.ok(service.extra_hosts.includes('host.docker.internal:host-gateway'), file)
    }
    const queue = yaml.load(fs.readFileSync(path.join(ROOT, 'docker/docker-compose-queue-source.yml'), 'utf8'))
    const passed = 'METRICS_SERVICE_NAME=${METRICS_SERVICE_NAME:-}'
    for (const serviceName of ['cuttlely', 'cuttlely-worker']) {
        assert.ok(queue.services[serviceName].environment.includes(passed), serviceName)
    }
    const example = fs.readFileSync(path.join(ROOT, 'docker/.env.example'), 'utf8')
    assert.match(example, /^# METRICS_SERVICE_NAME=cuttlely$/m)
})
