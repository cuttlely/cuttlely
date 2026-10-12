import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
    buildHealthReport,
    countZoneLines,
    nodeUnitTests,
    productionDependencies,
    renderJson,
    renderMarkdown,
    zoneOf
} from './health-report.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'health-report.mjs')
const roots = []

after(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

const FIXTURE = `
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      left-pad:
        specifier: 1.0.0
        version: 1.0.0
    devDependencies:
      eslint:
        specifier: 8.0.0
        version: 8.0.0

  packages/components:
    dependencies:
      left-pad:
        specifier: 1.0.0
        version: 1.0.0(react@18.0.0)
      alias-me:
        specifier: 1.2.3
        version: real-pkg@1.2.3
      alias-only:
        specifier: 2.0.0
        version: alias-target@2.0.0
      xlsx:
        specifier: 0.20.3
        version: https://example.test/xlsx.tgz

  packages/server:
    dependencies:
      workspace-components:
        specifier: workspace:^
        version: link:../components
      once:
        specifier: 1.0.0
        version: 1.0.0

  packages/ui:
    dependencies:
      react:
        specifier: 18.0.0
        version: 18.0.0

  packages/chat-widget: {}

  packages/cli: {}

packages:

  left-pad@1.0.0:
    resolution: {integrity: sha}

  real-pkg@1.2.3:
    resolution: {integrity: sha}

  once@1.0.0:
    resolution: {integrity: sha}

  react@18.0.0:
    resolution: {integrity: sha}

  eslint@8.0.0:
    resolution: {integrity: sha}

  peer-dep@1.0.0:
    resolution: {integrity: sha}

  dev-only@9.9.9:
    resolution: {integrity: sha}

  xlsx@https://example.test/xlsx.tgz:
    resolution: {integrity: sha}

  alias-target@2.0.0:
    resolution: {integrity: sha}

  extra@1.0.0:
    resolution: {integrity: sha}

snapshots:

  left-pad@1.0.0:
    dependencies:
      real-pkg: 1.2.3
    optionalDependencies:
      peer-dep: 1.0.0

  'left-pad@1.0.0(react@18.0.0)':
    dependencies:
      react: 18.0.0

  real-pkg@1.2.3: {}

  once@1.0.0:
    dependencies:
      left-pad: 1.0.0

  react@18.0.0: {}

  eslint@8.0.0:
    dependencies:
      dev-only: 9.9.9

  peer-dep@1.0.0: {}

  dev-only@9.9.9: {}

  xlsx@https://example.test/xlsx.tgz:
    dependencies:
      left-pad: 1.0.0

  alias-target@2.0.0:
    dependencies:
      extra: 1.0.0

  extra@1.0.0: {}
`

function pkg(deps, label) {
    return deps.packages.find((item) => item.label === label)
}

describe('production dependencies', () => {
    it('counts a fixture lockfile: aliases, peers, links, optional deps and tarball versions', () => {
        const deps = productionDependencies(FIXTURE)
        assert.equal(deps.lockfilePackages, 10)
        assert.equal(deps.workspaceClosure, 8)
        assert.deepEqual(pkg(deps, 'Components'), {
            importer: 'packages/components',
            label: 'Components',
            direct: 4,
            closure: 7
        })
        assert.equal(pkg(deps, 'Server').direct, 1)
        assert.equal(pkg(deps, 'Server').closure, 4)
        assert.equal(pkg(deps, 'UI').direct, 1)
        assert.equal(pkg(deps, 'UI').closure, 1)
        assert.equal(pkg(deps, 'Chat widget').direct, 0)
        assert.equal(pkg(deps, 'Chat widget').closure, 0)
        assert.equal(pkg(deps, 'CLI').direct, 0)
        assert.equal(pkg(deps, 'CLI').closure, 0)
        assert.equal(pkg(deps, 'Workspace root').direct, 1)
        assert.equal(pkg(deps, 'Workspace root').closure, 3)
    })

    it('parses the repository lockfile far enough to count packages', () => {
        const text = fs.readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8')
        const deps = productionDependencies(text)
        assert.ok(deps.lockfilePackages > 1000)
        assert.ok(deps.workspaceClosure > 1000)
        assert.ok(deps.workspaceClosure < deps.lockfilePackages)
        const components = pkg(deps, 'Components')
        const server = pkg(deps, 'Server')
        const ui = pkg(deps, 'UI')
        assert.ok(components.direct > 0)
        assert.ok(components.closure > components.direct)
        assert.ok(server.direct > 0)
        assert.ok(server.closure > server.direct)
        assert.ok(ui.closure >= ui.direct)
        assert.equal(pkg(deps, 'Chat widget').direct, 0)
        assert.equal(pkg(deps, 'Chat widget').closure, 0)
        assert.equal(pkg(deps, 'CLI').direct, 0)
        assert.equal(pkg(deps, 'CLI').closure, 0)
    })
})

describe('zones and nodes', () => {
    it('assigns lines to the zone the boundary map names', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-zones-'))
        roots.push(root)
        const map = {
            zones: { core: ['src/**'], inherited: ['legacy/**'], vendored: ['vendor/**'] },
            subsystems: [{ name: 'core-shared', paths: ['src/**'], entryPoints: [] }]
        }
        fs.mkdirSync(path.join(root, 'src'), { recursive: true })
        fs.mkdirSync(path.join(root, 'legacy'), { recursive: true })
        fs.mkdirSync(path.join(root, 'vendor'), { recursive: true })
        fs.writeFileSync(path.join(root, 'src', 'a.js'), 'one\n\ntwo\n')
        fs.writeFileSync(path.join(root, 'legacy', 'b.ts'), 'x\n')
        fs.writeFileSync(path.join(root, 'vendor', 'c.py'), 'p\n\n')
        fs.writeFileSync(path.join(root, 'readme.md'), '# skip\n\nbody\n')
        assert.equal(zoneOf('src/a.js', map), 'core')
        assert.equal(zoneOf('legacy/b.ts', map), 'inherited')
        assert.equal(zoneOf('vendor/c.py', map), 'vendored')
        const zones = countZoneLines(root, ['src/a.js', 'legacy/b.ts', 'vendor/c.py', 'readme.md'], map)
        assert.deepEqual(zones.core, { files: 1, lines: 2 })
        assert.deepEqual(zones.inherited, { files: 1, lines: 1 })
        assert.deepEqual(zones.vendored, { files: 1, lines: 1 })
        assert.deepEqual(zones.other, { files: 0, lines: 0 })
    })

    it('counts catalog nodes that share a directory with a unit test', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-nodes-'))
        roots.push(root)
        fs.mkdirSync(path.join(root, 'nodes', 'Alpha'), { recursive: true })
        fs.mkdirSync(path.join(root, 'nodes', 'Beta'), { recursive: true })
        fs.writeFileSync(path.join(root, 'nodes', 'Alpha', 'Alpha.test.ts'), 'test\n')
        fs.writeFileSync(path.join(root, 'nodes', 'Beta', 'readme.txt'), 'no\n')
        const catalog = {
            nodes: [
                { name: 'alpha', file: 'nodes/Alpha/Alpha.ts' },
                { name: 'alphaTwin', file: 'nodes/Alpha/Twin.ts' },
                { name: 'beta', file: 'nodes/Beta/Beta.ts' }
            ]
        }
        assert.deepEqual(nodeUnitTests(root, catalog), { nodes: 3, withTests: 2 })
    })
})

