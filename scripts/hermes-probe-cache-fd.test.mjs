import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = path.join(ROOT, 'hermes')
const python = [process.env.HERMES_PYTHON, path.join(runtime, '.venv/bin/python'), 'python3'].filter(Boolean).find(
    (command) =>
        spawnSync(command, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from hermes_state import SessionDB', runtime], {
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
            timeout: 20_000
        }).status === 0
)

const PREAMBLE = String.raw`
import errno, json, os, pathlib, shutil, sqlite3, subprocess, sys, threading
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
from hermes_state import SessionDB
import hermes_state_dbfile as probes
from hermes_cli.sqlite_safe_read import connect_tracked
root = pathlib.Path(sys.argv[2])

def empty():
    assert not probes._HEADER_PROBE_FDS, probes._HEADER_PROBE_FDS
    assert not probes._HEADER_PROBE_OWNERS, probes._HEADER_PROBE_OWNERS
    assert not probes._UNIDENTIFIED_HEADER_PROBE_FDS, probes._UNIDENTIFIED_HEADER_PROBE_FDS

def identity(path):
    st = path.stat()
    return st.st_dev, st.st_ino

def probe_fd(path):
    assert probes._pread_db_header(path, 16) == b'SQLite format 3\0'
    return probes._HEADER_PROBE_FDS[identity(path)][0]

def closed(fd):
    try:
        os.fstat(fd)
    except OSError as exc:
        assert exc.errno == errno.EBADF, exc
    else:
        raise AssertionError(f'probe descriptor {fd} remains open')

def fd_count():
    return len(os.listdir('/proc/self/fd'))

def plain_db(path, generation=1):
    conn = connect_tracked(path, isolation_level=None, timeout=0.1)
    assert conn.execute('PRAGMA journal_mode=DELETE').fetchone()[0] == 'delete'
    conn.execute('CREATE TABLE IF NOT EXISTS entries (value INTEGER)')
    conn.execute(f'PRAGMA application_id={generation}')
    return conn

CHILD = '''
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1], isolation_level=None, timeout=0.05)
try:
    conn.execute('BEGIN IMMEDIATE')
except sqlite3.OperationalError as exc:
    if 'locked' not in str(exc).lower() and 'busy' not in str(exc).lower():
        raise
    print('busy')
else:
    conn.rollback()
    print('ok')
finally:
    conn.close()
'''

def child_write(path):
    result = subprocess.run([sys.executable, '-c', CHILD, str(path)], capture_output=True,
                            text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()
`

function regression(name, script, { linux = false } = {}) {
    test(
        name,
        {
            skip:
                linux && process.platform !== 'linux'
                    ? 'Linux descriptor and POSIX lock regression'
                    : !python && process.env.CUTTLELY_REQUIRE_HERMES_RUNTIME !== '1'
                    ? 'runtime Python dependencies unavailable'
                    : false
        },
        () => {
            assert(python, 'Runtime Python dependencies are required')
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-probe-cache-'))
            try {
                const result = spawnSync(python, ['-c', `${PREAMBLE}\n${script}\nempty()`, runtime, dir], {
                    cwd: ROOT,
                    encoding: 'utf8',
                    timeout: 60_000,
                    env: { ...process.env, PYTHONPATH: runtime, PYTHONDONTWRITEBYTECODE: '1', HERMES_HOME: dir, HOME: dir }
                })
                assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
            } finally {
                fs.rmSync(dir, { recursive: true, force: true })
            }
        }
    )
}

regression(
    'temporary SessionDB profile churn returns descriptors to the warmed baseline',
    String.raw`
def cycle(number):
    home = root / f'profile-{number}'
    home.mkdir()
    with SessionDB(db_path=home / 'state.db') as db:
        db.create_session(f'probe-{number}', source='api_server')
    shutil.rmtree(home)
    empty()

cycle('warm')
before = fd_count()
for number in range(30):
    cycle(number)
after = fd_count()
assert after == before, {'before': before, 'after': after, 'growth': after - before}
print(json.dumps({'before': before, 'after': after, 'growth': after - before}))
`,
    { linux: true }
)

