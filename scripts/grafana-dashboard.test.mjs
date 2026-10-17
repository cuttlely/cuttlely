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

function addAll(map, name, keys) {
    if (!map.has(name)) map.set(name, new Set())
    for (const key of keys) map.get(name).add(key)
}

// tracing.ts imports the server logger, so it is read, not run. Each span start is tied to the variable it is
// assigned to, and gets the attributes set on that variable until it is assigned again, plus the helpers
// called with it, plus the attribute object an openChild call passes.
function tracingSpans(source) {
    const lines = source.split('\n')
    const units = []
    for (let index = 0; index < lines.length; index++) {
        const head = lines[index].match(/^(?:export )?(?:async )?function (\w+)(?:<[^>]*>)?\((\w+)?/)
        if (!head) continue
        let end = index + 1
        while (end < lines.length && lines[end] !== '}') end++
        units.push({ name: head[1], param: head[2], body: lines.slice(index, end + 1).join('\n') })
        index = end
    }
    const byName = new Map(units.map((unit) => [unit.name, unit]))
    const keysOf = (text) => all(text, /'([a-z][a-z_.]*)'\s*:/g)
    const creates = (unit) => /\.startSpan\(/.test(unit.body)
    const helperAttrs = (name, seen = new Set()) => {
        const unit = byName.get(name)
        if (!unit || creates(unit) || seen.has(name) || !unit.param) return []
        seen.add(name)
        const found = all(unit.body, /\.setAttribute\(\s*'([^']+)'/g)
        for (const called of all(unit.body, new RegExp(`\\b(\\w+)\\(\\s*${unit.param}\\b`, 'g'))) found.push(...helperAttrs(called, seen))
        return found
    }
    const factory = byName.get('openChild')
    const factoryAttrs = factory
        ? [
              ...all(factory.body, /\.setAttribute\(\s*'([^']+)'/g),
              ...all(factory.body, /\b(\w+)\(\s*span\b/g).flatMap((h) => helperAttrs(h))
          ]
        : []
    const toolKeys = byName.get('toolSpanAttrs') ? keysOf(byName.get('toolSpanAttrs').body) : []
    const spans = new Map()
    for (const unit of units) {
        const sites = [...unit.body.matchAll(/\.startSpan\(([^{]*?),\s*\{|openChild\(\s*'([^']+)'([^\n]*)/g)]
        for (const site of sites) {
            // In `cond ? 'a' : 'b'` only the branches are span names.
            const nameArg = site[1] && site[1].includes('?') ? site[1].slice(site[1].indexOf('?')) : site[1]
            const names = site[2] ? [site[2]] : all(nameArg, /'([^']+)'/g)
            if (!names.length) continue
            const keys = []
            if (site[2]) keys.push(...factoryAttrs, ...keysOf(site[3]), ...(site[3].includes('toolSpanAttrs(') ? toolKeys : []))
            const before = unit.body.slice(0, site.index)
            const statement = before.slice(before.lastIndexOf('\n', before.length - 1) + 1)
            const bound =
                (statement + site[0]).match(/(?:const|let)\s+(\w+)\s*=/) ||
                before
                    .split('\n')
                    .slice(-3)
                    .join('\n')
                    .match(/(?:const|let)\s+(\w+)\s*=[^=]*$/)
            const wrapper = statement.match(/(\w+)\(\s*$/)
            if (wrapper) keys.push(...helperAttrs(wrapper[1]))
            if (bound) {
                const rest = unit.body.slice(site.index)
                const rebound = rest.slice(1).search(new RegExp(`(?:const|let)\\s+${bound[1]}\\s*=`))
                const scope = rebound >= 0 ? rest.slice(0, rebound + 1) : rest
                keys.push(...all(scope, new RegExp(`\\b${bound[1]}\\.setAttribute\\(\\s*'([^']+)'`, 'g')))
                for (const called of all(scope, new RegExp(`\\b(\\w+)\\(\\s*${bound[1]}\\b`, 'g'))) keys.push(...helperAttrs(called))
            }
            for (const name of names) addAll(spans, name, keys)
        }
    }
    return spans
}

// otelRunSpans.ts has no server imports, so it runs here with a recording tracer.
async function runtimeSpans() {
    const spans = new Map()
    const module = await import(path.join(ROOT, 'packages/components/src/otelRunSpans.ts'))
    const tracer = {
        startSpan(name) {
            const span = {
                attributes: {},
                setAttribute: (key, value) => {
                    span.attributes[key] = value
                    addAll(spans, name, [key])
                },
                setStatus() {},
                end() {},
                isRecording: () => true,
                spanContext: () => ({ traceId: '1'.repeat(32), spanId: '1'.repeat(16), traceFlags: 1 })
            }
            addAll(spans, name, [])
            return span
        }
    }
    const saved = { traces: process.env.CUTTLELY_OTEL_TRACES, content: process.env.CUTTLELY_OTEL_TRACES_CONTENT }
    process.env.CUTTLELY_OTEL_TRACES = 'true'
    process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'true'
    module.setCuttlelyTracer(() => tracer)
    try {
        const handler = module.otelRunCallback()
        await handler.handleChatModelStart({ kwargs: { modelName: 'm' } }, [[{ content: 'q' }]], 'chat')
        await handler.handleLLMEnd(
            { llmOutput: { tokenUsage: { promptTokens: 3, completionTokens: 2 } }, generations: [[{ text: 'a' }]] },
            'chat'
        )
        await handler.handleLLMStart({ kwargs: { modelName: 'm' } }, ['q'], 'llm')
        await handler.handleLLMError(new Error('model failed'), 'llm')
        await handler.handleToolStart({ name: 'calculator' }, '2+2', 'tool')
        await handler.handleToolEnd('4', 'tool')
        await handler.handleToolStart({ name: 'calculator' }, '2+', 'bad')
        await handler.handleToolError(new Error('tool failed'), 'bad')

        const at = Date.now()
        const tokens = { prompt: 12, completion: 3 }
        const call = (model, start) => ({ model, startedAt: start, endedAt: start + 5, tokens })
        const chip = { name: 'mcp__analyst__query', status: 'done', rowCount: 2, preview: { columns: ['a'], rows: [['1'], ['2']] } }
        const session = module.openHarnessRunTrace({ name: 'bakery', workspaceId: '11111111-1111-4111-8111-111111111111', question: 'q' })
        for (const event of [
            { type: 'route', phase: 'start', at },
            { type: 'route', phase: 'done', at: at + 10, ms: 10, model: 'prime', tokens, calls: [call('prime', at + 1)] },
            { type: 'specialist', phase: 'start', name: 'analyst', task: 't', model: 'analyst-model', at: at + 11 },
            { type: 'tool', phase: 'start', specialist: 'analyst', name: 'mcp__analyst__query', at: at + 12 },
            { type: 'tool', phase: 'done', specialist: 'analyst', name: 'mcp__analyst__query', at: at + 13, detail: 'rows ready' },
            {
                type: 'specialist',
                phase: 'failed',
                name: 'analyst',
                status: 'failed',
                error: 'specialist failed',
                ms: 5,
                model: 'analyst-model',
                tokens,
                task: 't',
                at: at + 20,
                tools: [chip],
                calls: [call('analyst-model', at + 14)]
            },
            { type: 'handoff', phase: 'start', model: 'prime', at: at + 21 },
            { type: 'handoff', phase: 'done', at: at + 30, ms: 9, model: 'prime', tokens, calls: [call('prime', at + 22)] },
            { type: 'final', at: at + 31, text: 'a', trace: { status: 'partial', error: 'specialist failed', tokens } }
        ]) {
            session.event(event)
        }
        session.finish({ text: 'a', runId: 'run_11111111-1111-4111-8111-111111111111' })
    } finally {
        module.setCuttlelyTracer(undefined)
        for (const [key, value] of [
            ['CUTTLELY_OTEL_TRACES', saved.traces],
            ['CUTTLELY_OTEL_TRACES_CONTENT', saved.content]
        ]) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
    return spans
}

// Span name -> attribute -> the files that set it on that span.
async function emittedByFile() {
    const byFile = {
        'packages/server/src/metrics/tracing.ts': tracingSpans(read('packages/server/src/metrics/tracing.ts')),
        'packages/components/src/otelRunSpans.ts': await runtimeSpans()
    }
    return byFile
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

function traceProblems(query, byFile) {
    const problems = []
    const filesFor = (name) => Object.keys(byFile).filter((file) => byFile[file].has(name))
    // Each span filter is checked with the pipeline after it, up to the next filter.
    for (const segment of query.matchAll(/\{([^{}]*)\}([^{}]*)/g)) {
        const names = all(segment[1], /(?<![.\w])name\s*=~?\s*"([^"]+)"/g).flatMap((list) => list.split('|'))
        const keys = [...new Set(all(segment[0], /\bspan\.([a-z_.]*[a-z])/g))]
        if (keys.length && !names.length) problems.push(`span.${keys[0]} with no span name in the filter`)
        for (const name of names) {
            const files = filesFor(name)
            if (!files.length) {
                problems.push(`span ${name} is not started by the server`)
                continue
            }
            for (const key of keys) {
                if (!files.some((file) => byFile[file].get(name).has(key)))
                    problems.push(`${key} is not set on ${name} spans in ${files.join(' or ')}`)
            }
        }
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

test('each emitting file sets the attributes this test expects on each span, and not others', async () => {
    const byFile = await emittedByFile()
    const tracing = byFile['packages/server/src/metrics/tracing.ts']
    const runtime = byFile['packages/components/src/otelRunSpans.ts']
    const has = (spans, name, keys) => keys.forEach((key) => assert.ok(spans.get(name)?.has(key), `${name} ${key}`))
    const lacks = (spans, name, keys) => keys.forEach((key) => assert.ok(!spans.get(name)?.has(key), `${name} should not carry ${key}`))
    has(tracing, 'chatflow.prediction', ['flow.id', 'flow.kind', 'status'])
    has(tracing, 'agentflow.run', ['flow.id', 'flow.kind', 'status'])
    has(tracing, 'node', ['node.id', 'node.type', 'status'])
    has(tracing, 'model', ['model.name', 'tokens.input', 'tokens.output', 'flow.id', 'flow.kind', 'node.id'])
    has(tracing, 'tool', ['tool.name', 'tool.id', 'flow.id', 'status'])
    lacks(tracing, 'chatflow.prediction', ['harness.name', 'tokens.input', 'model.name'])
    lacks(tracing, 'tool', ['tokens.input', 'model.name'])
    assert.ok(!tracing.has('harness.run'))
    has(runtime, 'harness.run', ['harness.name', 'workspace.id', 'run.id', 'tokens.total.input', 'tokens.total.output', 'status', 'error'])
    has(runtime, 'harness.specialist', ['specialist.name', 'model.name', 'tokens.total.input', 'status', 'error'])
    has(runtime, 'harness.route', ['model.name', 'tokens.total.input'])
    has(runtime, 'harness.handoff', ['model.name', 'tokens.total.input'])
    has(runtime, 'model', ['model.name', 'tokens.input', 'tokens.output', 'status'])
    has(runtime, 'tool', ['tool.name', 'tool.rows', 'status', 'error'])
    lacks(runtime, 'harness.run', ['tokens.input', 'flow.id', 'tool.name'])
    lacks(runtime, 'tool', ['tokens.input', 'harness.name'])
    assert.ok(!runtime.has('chatflow.prediction'))
    assert.match(read('packages/server/src/metrics/tracing.ts'), /\[ATTR_SERVICE_NAME\]:/)
})

test('TraceQL queries use each attribute only on spans that carry it, and every token sum names its attribute', async () => {
    const byFile = await emittedByFile()
    assert.ok(tempoTargets.length > 20)
    for (const { panel, target } of tempoTargets) {
        assert.match(target.query, /resource\.service\.name = "\$service"/, panel.title)
        assert.deepEqual(traceProblems(target.query, byFile), [], panel.title)
    }
    assert.deepEqual(traceProblems('{ name = "model" } | sum_over_time(span.tokens.input)', byFile), [
        'sum_over_time(span.tokens.input) without span.tokens.input != nil in its filter'
    ])
    assert.deepEqual(traceProblems('{ name = "chatflow.prediction" } | rate() by (span.harness.name)', byFile), [
        'harness.name is not set on chatflow.prediction spans in packages/server/src/metrics/tracing.ts'
    ])
    assert.deepEqual(traceProblems('{ name = "tool" && span.tokens.input != nil } | sum_over_time(span.tokens.input)', byFile), [
        'tokens.input is not set on tool spans in packages/server/src/metrics/tracing.ts or packages/components/src/otelRunSpans.ts'
    ])
    assert.deepEqual(traceProblems('{ status = error } | rate() by (span.flow.id)', byFile), [
        'span.flow.id with no span name in the filter'
    ])
    assert.equal(traceProblems('{ name = "model.call" && span.cost.usd != nil } | sum_over_time(span.cost.usd)', byFile).length, 1)
})

test('the guide and the prediction panel say which runs the agentflow counter counts', () => {
    const wording = 'legacy (V1) agentflows, which are Multi Agents and Sequential Agents canvases'
    assert.ok(read('docs/how-to/observability.md').includes(wording))
    assert.ok(panels.find((panel) => panel.title === 'Predictions per second').description.includes(wording))
    assert.match(read('packages/server/src/utils/buildChatflow.ts'), /const isAgentFlow = chatflow\.type === 'MULTIAGENT'/)
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
