// metrics/grafana/cuttlely-runs.json is the dashboard the run-traces guide points at.
// This checks it parses and queries only span names, attributes, and metrics the server emits.
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

test('the dashboard imports on any Grafana: no instance id, datasources picked by variable', () => {
    assert.equal(dashboard.uid, 'cuttlely-runs')
    assert.equal(dashboard.id, undefined)
    assert.equal(dashboard.__inputs, undefined)
    const variables = Object.fromEntries(dashboard.templating.list.map((variable) => [variable.name, variable]))
    assert.equal(variables.tempo.type, 'datasource')
    assert.equal(variables.tempo.query, 'tempo')
    assert.equal(variables.prometheus.type, 'datasource')
    assert.equal(variables.prometheus.query, 'prometheus')
    assert.equal(variables.service.query, 'cuttlely')
    for (const { target } of targets) {
        assert.match(target.datasource.uid, /^\$\{(tempo|prometheus)\}$/, JSON.stringify(target))
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

test('TraceQL queries use only span names and attributes the server sets', () => {
    const sources = [read('packages/server/src/metrics/tracing.ts'), read('packages/components/src/otelRunSpans.ts')].join('\n')
    assert.ok(tempoTargets.length > 20)
    for (const { panel, target } of tempoTargets) {
        const query = target.query
        assert.match(query, /resource\.service\.name = "\$service"/, panel.title)
        for (const match of query.matchAll(/(?<![.\w])name\s*=~?\s*"([^"]+)"/g)) {
            for (const name of match[1].split('|')) {
                assert.ok(sources.includes("'" + name + "'"), `${panel.title}: span ${name} is not started by the server`)
            }
        }
        for (const match of query.matchAll(/\bspan\.([a-z_.]+[a-z])/g)) {
            assert.ok(sources.includes("'" + match[1] + "'"), `${panel.title}: attribute ${match[1]} is not set by the server`)
        }
    }
})

test('PromQL queries use only metrics the Prometheus provider publishes', () => {
    const sources = [read('packages/server/src/metrics/Prometheus.ts'), read('packages/server/src/Interface.Metrics.ts')].join('\n')
    assert.ok(promTargets.length > 0)
    for (const { panel, target } of promTargets) {
        const names = [...target.expr.matchAll(/\$\{prefix\}([a-z_]+)/g)].map((match) => match[1].replace(/_(bucket|count|sum)$/, ''))
        assert.ok(names.length > 0, panel.title)
        for (const name of names) {
            assert.ok(sources.includes("'" + name + "'"), `${panel.title}: ${name} is not published`)
        }
    }
})

test('the run-traces guide links the dashboard and names its datasources', () => {
    const guide = read('docs/how-to/observability.md')
    assert.match(guide, /\.\.\/\.\.\/metrics\/grafana\/cuttlely-runs\.json/)
    assert.match(guide, /Tempo/)
    assert.match(guide, /Prometheus/)
    assert.match(guide, /does not put a cost on spans|no cost attribute/i)
})