regression(
    'replacing a path retires each inode until its last owner closes without stale reads or growth',
    String.raw`
path = root / 'state.db'
before = fd_count()
for number in range(30):
    old = plain_db(path, number * 2 + 1)
    old_fd = probe_fd(path)
    old_identity = identity(path)
    path.unlink()
    new = plain_db(path, number * 2 + 2)
    new_fd = probe_fd(path)
    assert identity(path) != old_identity
    assert probes._read_sqlite_application_id(path) == number * 2 + 2
    assert int.from_bytes(os.pread(old_fd, 4, 68), 'big') == number * 2 + 1
    assert old_fd != new_fd
    new.close()
    closed(new_fd)
    os.fstat(old_fd)  # The path changed; this inode still has its original SQLite owner.
    old.close()
    closed(old_fd)
    empty()
    # Legacy probes without a connection owner must use a transient descriptor.
    for _ in range(3):
        assert probes._read_sqlite_application_id(path) == number * 2 + 2
        empty()
    path.unlink()
assert fd_count() == before
`,
    { linux: true }
)

regression(
    'a failed path lookup after open still registers the file-backed connection as an owner',
    String.raw`
path = root / 'state.db'
plain_db(path).close()
empty()

def busy_lookup(target, **kwargs):
    base = kwargs['factory']

    class BusyLookup(base):
        def execute(self, sql, *args):
            if 'database_list' in sql:
                raise sqlite3.OperationalError('database is locked')
            return super().execute(sql, *args)

    kwargs['factory'] = BusyLookup
    return sqlite3.connect(target, **kwargs)

for target, kwargs in ((path, {}), (f'file:{path}?mode=ro', {'uri': True})):
    owner = connect_tracked(target, connect_fn=busy_lookup, **kwargs)
    assert probes._HEADER_PROBE_OWNERS == {identity(path): 1}, probes._HEADER_PROBE_OWNERS
    fd = probe_fd(path)
    peer = plain_db(path)
    peer.close()
    os.fstat(fd)  # the busy-lookup owner still holds the inode
    owner.close()
    closed(fd)
    empty()

memory = connect_tracked(':memory:', connect_fn=busy_lookup)
memory.close()
empty()
`,
    { linux: true }
)

regression(
    'the legacy hosted-room import owns the root state database while it reads it',
    String.raw`
import gateway.hosted_rooms_legacy_import as legacy_import
import hermes_cli.sqlite_safe_read as tracking
source = root / 'state.db'
legacy = plain_db(source)
legacy.execute('CREATE TABLE hosted_rooms (room_id TEXT PRIMARY KEY)')
legacy.close()
empty()
target = sqlite3.connect(root / 'shared-state.db', isolation_level=None)
target.execute('CREATE TABLE hosted_rooms (room_id TEXT PRIMARY KEY)')
seen = []
real = tracking.connect_tracked

def watched(*args, **kwargs):
    conn = real(*args, **kwargs)
    seen.append(dict(probes._HEADER_PROBE_OWNERS))
    return conn

with patch.object(tracking, 'connect_tracked', watched):
    assert legacy_import._copy_rows(target, source) == 0
assert seen == [{identity(source): 1}], seen
target.close()
empty()
`,
    { linux: true }
)

regression(
    'SessionDB peers and an outstanding pooled reader each retain the shared probe',
    String.raw`
path = root / 'state.db'
a = SessionDB(db_path=path)
a.create_session('shared', source='api_server')
b = SessionDB(db_path=path)
fd = probe_fd(path)
# A runtime whose SQLite has the WAL-reset bug keeps new databases in DELETE mode, and then
# there is no pooled reader (_get_read_conn returns None). The SessionDB peers still share the probe.
reader = a._get_read_conn()
try:
    a.close()
    os.fstat(fd)
    assert b.get_session('shared') is not None
    b.close()
    if reader is not None:
        os.fstat(fd)
        assert reader.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 1
finally:
    if reader is not None:
        a._close_read_conn(reader)
    a.close()
    b.close()
closed(fd)
`,
    { linux: true }
)

