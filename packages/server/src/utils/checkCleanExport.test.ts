import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// A source export must not carry `.projects/` paths. Fixtures are built in a temp directory so the repository itself
// never holds a `.projects/` tree that a real export would pick up.
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

describe('check-clean-export.mjs', () => {
    let tmp: string

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-export-'))
    })

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true })
    })

    it('passes a clean export (negative fixture)', () => {
        writeTree(tmp, {
            'packages/server/src/identity/index.ts': 'export {}\n',
            'docs/identity/phase0-spec.md': '# Spec\n'
        })
        const { status, result } = run([tmp])
        expect(status).toBe(0)
        expect(result.ok).toBe(true)
        expect(result.violations).toEqual([])
    })

    it('fails an export that contains a .projects/ path (positive fixture)', () => {
        writeTree(tmp, {
            'README.md': '# cuttlely\n',
            '.projects/cuttlely/STATUS.md': '# status\n'
        })
        const { status, result } = run([tmp])
        expect(status).toBe(1)
        expect(result.violations.map((v: { path: string }) => v.path)).toContain('.projects/')
    })

    it('checks a file list with --files and --root', () => {
        writeTree(tmp, { 'README.md': '# cuttlely\n' })
        expect(run(['--files', '-', '--root', tmp], 'README.md\npackages/a.ts\n').status).toBe(0)
        const bad = run(['--files', '-', '--root', tmp], 'README.md\n.projects/cuttlely/STATUS.md\n')
        expect(bad.status).toBe(1)
        expect(bad.result.violations[0].reason).toBe('path under .projects/')
    })
})
