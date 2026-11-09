// scripts/dev-drift-issue.sh keeps one drift issue: it creates or updates it while dev is behind main,
// and comments on and closes it once dev catches up. gh is a stub that records calls.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { testGit, withoutGitEnv } from './test-git.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dev-drift-issue.sh')
const MARKER = '<!-- dev-drift-tracker -->'
const hasJq = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
if [[ "$1" == "api" ]]; then
    filter=""; prev=""
    for a in "$@"; do [[ "$prev" == "--jq" ]] && filter="$a"; prev="$a"; done
    jq -r "$filter" < "$STUB_ISSUES"
fi
prev=""
for a in "$@"; do [[ "$prev" == "--body-file" ]] && cat "$a" >> "$STUB_LOG.body"; prev="$a"; done
`

function setup(issues, drift) {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-dev-drift-')))
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    const git = (...args) => testGit(repo, args, { tmpRoot: tmp })
    git('init', '-q', '-b', 'dev')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base')
    git('branch', 'main')
    for (let i = 1; i <= drift; i++) {
        git('switch', '-q', 'main')
        git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', `release step ${i}`)
    }
    const bin = path.join(tmp, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'gh'), STUB, { mode: 0o755 })
    fs.writeFileSync(path.join(tmp, 'issues.json'), JSON.stringify(issues))
    return { tmp, repo, bin, log: path.join(tmp, 'calls.log') }
}

function run(issues, drift) {
    const s = setup(issues, drift)
    try {
        fs.writeFileSync(s.log, '')
        const res = spawnSync('bash', [SCRIPT], {
            cwd: s.repo,
            encoding: 'utf8',
            env: {
                ...withoutGitEnv(),
                PATH: `${s.bin}${path.delimiter}${process.env.PATH}`,
                GITHUB_REPOSITORY: 'example/repo',
                DRIFT_BASE_REF: 'dev',
                DRIFT_HEAD_REF: 'main',
                STUB_LOG: s.log,
                STUB_ISSUES: path.join(s.tmp, 'issues.json')
            }
        })
        assert.equal(res.status, 0, res.stderr)
        const calls = fs.readFileSync(s.log, 'utf8').split('\n').filter(Boolean)
        const body = fs.existsSync(`${s.log}.body`) ? fs.readFileSync(`${s.log}.body`, 'utf8') : ''
        return { calls, writes: calls.filter((c) => !c.startsWith('api ')), body }
    } finally {
        fs.rmSync(s.tmp, { recursive: true, force: true })
    }
}

const bot = 'github-actions[bot]'
const others = [
    { number: 3, user: { login: 'someone' }, body: `${MARKER} pasted by a person` },
    { number: 4, user: { login: bot }, body: MARKER, pull_request: { url: 'x' } }
]
const tracker = { number: 7, user: { login: bot }, body: `${MARKER}\nold` }

test('no drift and no tracking issue makes no change', { skip: !hasJq && 'jq is not installed' }, () => {
    assert.deepEqual(run(others, 0).writes, [])
})

test(
    'drift with no tracking issue creates one issue with the count, compare link and commits',
    { skip: !hasJq && 'jq is not installed' },
    () => {
        const { writes, body } = run(others, 2)
        assert.equal(writes.length, 1)
        assert.match(writes[0], /^issue create --repo example\/repo --title dev is 2 commits behind main /)
        assert.ok(body.startsWith(MARKER))
        assert.match(body, /https:\/\/github\.com\/example\/repo\/compare\/dev\.\.\.main/)
        assert.match(body, /release step 2/)
        assert.match(body, /merge commit\. Never squash or rebase/)
    }
)

test('drift with an open tracking issue edits the oldest one and never creates another', { skip: !hasJq && 'jq is not installed' }, () => {
    const { writes } = run([...others, { ...tracker, number: 9 }, tracker], 1)
    assert.equal(writes.length, 1)
    assert.match(writes[0], /^issue edit 7 --repo example\/repo --title dev is 1 commit behind main /)
})

test('no drift with an open tracking issue comments on it and closes it', { skip: !hasJq && 'jq is not installed' }, () => {
    const { writes } = run([...others, tracker], 0)
    assert.equal(writes.length, 2)
    assert.match(writes[0], /^issue comment 7 --repo example\/repo --body dev is up to date with main/)
    assert.equal(writes[1], 'issue close 7 --repo example/repo')
})