regression(
    'hard-link aliases share inode ownership and do not close a peer probe',
    String.raw`
path = root / 'state.db'
a = plain_db(path)
alias = root / 'alias.db'
os.link(path, alias)
b = connect_tracked(alias, isolation_level=None)
fd = probe_fd(path)
assert probe_fd(alias) == fd
a.close()
os.fstat(fd)
assert probes._read_sqlite_application_id(alias) == 1
b.close()
closed(fd)
`,
    { linux: true }
)

regression(
    'closing either peer preserves SQLite write locks against an independent child process',
    String.raw`
for mode in ('IMMEDIATE', 'EXCLUSIVE'):
    for locker_index in (0, 1):
        path = root / f'{mode}-{locker_index}.db'
        owners = [plain_db(path), connect_tracked(path, isolation_level=None)]
        locker, peer = owners[locker_index], owners[1 - locker_index]
        fd = probe_fd(path)
        locker.execute(f'BEGIN {mode}')
        assert child_write(path) == 'busy'
        peer.close()
        os.fstat(fd)
        assert child_write(path) == 'busy', 'peer release cancelled the surviving owner write lock'
        locker.commit()
        assert child_write(path) == 'ok'
        locker.close()
        closed(fd)
        assert child_write(path) == 'ok'
        empty()
`,
    { linux: true }
)

regression(
    'failed and cancelled SessionDB opens release probe ownership and failed closes retain it',
    String.raw`
class Cancelled(BaseException):
    pass

for failure in (RuntimeError('setup failed'), Cancelled('setup cancelled')):
    path = root / f'{type(failure).__name__}.db'
    def fail_after_open(db):
        db._conn.execute('CREATE TABLE entries (value INTEGER)')
        probe_fd(db.db_path)
        raise failure
    with patch.object(SessionDB, '_init_schema', fail_after_open):
        try:
            SessionDB(db_path=path)
        except type(failure):
            pass
        else:
            raise AssertionError('fixture did not fail during initialization')
    empty()

path = root / 'wrong-thread.db'
owner = plain_db(path)
fd = probe_fd(path)
errors = []
def wrong_thread_close():
    try:
        owner.close()
    except sqlite3.ProgrammingError as exc:
        errors.append(exc)
thread = threading.Thread(target=wrong_thread_close)
thread.start()
thread.join(5)
assert not thread.is_alive()
assert len(errors) == 1
os.fstat(fd)
assert probes._read_sqlite_application_id(path) == 1
owner.close()
closed(fd)
`,
    { linux: true }
)

regression(
    'a failed probe fstat preserves peer locks and closes unidentified descriptors after the last owner',
    String.raw`
path = root / 'state.db'
owner = plain_db(path)
peer = connect_tracked(path, isolation_level=None)
owner.execute('BEGIN IMMEDIATE')
before_failed = fd_count()
with patch('os.open', wraps=os.open) as raw_open:
    with patch('os.fstat', side_effect=OSError(errno.EIO, 'probe identity unavailable')):
        for _ in range(30):
            assert probes._pread_db_header(path, 16) is None
            assert len(probes._UNIDENTIFIED_HEADER_PROBE_FDS) == 1
            assert fd_count() == before_failed + 1
    assert raw_open.call_count == 1
assert len(probes._UNIDENTIFIED_HEADER_PROBE_FDS) == 1
fd = probes._UNIDENTIFIED_HEADER_PROBE_FDS[0]
os.fstat(fd)
peer.close()
os.fstat(fd)
assert child_write(path) == 'busy', 'fstat failure cleanup cancelled the surviving owner lock'
assert probe_fd(path) == fd, 'identity recovery opened another descriptor instead of reusing the probe'
assert not probes._UNIDENTIFIED_HEADER_PROBE_FDS
assert child_write(path) == 'busy', 'identity recovery cancelled the surviving owner lock'
owner.commit()
assert child_write(path) == 'ok'
owner.close()
closed(fd)
empty()

before = fd_count()
opened = []
real_open = os.open
def record_open(*args, **kwargs):
    fd = real_open(*args, **kwargs)
    opened.append(fd)
    return fd
with patch('os.open', record_open), patch('os.fstat', side_effect=OSError(errno.EIO, 'probe identity unavailable')):
    assert probes._pread_db_header(path, 16) is None
assert len(opened) == 1
closed(opened[0])
assert fd_count() == before
`,
    { linux: true }
)