describe('report', () => {
    it('prints markdown and JSON for the fixture and exits 0 when the tree has no map', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-report-'))
        roots.push(root)
        const lockfile = path.join(root, 'pnpm-lock.yaml')
        fs.writeFileSync(lockfile, FIXTURE)
        const report = buildHealthReport(root, { lockfilePath: lockfile, imageBytes: 1024, imageRef: 'cuttlely' })
        assert.equal(report.dependencies.workspaceClosure, 8)
        assert.equal(report.image.bytes, 1024)
        assert.equal(report.boundaries, null)
        const markdown = renderMarkdown(report)
        assert.match(markdown, /\| Components \| 4 \| 7 \|/)
        assert.match(markdown, /\| Chat widget \| 0 \| 0 \|/)
        assert.match(markdown, /1024 bytes/)
        assert.match(markdown, /Not measured/)
        const json = JSON.parse(renderJson(report))
        assert.equal(json.dependencies.lockfilePackages, 10)
        assert.equal(json.image.ref, 'cuttlely')

        const summary = path.join(root, 'summary.md')
        const run = spawnSync(process.execPath, [SCRIPT, '--root', root, '--lockfile', lockfile], {
            encoding: 'utf8',
            env: { ...process.env, GITHUB_STEP_SUMMARY: summary }
        })
        assert.equal(run.status, 0, run.stderr)
        assert.match(run.stdout, /### Health report/)
        assert.match(run.stdout, /\| Server \| 1 \| 4 \|/)
        assert.match(fs.readFileSync(summary, 'utf8'), /Workspace production closure/)

        const missing = spawnSync(process.execPath, [SCRIPT, '--root', root, '--image', 'cuttlely-health-missing:none'], {
            encoding: 'utf8'
        })
        assert.equal(missing.status, 0, missing.stderr)
        assert.match(missing.stdout, /not measured/)
    })
})
