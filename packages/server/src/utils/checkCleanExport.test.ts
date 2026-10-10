import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// A source export may carry the public project notes in `.projects/cuttlely/`, and nothing else under `.projects/`.
// The private records folder and the files kept out of every export must not ship. Fixtures are built in a temp
// directory so the repository's own tree does not decide the result.
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
const script = path.join(repoRoot, 'scripts', 'check-clean-export.mjs')

const run = (args: string[], input?: string) => {
    const res = spawnSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8', input })
    return { status: res.status, result: JSON.parse(res.stdout.trim()) }
}

const writeTree = (root: string, files: Record<string, string>) => {
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
        fs.writeFileSync(path.join(root, rel), body)
    }
}

const violationPaths = (result: { violations: { path: string }[] }) => result.violations.map((v) => v.path)

describe('check-clean-export.mjs', () => {
    let tmp: string

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-export-'))
    })

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true })
    })

    it('passes a clean export that carries the public project notes', () => {
        writeTree(tmp, {
            'packages/server/src/identity/index.ts': 'export {}\n',
            'docs/identity/phase0-spec.md': '# Spec\n',
            '.projects/cuttlely/README.md': '# notes\n',
            '.projects/cuttlely/STATUS.md': '# status\n'
        })
        const { status, result } = run([tmp])
        expect(status).toBe(0)
        expect(result.ok).toBe(true)
        expect(result.violations).toEqual([])
    })

    it('fails an export with another .projects/ folder or the private records folder', () => {
        writeTree(tmp, {
            'README.md': '# cuttlely\n',
            '.projects/cuttlely/STATUS.md': '# status\n',
            '.projects/cuttlely/provenance/README.md': '# records\n',
            '.projects/other/NOTES.md': '# other\n'
        })
        const { status, result } = run([tmp])
        expect(status).toBe(1)
        const paths = violationPaths(result)
        expect(paths).toContain('.projects/other/')
        expect(paths).toContain('.projects/cuttlely/provenance/')
        expect(paths).not.toContain('.projects/cuttlely/STATUS.md')
    })

    it('fails an export with a file kept out of every export', () => {
        writeTree(tmp, {
            'README.md': '# cuttlely\n',
            'PROVENANCE.md': '# records\n',
            'docs/product-identity.md': '# identity\n',
            'scripts/identity-relation-evidence.md': '# evidence\n',
            'scripts/identity-status-evidence.md': '# evidence\n',
            'scripts/identity-migration.test.cjs': '// a real script\n'
        })
        const { status, result } = run([tmp])
        expect(status).toBe(1)
        expect(violationPaths(result).sort()).toEqual([
            'PROVENANCE.md',
            'docs/product-identity.md',
            'scripts/identity-relation-evidence.md',
            'scripts/identity-status-evidence.md'
        ])
    })

    it('checks a file list with --files and --root', () => {
        writeTree(tmp, { 'README.md': '# cuttlely\n' })
        expect(run(['--files', '-', '--root', tmp], 'README.md\npackages/a.ts\n.projects/cuttlely/STATUS.md\n').status).toBe(0)
        const bad = run(['--files', '-', '--root', tmp], 'README.md\n.projects/other/STATUS.md\n')
        expect(bad.status).toBe(1)
        expect(bad.result.violations[0].reason).toBe('path under .projects/ outside .projects/cuttlely/')
    })
})
