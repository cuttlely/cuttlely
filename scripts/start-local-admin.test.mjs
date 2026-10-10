// The start script's local-account default: same outcome as before for existing installs, and a
// default it fills in is listed so a value saved in Server settings still wins.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = fs.readFileSync(path.join(ROOT, 'scripts', 'start-cuttlely.sh'), 'utf8')
const block = script.slice(script.indexOf('script_defaults=()'), script.indexOf('export CUTTLELY_SETTINGS_SCRIPT_DEFAULTS='))
const snippet = `host_workos_key="\${WORKOS_API_KEY:-}"\n${block}export CUTTLELY_SETTINGS_SCRIPT_DEFAULTS="\${script_defaults[*]:-}"\nprintf '%s|%s' "\${CUTTLELY_LOCAL_ADMIN-unset}" "$CUTTLELY_SETTINGS_SCRIPT_DEFAULTS"`

function run(env, dotenv = '') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-start-'))
    fs.mkdirSync(path.join(root, 'packages', 'server'), { recursive: true })
    if (dotenv) fs.writeFileSync(path.join(root, 'packages', 'server', '.env'), dotenv)
    return execFileSync('bash', ['-c', `set -euo pipefail\nROOT=${JSON.stringify(root)}\n${snippet}`], {
        env: { PATH: process.env.PATH, ...env },
        encoding: 'utf8'
    })
}

test('the block is in the start script', () => {
    assert.ok(block.includes('CUTTLELY_LOCAL_ADMIN=true'))
})

test('a source install with nothing set gets the local account', () => {
    assert.equal(run({}), 'true|CUTTLELY_LOCAL_ADMIN')
})

test('blank counts as not set, the way compose passes it', () => {
    assert.equal(run({ CUTTLELY_LOCAL_ADMIN: '' }), 'true|CUTTLELY_LOCAL_ADMIN')
})

test('Docker keeps the local account on even with WorkOS keys, as compose did', () => {
    assert.equal(run({ CUTTLELY_INSTALL: 'docker', CUTTLELY_LOCAL_ADMIN: '', WORKOS_API_KEY: 'sk_test_fake' }), 'true|CUTTLELY_LOCAL_ADMIN')
})

test('a source install with WorkOS, Render, or an explicit value decides for itself', () => {
    assert.equal(run({ WORKOS_API_KEY: 'sk_test_fake' }), 'unset|')
    assert.equal(run({}, 'WORKOS_API_KEY=sk_test_fake\n'), 'unset|')
    assert.equal(run({ RENDER: 'true', CUTTLELY_INSTALL: 'docker' }), 'unset|')
    assert.equal(run({ CUTTLELY_LOCAL_ADMIN: 'false' }), 'false|')
    assert.equal(run({}, 'CUTTLELY_LOCAL_ADMIN=false\n'), 'unset|')
})
