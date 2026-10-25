import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkBoundaries, extractSpecifiers, updateBaseline } from './check-boundaries.mjs'
import { isolateProcessEnv, testGit } from './test-git.mjs'

// The pre-push hook exports GIT_DIR. Drop it before any git call so fixture repos stay separate
// and the real-tree check still discovers this worktree from its own directory.
isolateProcessEnv()

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const roots = []

after(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

const MAP = {
    zones: {
        core: ['harness/**', 'etl/**', 'scripts/**', 'packages/chat-widget/**', 'packages/cli/**', 'packages/server/src/identity/**'],
        inherited: ['packages/server/**', 'packages/ui/**'],
        vendored: ['hermes/**']
    },
    subsystems: [
        { name: 'Harnesses and the Analyst', paths: ['harness/**'], entryPoints: ['harness/client.mjs'] },
        { name: 'Knowledge pipelines', paths: ['etl/**'], entryPoints: [] },
        { name: 'Chat widget', paths: ['packages/chat-widget/**'], entryPoints: ['packages/chat-widget/src/index.js'] },
        { name: 'CLI', paths: ['packages/cli/**'], entryPoints: [] },
        { name: 'Identity and RBAC', paths: ['packages/server/src/identity/**'], entryPoints: ['packages/server/src/identity/index.ts'] },
        { name: 'core-shared', paths: ['scripts/**'], entryPoints: [] },
        { name: 'Agent runtime', paths: ['hermes/**'], entryPoints: [] }
    ]
}

const EMPTY_BASELINE = {
    r1Packages: [],
    r1Edges: [],
    r2Edges: [],
    r3Edges: [],
    r4Edges: [],
    r5Edges: [],
    r6Additions: []
}

function git(root, args) {
    // A pre-push hook exports GIT_DIR. testGit drops those variables so this fixture stays in its temp folder.
    const res = testGit(root, args, { tmpRoot: root })
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
}

function write(root, rel, content) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
}

function make(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundaries-'))
    roots.push(root)
    git(root, ['init', '-q'])
    const all = {
        'architecture/boundaries.json': `${JSON.stringify(MAP, null, 4)}\n`,
        'architecture/boundary-baseline.json': `${JSON.stringify(EMPTY_BASELINE, null, 4)}\n`,
        'architecture/inherited-files.txt': 'packages/server/src/utils/logger.ts\n',
        'packages/server/src/utils/logger.ts': 'export const log = 1\n',
        ...files
    }
    for (const [rel, content] of Object.entries(all)) write(root, rel, content)
    git(root, ['add', '-A'])
    return root
}

function messages(root) {
    const result = checkBoundaries(root)
    return result.violations.map((violation) => violation.message).join('\n\n')
}

describe('import parser', () => {
    it('reads static, dynamic, require, and side-effect imports and skips comments and strings', () => {
        const specs = extractSpecifiers(`
            import 'side-effect'
            import { a } from './a'
            import x from "./b"
            export { y } from './c'
            const z = require('./d')
            await import('./e')
            require.resolve('./f')
            import {
              multi
            } from './multi'
            // import { n } from './nope'
            const s = "import { n } from './nope2'"
            const req = createRequire(path.join(root, 'pkg', 'package.json'))('left-pad')
            import.meta.url
        `)
        assert.deepEqual([...specs].sort(), ['./a', './b', './c', './d', './e', './f', './multi', 'left-pad', 'side-effect'].sort())
    })
})