regression(
    'manual owners preserve replaced-generation locks in either close order with tokens or legacy releases',
    String.raw`
from hermes_cli.sqlite_safe_read import track_connection, untrack_connection

for explicit_token in (False, True):
    for first_index in (0, 1):
        case = root / f'manual-{explicit_token}-{first_index}'
        case.mkdir()
        path, retired = case / 'state.db', case / 'retired.db'
        owners, tokens, fds = [], [], []
        for number in range(2):
            conn = sqlite3.connect(path, isolation_level=None)
            token = track_connection(path)
            conn.execute('CREATE TABLE entries (value INTEGER)')
            conn.execute(f'PRAGMA application_id={number + 1}')
            owners.append(conn)
            tokens.append(token)
            fds.append(probe_fd(path))
            conn.execute('BEGIN IMMEDIATE')
            if number == 0:
                path.rename(retired)
        assert fds[0] != fds[1]
        assert child_write(retired) == 'busy'
        assert child_write(path) == 'busy'
        second_index = 1 - first_index
        owners[first_index].close()
        if explicit_token:
            untrack_connection(path, tokens[first_index])
            closed(fds[first_index])
        else:
            untrack_connection(path)
            # Legacy callers cannot identify which generation closed, so retain both.
            os.fstat(fds[first_index])
        os.fstat(fds[second_index])
        remaining_path = retired if second_index == 0 else path
        assert child_write(remaining_path) == 'busy', 'release closed the surviving generation probe'
        owners[second_index].commit()
        assert child_write(remaining_path) == 'ok'
        owners[second_index].close()
        if explicit_token:
            untrack_connection(path, tokens[second_index])
        else:
            untrack_connection(path)
        for fd in fds:
            closed(fd)
        empty()
`,
    { linux: true }
)

regression(
    'failed connection registration closes SQLite and custom factories release ownership on close',
    String.raw`
import hermes_cli.sqlite_safe_read as tracking
path = root / 'state.db'
plain_db(path).close()
opened = []
def record_connection(*args, **kwargs):
    conn = sqlite3.connect(*args, **kwargs)
    opened.append(conn)
    return conn
with patch.object(tracking, '_acquire_header_probe', return_value=None):
    try:
        connect_tracked(path, connect_fn=record_connection)
    except tracking.UntrackableConnectionError:
        pass
    else:
        raise AssertionError('an unidentified connection escaped registration')
assert len(opened) == 1
try:
    opened[0].execute('SELECT 1')
except sqlite3.ProgrammingError as exc:
    assert 'closed' in str(exc).lower(), exc
else:
    raise AssertionError('registration failure left SQLite open')
empty()

class CustomConnection(sqlite3.Connection):
    closed_by_factory = False
    def close(self):
        super().close()
        self.closed_by_factory = True

owner = connect_tracked(path, factory=CustomConnection)
assert isinstance(owner, CustomConnection)
fd = probe_fd(path)
owner.close()
assert owner.closed_by_factory
closed(fd)
`,
    { linux: true }
)

