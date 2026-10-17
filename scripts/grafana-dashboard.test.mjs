// metrics/grafana/cuttlely-runs.json is the dashboard the run-traces guide points at.
// Names are read from where the server emits them: span starts, attribute setters, and metric registrations.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DASHBOARD = 'metrics/grafana/cuttlely-runs.json'

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

const dashboard = JSON.parse(read(DASHBOARD))
const panels = dashboard.panels.filter((panel) => panel.type !== 'row')
const targets = panels.flatMap((panel) => panel.targets.map((target) => ({ panel, target })))
const tempoTargets = targets.filter(({ target }) => target.datasource.type === 'tempo')
const promTargets = targets.filter(({ target }) => target.datasource.type === 'prometheus')
const variables = dashboard.templating.list

function all(text, pattern, group = 1) {
    return [...text.matchAll(pattern)].map((match) => match[group])
}

function emittedSpans(sources) {
    const names = new Set()
    const attributes = new Set()
    for (const source of sources) {
        for (const first of all(source, /\.startSpan\(([^{]*?),\s*\{/g)) {
            for (const name of all(first, /'([^']+)'/g)) names.add(name)
        }
        for (const name of all(source, /(?:startChild|this\.child|openChild)\(\s*'([^']+)'/g)) names.add(name)
        for (const key of all(source, /\.setAttribute\(\s*'([^']+)'/g)) attributes.add(key)
        // openChild(name, id, type, { 'model.name': ... }) sets each key of its last argument.
        for (const line of source.split('\n').filter((text) => text.includes('openChild('))) {
            for (const key of all(line, /'([a-z][a-z_.]*)'\s*:/g)) attributes.add(key)
        }
        const helper = source.match(/function toolSpanAttrs\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)
        if (helper) for (const key of all(helper[1], /'([a-z][a-z_.]*)'\s*:/g)) attributes.add(key)
    }
    return { names, attributes }
}

function publishedMetrics(prometheus, metricsInterface) {
    const metrics = new Map()
    const enumName = prometheus.match(/Object\.entries\((\w+)\)/)[1]
    const enumBody = metricsInterface.match(new RegExp(`enum ${enumName} \\{([^}]*)\\}`))[1]
    const enumValues = all(enumBody, /'([a-z_]+)'/g)
    const nameOf = new Map()
    for (const match of prometheus.matchAll(/const (\w+)(?::\s*\w+)?\s*=\s*metricName\(('([^']+)'|value)\)/g)) {
        nameOf.set(match[1], match[3] ? [match[3]] : enumValues)
    }
    for (const match of prometheus.matchAll(/(?:(this\.\w+)\s*=\s*)?new (?:promClient\.)?(?:Counter|Gauge|Histogram)\(\{([\s\S]*?)\}\)/g)) {
        const owner = match[1]
        const body = match[2]
        const nameVar = body.match(/name:\s*(\w+)/)[1]
        const declared = all(body.match(/labelNames:\s*\[([^\]]*)\]/)?.[1] || '', /'([^']+)'/g)
        // A metric that is only ever incremented without .labels() publishes none of its declared labels.
        const usesLabels = !owner || new RegExp(`${owner.replace('.', '\\.')}\\s*\\.labels\\(`).test(prometheus)
        for (const name of nameOf.get(nameVar) || []) metrics.set(name, usesLabels ? declared : [])
    }
    const defaults = all(prometheus.match(/setDefaultLabels\(\{([^}]*)\}/)[1], /(\w+)\s*:/g)
    return { metrics, defaults }
}

function promLabelsAllowed(published, name) {
    const base = name.replace(/_(bucket|count|sum)$/, '')
    if (!published.metrics.has(base)) return undefined
    const labels = new Set([...published.metrics.get(base), ...published.defaults])
    if (name.endsWith('_bucket')) labels.add('le')
    return labels
}

function promProblems(expr, legend, published) {
    const problems = []
    const selectors = [...expr.matchAll(/\$\{prefix\}([a-z_]+)(\{([^}]*)\})?/g)]
    if (!selectors.length) problems.push('no ${prefix}metric selector')
    const allowedSets = []
    for (const selector of selectors) {
        const allowed = promLabelsAllowed(published, selector[1])
        if (!allowed) {
            problems.push(`${selector[1]} is not published`)
            continue
        }
        allowedSets.push([selector[1], allowed])
        for (const label of all(selector[3] || '', /(\w+)\s*(?:=~|!~|!=|=)/g)) {
            if (!allowed.has(label)) problems.push(`${selector[1]} has no label ${label}`)
        }
    }
    const grouped = [
        ...all(expr, /\bby\s*\(([^)]*)\)/g).flatMap((list) => list.split(',').map((item) => item.trim())),
        ...all(legend || '', /\{\{\s*(\w+)\s*\}\}/g)
    ]
    for (const label of grouped.filter(Boolean)) {
        for (const [name, allowed] of allowedSets) {
            if (!allowed.has(label)) problems.push(`${name} has no label ${label}`)
        }
    }
    return problems
}

function traceProblems(query, emitted) {
    const problems = []
    for (const list of all(query, /(?<![.\w])name\s*=~?\s*"([^"]+)"/g)) {
        for (const name of list.split('|')) if (!emitted.names.has(name)) problems.push(`span ${name} is not started by the server`)
    }
    for (const key of all(query, /\bspan\.([a-z_.]*[a-z])/g)) {
        if (!emitted.attributes.has(key)) problems.push(`attribute ${key} is not set by the server`)
    }
    for (const key of all(query, /\bresource\.([a-z_.]*[a-z])/g)) {
        if (key !== 'service.name') problems.push(`resource attribute ${key} is not set by the server`)
    }
    // Tempo samples an attribute the filter does not name, so the sum undercounts without this guard.
    for (const match of query.matchAll(/\{([^{}]*)\}\s*\|\s*sum_over_time\(span\.([a-z_.]*[a-z])\)/g)) {
        if (!match[1].includes(`span.${match[2]} != nil`))
            problems.push(`sum_over_time(span.${match[2]}) without span.${match[2]} != nil in its filter`)
    }
    if (/sum_over_time/.test(query) && !/\}\s*\|\s*sum_over_time/.test(query)) problems.push('sum_over_time without a span filter')
    return problems
}