describe('boundary rules', () => {
    it('R1 catches a third-party package and an import into packages', () => {
        const root = make({
            'harness/bad.mjs': "import 'left-pad'\nimport '../packages/server/src/utils/logger.ts'\n"
        })
        const text = messages(root)
        assert.match(text, /R1: harness\/bad\.mjs imports left-pad/)
        assert.match(text, /R1: harness\/bad\.mjs imports packages\/server\/src\/utils\/logger\.ts/)
        assert.match(text, /do not import other paths under packages/)
        assert.match(text, /--allow-new/)
    })

    it('R2 catches an import outside the package and a dependencies entry', () => {
        const root = make({
            'packages/chat-widget/src/index.js': "import '../../server/src/utils/logger.ts'\n",
            'packages/cli/package.json': `${JSON.stringify({ name: 'cuttlely', dependencies: { 'left-pad': '1.0.0' } })}\n`,
            'packages/cli/bin/cuttlely.js': "import { spawn } from 'node:child_process'\n"
        })
        const text = messages(root)
        assert.match(text, /R2: packages\/chat-widget\/src\/index\.js imports packages\/server\/src\/utils\/logger\.ts/)
        assert.match(text, /outside its package/)
        assert.match(text, /R2: packages\/cli\/package\.json dependencies is not empty/)
    })

    it('R3 catches a new core import of an inherited file', () => {
        const root = make({
            'packages/server/src/identity/index.ts': "import '../utils/logger.ts'\n"
        })
        const text = messages(root)
        assert.match(text, /R3: packages\/server\/src\/identity\/index\.ts imports packages\/server\/src\/utils\/logger\.ts/)
        assert.match(text, /boundary-baseline\.json/)
        assert.match(text, /--allow-new/)
    })

    it('R4 catches an inherited import of a core file that is not an entry point', () => {
        const blocked = make({
            'packages/server/src/identity/secret.ts': 'export const secret = 1\n',
            'packages/server/src/utils/logger.ts': "import '../identity/secret.ts'\n"
        })
        const text = messages(blocked)
        assert.match(text, /R4: packages\/server\/src\/utils\/logger\.ts imports packages\/server\/src\/identity\/secret\.ts/)
        assert.match(text, /entry point/)

        const allowed = make({
            'packages/server/src/identity/index.ts': 'export const id = 1\n',
            'packages/server/src/utils/logger.ts': "import '../identity/index.ts'\n"
        })
        assert.deepEqual(checkBoundaries(allowed).violations, [])
    })

    it('R5 catches a read of the agent runtime source and allows the vendor script', () => {
        const runtimeFile = ['hermes', 'agent', 'run.py'].join('/')
        const root = make({
            'hermes/agent/run.py': 'print(1)\n',
            'scripts/sneak.mjs': `import fs from 'node:fs'\nfs.readFileSync('${runtimeFile}', 'utf8')\n`,
            'scripts/vendor-hermes.mjs': `import fs from 'node:fs'\nfs.readFileSync('${runtimeFile}', 'utf8')\n`
        })
        const result = checkBoundaries(root)
        const readers = result.violations.filter((violation) => violation.rule === 'R5').map((violation) => violation.from)
        assert.deepEqual(readers, ['scripts/sneak.mjs'])
        assert.match(result.violations[0].message, /reads hermes\/agent\/run\.py/)
        assert.match(result.violations[0].message, /over HTTP/)
        assert.match(result.violations[0].message, /scripts\/vendor-hermes\.mjs/)
    })

    it('R6 catches a new file inside an inherited package', () => {
        const root = make({})
        write(root, 'packages/server/src/utils/brand-new.ts', 'export const added = 1\n')
        git(root, ['add', '-A'])
        const text = messages(root)
        assert.match(text, /R6: packages\/server\/src\/utils\/brand-new\.ts/)
        assert.match(text, /core-shared/)
        assert.match(text, /architecture\/boundaries\.json/)
    })
})

