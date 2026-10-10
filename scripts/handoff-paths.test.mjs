import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyFiles, handoffDirectoryExists, handoffSkipMessage, isDocPath, isHandoffPath, isTestPath } from './handoff-paths.mjs'

describe('handoff path classification', () => {
    it('treats markdown and .projects as docs, and Cuttlely files as the handoff', () => {
        assert.equal(isDocPath('README.md'), true)
        assert.equal(isDocPath('packages/ui/README.md'), true)
        assert.equal(isDocPath('.projects/cuttlely/STATUS.md'), true)
        assert.equal(isHandoffPath('.projects/cuttlely/RUNBOOK.md'), true)
        assert.equal(isHandoffPath('.projects/other/NOTES.md'), false)
        assert.equal(isDocPath('.cursor/rules/refresh-handoff.mdc'), false)
    })

    it('treats unit, spec, cypress, and mock files as tests', () => {
        assert.equal(isTestPath('packages/server/src/services/marketplaces/sampleTemplates.test.ts'), true)
        assert.equal(isTestPath('scripts/handoff-paths.test.mjs'), true)
        assert.equal(isTestPath('packages/ui/src/foo.spec.tsx'), true)
        assert.equal(isTestPath('cypress/e2e/chat.cy.js'), true)
        assert.equal(isTestPath('packages/server/__mocks__/typeorm.ts'), true)
        assert.equal(isTestPath('packages/server/src/index.ts'), false)
    })

    it('passes an empty diff, docs-only, and tests-only', () => {
        assert.equal(classifyFiles([]).ok, true)
        assert.equal(classifyFiles(['README.md', '.projects/cuttlely/STATUS.md']).ok, true)
        assert.equal(classifyFiles(['packages/server/src/services/nodes/nodeIcon.test.ts']).ok, true)
        const mixedDocs = classifyFiles(['README.md', 'scripts/handoff-paths.test.mjs'])
        assert.equal(mixedDocs.ok, true)
        assert.deepEqual(mixedDocs.code, [])
    })

    it('blocks code that does not touch .projects/cuttlely and allows it when the handoff is in the diff', () => {
        const blocked = classifyFiles(['scripts/verify.mjs', 'package.json', 'packages/server/src/index.ts'])
        assert.equal(blocked.ok, false)
        assert.deepEqual(blocked.handoff, [])
        assert.ok(blocked.code.includes('scripts/verify.mjs'))

        const allowed = classifyFiles(['scripts/verify.mjs', '.projects/cuttlely/RUNBOOK.md'])
        assert.equal(allowed.ok, true)
        assert.deepEqual(allowed.handoff, ['.projects/cuttlely/RUNBOOK.md'])
        assert.deepEqual(allowed.code, ['scripts/verify.mjs'])
    })

    it('finds the project notes in this repository', () => {
        const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
        assert.equal(handoffDirectoryExists(repoRoot), true)
        for (const name of ['README.md', 'STATUS.md', 'PLAN.md', 'OPEN.md', 'DECISIONS.md', 'RUNBOOK.md', 'MEMORY.md', 'ARTIFACTS.md']) {
            assert.equal(fs.existsSync(path.join(repoRoot, '.projects', 'cuttlely', name)), true, `.projects/cuttlely/${name}`)
        }
    })

    it('skips when .projects/cuttlely is missing and still sees it when present', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-handoff-'))
        assert.equal(handoffDirectoryExists(root), false)
        const message = handoffSkipMessage()
        assert.match(message, /Handoff check skipped/)
        assert.match(message, /\.projects\/cuttlely/)
        fs.mkdirSync(path.join(root, '.projects', 'cuttlely'), { recursive: true })
        assert.equal(handoffDirectoryExists(root), true)
        fs.rmSync(root, { recursive: true, force: true })
    })

    it('still blocks when tests ride along with code and the handoff is untouched', () => {
        const result = classifyFiles([
            'packages/server/src/utils/authorizePrediction.test.ts',
            'packages/server/src/utils/buildChatflow.ts'
        ])
        assert.equal(result.ok, false)
        assert.deepEqual(result.tests, ['packages/server/src/utils/authorizePrediction.test.ts'])
        assert.deepEqual(result.code, ['packages/server/src/utils/buildChatflow.ts'])
    })
})