function traceSources() {
    return [read('packages/server/src/metrics/tracing.ts'), read('packages/components/src/otelRunSpans.ts')]
}

function prometheusSources() {
    return [read('packages/server/src/metrics/Prometheus.ts'), read('packages/server/src/Interface.Metrics.ts')]
}

test('the dashboard imports on any Grafana: no instance id, datasources picked by variable', () => {
    assert.equal(dashboard.uid, 'cuttlely-runs')
    assert.equal(dashboard.id, undefined)
    assert.equal(dashboard.__inputs, undefined)
    const byName = Object.fromEntries(variables.map((variable) => [variable.name, variable]))
    assert.equal(byName.tempo.type, 'datasource')
    assert.equal(byName.tempo.query, 'tempo')
    assert.equal(byName.prometheus.type, 'datasource')
    assert.equal(byName.prometheus.query, 'prometheus')
    for (const { panel, target } of targets) {
        assert.match(target.datasource.uid, /^\$\{(tempo|prometheus)\}$/, panel.title)
        assert.equal(panel.datasource.type, target.datasource.type, panel.title)
    }
    const ids = dashboard.panels.map((panel) => panel.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.doesNotMatch(read(DASHBOARD), /api[_-]?key|authorization|secret|password|bearer/i)
})

test('each panel has at most one Tempo query', () => {
    // Grafana keys Tempo metrics results by function name, so a second query in a panel replaces the first.
    for (const panel of panels) {
        const count = panel.targets.filter((target) => target.datasource.type === 'tempo').length
        assert.ok(count <= 1, panel.title)
    }
})

test('the server emits the span names and attributes this test reads', () => {
    const emitted = emittedSpans(traceSources())
    for (const name of ['chatflow.prediction', 'agentflow.run', 'harness.run', 'node', 'model', 'tool', 'harness.specialist']) {
        assert.ok(emitted.names.has(name), name)
    }
    for (const key of ['flow.id', 'tokens.input', 'tokens.total.input', 'model.name', 'tool.name', 'tool.id'])
        assert.ok(emitted.attributes.has(key), key)
    assert.ok(!emitted.attributes.has('cost.usd'))
    assert.match(read('packages/server/src/metrics/tracing.ts'), /\[ATTR_SERVICE_NAME\]:/)
})

test('TraceQL queries use emitted names, and every token sum names its attribute in the filter', () => {
    const emitted = emittedSpans(traceSources())
    assert.ok(tempoTargets.length > 20)
    for (const { panel, target } of tempoTargets) {
        assert.match(target.query, /resource\.service\.name = "\$service"/, panel.title)
        assert.deepEqual(traceProblems(target.query, emitted), [], panel.title)
    }
    assert.deepEqual(traceProblems('{ name = "model" } | sum_over_time(span.tokens.input)', emitted), [
        'sum_over_time(span.tokens.input) without span.tokens.input != nil in its filter'
    ])
    assert.equal(traceProblems('{ name = "model.call" && span.cost.usd != nil } | sum_over_time(span.cost.usd)', emitted).length, 3)
})

test('PromQL queries use published metrics and only the labels those metrics carry', () => {
    const published = publishedMetrics(...prometheusSources())
    assert.deepEqual(published.metrics.get('http_request_duration_ms'), ['method', 'route', 'code'])
    assert.deepEqual(published.metrics.get('http_requests_total'), [])
    assert.deepEqual(published.metrics.get('chatflow_prediction_internal'), ['status'])
    assert.deepEqual(published.defaults, ['app'])
    assert.ok(promTargets.length > 0)
    for (const { panel, target } of promTargets) {
        assert.deepEqual(promProblems(target.expr, target.legendFormat, published), [], panel.title)
    }
    const app = variables.find((variable) => variable.name === 'app')
    assert.deepEqual(promProblems(app.definition, '', published), [])
    assert.deepEqual(promProblems('sum by (path) (rate(${prefix}http_requests_total[5m]))', '', published), [
        'http_requests_total has no label path'
    ])
    assert.deepEqual(promProblems('rate(${prefix}chatflow_prediction_internal{route="x"}[5m])', '', published), [
        'chatflow_prediction_internal has no label route'
    ])
})

test('every dashboard variable reference, including in transformations, is defined', () => {
    const names = new Set(variables.map((variable) => variable.name))
    const builtIn = /^__/
    const text = JSON.stringify(dashboard)
    const used = new Set([...all(text, /\$\{(\w+)(?::\w+)?\}/g), ...all(text, /\$(\w+)(?![\w{])/g)])
    for (const name of used) if (!builtIn.test(name)) assert.ok(names.has(name), `$${name} is not a dashboard variable`)
    const transformations = panels.flatMap((panel) => panel.transformations || [])
    const fromTransforms = all(JSON.stringify(transformations), /\$\{(\w+)\}/g)
    assert.ok(fromTransforms.length > 0)
    for (const name of fromTransforms) assert.ok(names.has(name), name)
})

function guideSection(heading) {
    const guide = read('docs/how-to/observability.md')
    const start = guide.indexOf('## Grafana dashboard')
    assert.ok(start >= 0, 'the guide has no Grafana dashboard section')
    const section = guide.slice(start, guide.indexOf('\n## ', start + 1))
    const at = section.indexOf(heading)
    assert.ok(at >= 0, heading)
    const lines = section.slice(at).split('\n').slice(1)
    const table = []
    for (const line of lines) {
        if (line.startsWith('|')) table.push(line)
        else if (table.length) break
    }
    return table.slice(2).map((line) =>
        line
            .split('|')
            .slice(1, -1)
            .map((cell) => cell.trim())
    )
}

function defaultInDocs(variable) {
    if (variable.type === 'datasource') return `Grafana's default ${variable.label}`
    if (variable.includeAll) return 'All'
    return variable.query === '' ? 'Empty' : '`' + variable.query + '`'
}

test('the guide links the dashboard, and its variable and panel tables match the file', () => {
    const guide = read('docs/how-to/observability.md')
    assert.match(guide, /\.\.\/\.\.\/metrics\/grafana\/cuttlely-runs\.json/)
    assert.match(guide, /does not put a cost on spans/)
    assert.match(guide, /span\.tokens\.input != nil/)
    assert.match(guide, /no `route` label/)

    const documented = guideSection('### Variables').map(([label, value]) => [label, value])
    assert.deepEqual(
        documented,
        variables.map((variable) => [variable.label, defaultInDocs(variable)])
    )

    const rows = []
    let row = ''
    for (const panel of dashboard.panels) {
        if (panel.type === 'row') row = panel.title
        else rows.push([panel.title, row])
    }
    assert.deepEqual(
        guideSection('### Panels').map(([panel, rowTitle]) => [panel, rowTitle]),
        rows
    )
})
