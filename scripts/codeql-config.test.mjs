// CodeQL leaves the pinned hermes/ copy out, and scans back in every hermes/ file Cuttlely's patches touch.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { listPatches, patchFiles } from './vendor-hermes.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

function load(file) {
    return yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8'))
}

test('codeql-config.yml leaves hermes/ out', () => {
    assert.deepEqual(load('.github/codeql/codeql-config.yml')['paths-ignore'], ['hermes/**'])
})

test('hermes-patched-files.txt lists exactly the files hermes/patches touch', () => {
    const patches = listPatches(path.join(ROOT, 'hermes', 'patches'))
    assert.ok(patches.length > 0, 'no patches found under hermes/patches')
    const patched = [...new Set(patches.flatMap((patch) => patchFiles(patch.text).files))].map((file) => `hermes/${file}`)
    const text = fs.readFileSync(path.join(ROOT, '.github/codeql/hermes-patched-files.txt'), 'utf8')
    assert.ok(text.endsWith('\n'), 'hermes-patched-files.txt must end with a newline or the workflow skips its last file')
    const listed = text.split('\n').filter(Boolean)
    assert.equal(new Set(listed).size, listed.length, 'hermes-patched-files.txt lists a file twice')
    const missing = patched.filter((file) => !listed.includes(file))
    const stale = listed.filter((file) => !patched.includes(file))
    assert.deepEqual(missing, [], `add these patched files to .github/codeql/hermes-patched-files.txt: ${missing.join(', ')}`)
    assert.deepEqual(stale, [], `no patch touches these files; take them off .github/codeql/hermes-patched-files.txt: ${stale.join(', ')}`)
    assert.ok(listed.includes('hermes/tools/mcp_tool_cuttlely.py'))
    for (const file of listed) assert.ok(fs.statSync(path.join(ROOT, file)).isFile(), `${file} is listed but not a file in the tree`)
})

test('the hermes-patches entry analyzes a copy of the listed files, not paths in its config', () => {
    const config = load('.github/codeql/codeql-hermes-patches.yml')
    assert.equal(config.paths, undefined, 'the Python extractor fails on a file under paths')
    assert.equal(config['paths-ignore'], undefined, 'paths-ignore would drop files from the copied source root')
    const job = load('.github/workflows/codeql.yml').jobs.analyze
    const entry = job.strategy.matrix.include.find((item) => item.category === '/language:python/hermes-patches')
    assert.equal(entry['source-root'], 'codeql-hermes-patches')
    const copy = job.steps.find((step) => step.run?.includes('.github/codeql/hermes-patched-files.txt'))
    assert.ok(copy, 'no step copies .github/codeql/hermes-patched-files.txt')
    assert.equal(copy.if, 'matrix.source-root')
    assert.match(copy.run, /cp --parents "\$file" "\$SOURCE_ROOT\/"/)
    const init = job.steps.find((step) => step.uses?.startsWith('github/codeql-action/init@'))
    assert.equal(init.with['source-root'], '${{ matrix.source-root }}')
    assert.ok(job.steps.indexOf(copy) < job.steps.indexOf(init), 'the copy must run before CodeQL init')
    for (const other of job.strategy.matrix.include.filter((item) => item !== entry)) {
        assert.equal(other['source-root'], undefined, `${other.category} must analyze the whole checkout`)
    }
})

test('the CodeQL workflow runs each config, pins actions to commits, and keeps no git credentials', () => {
    const workflow = load('.github/workflows/codeql.yml')
    const job = workflow.jobs.analyze
    assert.equal(job.name, 'Analyze (${{ matrix.category }})')
    const entries = job.strategy.matrix.include.map((entry) => `${entry.language} ${entry.config} ${entry.category}`)
    assert.deepEqual(entries, [
        'actions ./.github/codeql/codeql-config.yml /language:actions',
        'javascript-typescript ./.github/codeql/codeql-config.yml /language:javascript-typescript',
        'python ./.github/codeql/codeql-config.yml /language:python',
        'python ./.github/codeql/codeql-hermes-patches.yml /language:python/hermes-patches'
    ])
    for (const step of job.steps.filter((step) => step.uses)) {
        assert.match(step.uses, /@[0-9a-f]{40}$/, `${step.uses} is not pinned to a full commit SHA`)
    }
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))
    assert.equal(checkout.with['persist-credentials'], false)
    const text = fs.readFileSync(path.join(ROOT, '.github/workflows/codeql.yml'), 'utf8')
    for (const line of text.split('\n').filter((line) => line.includes('uses:'))) {
        assert.match(line, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `missing version comment: ${line.trim()}`)
    }
})

test('Dependabot updates GitHub Actions', () => {
    const ecosystems = load('.github/dependabot.yml').updates.map((update) => update['package-ecosystem'])
    assert.ok(ecosystems.includes('github-actions'))
})