describe('baseline ratchet', () => {
    it('refuses to grow without --allow-new and stores the reason on the new edge', () => {
        const root = make({
            'packages/server/src/identity/index.ts': "import '../utils/logger.ts'\n",
            'architecture/boundary-baseline.json': `${JSON.stringify(
                {
                    ...EMPTY_BASELINE,
                    r3Edges: [{ from: 'packages/server/src/identity/index.ts', to: 'packages/server/src/utils/logger.ts' }]
                },
                null,
                4
            )}\n`
        })
        assert.deepEqual(checkBoundaries(root).violations, [])

        write(root, 'packages/server/src/utils/other.ts', 'export const other = 1\n')
        write(root, 'packages/server/src/identity/index.ts', "import '../utils/logger.ts'\nimport '../utils/other.ts'\n")
        write(root, 'architecture/inherited-files.txt', 'packages/server/src/utils/logger.ts\npackages/server/src/utils/other.ts\n')
        git(root, ['add', '-A'])

        const grown = updateBaseline(root, { allowNew: false })
        assert.equal(grown.ok, false)
        assert.match(grown.message, /would grow/)
        assert.match(grown.message, /--allow-new/)
        assert.match(grown.message, /R3 packages\/server\/src\/identity\/index\.ts -> packages\/server\/src\/utils\/other\.ts/)

        const recorded = updateBaseline(root, { allowNew: true, reason: 'the identity module already calls this helper' })
        assert.equal(recorded.ok, true)
        const saved = JSON.parse(fs.readFileSync(path.join(root, 'architecture/boundary-baseline.json'), 'utf8'))
        const edge = saved.r3Edges.find((item) => item.to === 'packages/server/src/utils/other.ts')
        assert.equal(edge.reason, 'the identity module already calls this helper')
        assert.equal(edge.from, 'packages/server/src/identity/index.ts')
        assert.deepEqual(checkBoundaries(root).violations, [])

        write(root, 'packages/server/src/identity/index.ts', "import '../utils/logger.ts'\n")
        git(root, ['add', '-A'])
        const shrunk = updateBaseline(root, { allowNew: false })
        assert.equal(shrunk.ok, true)
        assert.ok(shrunk.removed >= 1)
        const after = JSON.parse(fs.readFileSync(path.join(root, 'architecture/boundary-baseline.json'), 'utf8'))
        assert.equal(
            after.r3Edges.some((item) => item.to === 'packages/server/src/utils/other.ts'),
            false
        )
    })

    it('refuses to add an inherited file unless --allow-new records why', () => {
        const root = make({})
        write(root, 'packages/server/src/utils/brand-new.ts', 'export const added = 1\n')
        git(root, ['add', '-A'])
        const blocked = updateBaseline(root, { allowNew: false })
        assert.equal(blocked.ok, false)
        assert.match(blocked.message, /R6 packages\/server\/src\/utils\/brand-new\.ts/)
        const recorded = updateBaseline(root, { allowNew: true, reason: 'this file stays with the inherited engine' })
        assert.equal(recorded.ok, true)
        const saved = JSON.parse(fs.readFileSync(path.join(root, 'architecture/boundary-baseline.json'), 'utf8'))
        assert.equal(saved.r6Additions[0].path, 'packages/server/src/utils/brand-new.ts')
        assert.equal(saved.r6Additions[0].reason, 'this file stays with the inherited engine')
        assert.match(fs.readFileSync(path.join(root, 'architecture/inherited-files.txt'), 'utf8'), /brand-new\.ts/)
    })

    it('fails when a recorded line is no longer in the tree', () => {
        const root = make({
            'packages/server/src/identity/index.ts': "import '../utils/logger.ts'\n",
            'architecture/inherited-files.txt': 'packages/server/src/utils/logger.ts\npackages/server/src/utils/gone.ts\n',
            'architecture/boundary-baseline.json': `${JSON.stringify(
                {
                    ...EMPTY_BASELINE,
                    r3Edges: [
                        { from: 'packages/server/src/identity/index.ts', to: 'packages/server/src/utils/logger.ts' },
                        { from: 'packages/server/src/identity/index.ts', to: 'packages/server/src/utils/gone.ts' }
                    ]
                },
                null,
                4
            )}\n`
        })
        const text = messages(root)
        assert.match(text, /Stale inherited file: packages\/server\/src\/utils\/gone\.ts/)
        assert.match(text, /Stale R3 crossing: packages\/server\/src\/identity\/index\.ts -> packages\/server\/src\/utils\/gone\.ts/)
        assert.match(text, /node scripts\/check-boundaries\.mjs --update/)
        assert.match(text, /shrink the list/)
        const shrunk = updateBaseline(root, { allowNew: false })
        assert.equal(shrunk.ok, true)
        assert.deepEqual(checkBoundaries(root).violations, [])
    })
})

describe('this repo', () => {
    it('passes in under 10 seconds', () => {
        const started = Date.now()
        const result = checkBoundaries(ROOT)
        const elapsed = Date.now() - started
        assert.equal(
            result.ok,
            true,
            result.violations
                .slice(0, 8)
                .map((violation) => violation.message)
                .join('\n\n')
        )
        assert.ok(elapsed < 10000, `boundary check took ${elapsed}ms`)
    })
})