regression(
    'ledger, repair, stats, and backup helpers share the state database probe lifecycle',
    String.raw`
from gateway import delivery_ledger
from hermes_cli.backup import _query_ro_sqlite
from hermes_state_repair import _connect_repair_durable

path = root / 'state.db'
db = SessionDB(db_path=path)
db.create_session('helper-owners', source='api_server')
fd = probe_fd(path)
repair = _connect_repair_durable(path)
ledger = delivery_ledger._connect()
try:
    db.close()
    os.fstat(fd)
    assert repair.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 1
    repair.close()
    os.fstat(fd)
    assert ledger.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 1
finally:
    repair.close()
    ledger.close()
    db.close()
closed(fd)
empty()
for _ in range(10):
    assert probes.collect_state_db_stats(path)['sessions'] == 1
    value, error = _query_ro_sqlite(path, lambda conn: probe_fd(path) >= 0)
    assert value is True and error is None, error
    empty()
`,
    { linux: true }
)

regression(
    'embedded connections retain inode ownership when the CLI tracking helper is unavailable',
    String.raw`
import builtins
real_import = builtins.__import__
def without_cli_tracking(name, *args, **kwargs):
    if name == 'hermes_cli.sqlite_safe_read':
        raise ImportError('embedded install has no CLI tracking helper')
    return real_import(name, *args, **kwargs)

path = root / 'state.db'
plain_db(path).close()
with patch('builtins.__import__', without_cli_tracking):
    owner = probes._connect_tracked_db(path, isolation_level=None)
fd = probe_fd(path)
peer = connect_tracked(path, isolation_level=None)
owner.execute('BEGIN IMMEDIATE')
peer.close()
os.fstat(fd)
assert child_write(path) == 'busy'
owner.commit()
assert child_write(path) == 'ok'
owner.close()
closed(fd)
empty()
with patch('builtins.__import__', without_cli_tracking):
    owner = probes._connect_tracked_db(path.resolve().as_uri() + '?mode=ro', tracking_path=path,
                                       uri=True)
fd = probe_fd(path)
owner.close()
closed(fd)
`,
    { linux: true }
)

regression(
    'transient probe reads and final release serialize with a concurrent SQLite acquire',
    String.raw`
path = root / 'state.db'
plain_db(path).close()
empty()
for operation in ('read', 'close'):
    entered, finish, started, opened = (threading.Event() for _ in range(4))
    failures = []
    actual_pread, actual_close = os.pread, os.close
    owner = None
    fd = None
    if operation == 'close':
        owner = connect_tracked(path, check_same_thread=False)
        fd = probe_fd(path)
    def pause():
        entered.set()
        assert finish.wait(5), 'fixture timed out waiting to finish probe I/O'
    def pread(probe, size, offset):
        pause()
        return actual_pread(probe, size, offset)
    def close(probe):
        if probe == fd:
            pause()
        return actual_close(probe)
    def release_or_read():
        try:
            if operation == 'close':
                owner.close()
            else:
                assert probes._read_sqlite_application_id(path) == 1
        except BaseException as exc:
            failures.append(exc)
    def acquire():
        try:
            started.set()
            conn = connect_tracked(path)
            opened.set()
            conn.close()
        except BaseException as exc:
            failures.append(exc)
    target = 'os.close' if operation == 'close' else 'os.pread'
    with patch(target, close if operation == 'close' else pread):
        first = threading.Thread(target=release_or_read)
        first.start()
        assert entered.wait(5)
        second = threading.Thread(target=acquire)
        second.start()
        assert started.wait(5)
        assert not opened.wait(0.1), 'SQLite acquire ran before raw probe I/O and close finished'
        finish.set()
        first.join(5)
        second.join(5)
    assert not first.is_alive() and not second.is_alive()
    assert not failures, failures
    assert opened.is_set()
    empty()
`,
    { linux: true }
)
