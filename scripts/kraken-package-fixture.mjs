// Set CUTTLELY_TEST_NATIVE_PACKAGE to a separately built native installation for the packaging gate.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function nativePackageRoot() {
    const install = process.env.CUTTLELY_TEST_NATIVE_PACKAGE
    if (!install) return null
    assert.ok(path.isAbsolute(install), 'the native package gate requires an absolute installation path')
    for (const file of [
        'packages/harness/native-distribution.json',
        'packages/etl/runtime-recovery/cuttlely_session_store.py',
        'packages/ui/build/index.html',
        'samples/ops-mcp-server.mjs',
        'packages/components/dist/nodes/harness'
    ]) {
        assert.ok(fs.existsSync(path.join(install, file)), file + ' is required in the native distribution')
    }
    assert.ok(!fs.existsSync(path.join(install, 'hermes')), 'native install must exclude the entire bundled runtime')
    return fs.realpathSync(install)
}

const profile = 'profiles/legacy-research'
const script = `
import os, sys
from pathlib import Path
from hermes_state import SessionDB
from cuttlely_session_store import save_setting
folder = Path(os.environ["HERMES_HOME"], sys.argv[1])
folder.mkdir(mode=0o700, parents=True, exist_ok=True)
db = SessionDB(folder / "state.db")
db.create_session(sys.argv[2], "cli")
db.append_message(sys.argv[2], "user", sys.argv[3])
db.close()
target = folder / "config.yaml"
staged = folder / "config.stage"
staged.write_text(sys.argv[3])
save_setting(target, staged)
staged.replace(target)
`

export function seedLegacyRuntime(root, env, session, message) {
    // This is the old writer from the full installation, including its real SQLite message schema.
    const python = process.env.HERMES_PYTHON || path.join(root, 'hermes/.venv/bin/python')
    execFileSync(python, ['-c', script, profile, session, message], {
        cwd: path.join(root, 'hermes'),
        env,
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe']
    })
}

export function verifyLegacyRecovery(dataRoot, session, message) {
    const directory = path.join(dataRoot, 'hermes', profile)
    assert.equal(fs.readFileSync(path.join(directory, 'config.yaml'), 'utf8'), message)
    const sqlite = new DatabaseSync(path.join(directory, 'state.db'), { readOnly: true })
    try {
        assert.equal(sqlite.prepare('PRAGMA quick_check').get().quick_check, 'ok')
        assert.equal(sqlite.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').get(session, 'user')?.content, message)
    } finally {
        sqlite.close()
    }
}

export function rejectCorruptRecovery(install, env) {
    // Simulate a mistyped bootstrap key on a third empty disk. An invalid copy must never be installed.
    const home = env.CUTTLELY_HERMES_HOME
    assert.ok(!fs.existsSync(home))
    assert.throws(
        () =>
            execFileSync(
                env.CUTTLELY_RECOVERY_PYTHON || 'python3',
                ['-I', path.join(install, 'packages/etl/runtime-recovery/cuttlely_session_store.py'), home],
                {
                    input: JSON.stringify([profile + '/state.db']),
                    env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    timeout: 30000
                }
            ),
        (error) => error.status === 1 && String(error.stderr).includes('InvalidTag')
    )
    assert.ok(!fs.existsSync(path.join(home, profile, 'state.db')))
}
