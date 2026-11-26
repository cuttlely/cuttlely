"""Commit runtime session transactions to the application's PostgreSQL database."""
import base64
import hashlib
import hmac
import os
import re
import sqlite3
import ssl
from contextlib import closing, contextmanager
from pathlib import Path
from uuid import uuid4

BLOCK = 256 * 1024


def runtime_path(file):
    if os.getenv("DATABASE_TYPE", "").lower() != "postgres" or os.getenv("CUTTLELY_APP_DATABASE_STORES") not in ("1", "true"):
        return None
    root = os.getenv("CUTTLELY_HERMES_HOME")
    if not root and os.getenv("CUTTLELY_DATA_DIR"):
        root = Path(os.environ["CUTTLELY_DATA_DIR"], "hermes")
    if not root:
        root = os.getenv("HERMES_HOME")
    if not root:
        raise RuntimeError("A runtime home is required for PostgreSQL session storage.")
    try:
        return Path(file).resolve().relative_to(Path(root).resolve()).as_posix()
    except ValueError:
        return None


def scope_for(file):
    name = runtime_path(file)
    return name if name and re.fullmatch(r"(?:profiles/[a-zA-Z0-9_-]+/)?state\.db", name) else None


def connect():
    from pg8000.native import Connection
    ca = os.environ.get("DATABASE_SSL_KEY_BASE64")
    tls = False
    if ca or os.environ.get("DATABASE_SSL") == "true":
        tls = ssl.create_default_context(cadata=base64.b64decode(ca).decode() if ca else None)
        if ca and os.environ.get("DATABASE_REJECT_UNAUTHORIZED") != "true":
            tls.check_hostname = False
            tls.verify_mode = ssl.CERT_NONE
    return Connection(user=os.environ["DATABASE_USER"], host=os.environ["DATABASE_HOST"],
                      port=int(os.environ.get("DATABASE_PORT") or 5432), database=os.environ["DATABASE_NAME"],
                      password=os.environ.get("DATABASE_PASSWORD"), ssl_context=tls, timeout=30)


@contextmanager
def storage(scope, *, writing=False):
    with closing(connect()) as pg:
        pg.run("BEGIN")
        pg.run("SET LOCAL synchronous_commit = on")
        pg.run("SELECT pg_advisory_xact_lock_shared(hashtextextended('cuttlely-side-store-instances',516))")
        exists = pg.run("SELECT to_regclass('cuttlely_storage.upgrade') IS NOT NULL")[0][0]
        phase = pg.run("SELECT state->>'phase' FROM cuttlely_storage.upgrade WHERE id=1")[0][0] if exists else "sqlite"
        if phase == "sqlite":
            yield None
        elif phase == "postgres":
            if writing:
                pg.run("SELECT pg_advisory_xact_lock(hashtextextended(:scope,519))", scope=scope)
            else:
                pg.run("SELECT pg_advisory_xact_lock_shared(hashtextextended(:scope,519))", scope=scope)
            yield pg
        else:
            raise RuntimeError("The application storage upgrade is in progress.")
        pg.run("COMMIT")


def cipher(scope):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    a = os.environ.get("CUTTLELY_SECRETKEY_OVERWRITE")
    b = os.environ.get("FLOWISE_SECRETKEY_OVERWRITE")
    key = a or b or ""
    if not key.strip() or (a and b and a != b):
        raise RuntimeError("The installation encryption key is required to recover runtime sessions.")
    return AESGCM(hmac.digest(key.encode(), b"Cuttlely runtime session v1\0" + scope.encode(), "sha256"))


def image(pg, scope):
    rows = pg.run("SELECT seq, payload FROM cuttlely_runtime.session_blocks WHERE scope=:scope ORDER BY seq", scope=scope)
    crypt = cipher(scope)
    blocks = []
    for position, (seq, data) in enumerate(rows):
        if position != seq:
            raise RuntimeError("Incomplete PostgreSQL runtime session image.")
        blocks.append(crypt.decrypt(data[:12], data[12:], seq.to_bytes(8, "big")))
    blob = b"".join(blocks)
    rows = pg.run("SELECT digest FROM cuttlely_runtime.session_heads WHERE scope=:scope", scope=scope)
    if not rows or not hmac.compare_digest(hashlib.sha256(blob).digest(), rows[0][0]):
        raise RuntimeError("The PostgreSQL runtime session image failed verification.")
    return blob


def memory_db(blob):
    # serialize() includes committed and uncommitted pages, even for a WAL database.
    # The deserialized copy lives in memory and has no WAL file.
    if not blob.startswith(b"SQLite format 3\0") or len(blob) < 100:
        raise RuntimeError("Invalid PostgreSQL runtime session image.")
    db = sqlite3.connect(":memory:", isolation_level=None)
    try:
        db.deserialize(blob[:18] + b"\1\1" + blob[20:])
        db.row_factory = sqlite3.Row
        return db
    except BaseException:
        db.close()
        raise


def head(pg, scope):
    rows = pg.run("SELECT revision FROM cuttlely_runtime.session_heads WHERE scope=:scope", scope=scope)
    return rows[0][0] if rows else None


def local_revision(db):
    if db.execute("SELECT 1 FROM sqlite_schema WHERE name='cuttlely_session_revision'").fetchone():
        row = db.execute("SELECT revision FROM cuttlely_session_revision WHERE id=1").fetchone()
        if row:
            return row[0]
    return None


def persist(pg, scope, db):
    revision = str(uuid4())
    db.execute("CREATE TABLE IF NOT EXISTS cuttlely_session_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision TEXT NOT NULL)")
    db.execute("INSERT OR REPLACE INTO cuttlely_session_revision VALUES(1,?)", (revision,))
    blob = db.serialize()
    crypt = cipher(scope)
    digests = dict(pg.run("SELECT seq,digest FROM cuttlely_runtime.session_blocks WHERE scope=:scope", scope=scope))
    for seq, offset in enumerate(range(0, len(blob), BLOCK)):
        block = blob[offset:offset + BLOCK]
        digest = hashlib.sha256(block).digest()
        if digests.get(seq) == digest:
            continue
        nonce = os.urandom(12)
        payload = nonce + crypt.encrypt(nonce, block, seq.to_bytes(8, "big"))
        pg.run("""INSERT INTO cuttlely_runtime.session_blocks(scope,seq,digest,payload)
                  VALUES(:scope,:seq,:digest,:payload) ON CONFLICT(scope,seq)
                  DO UPDATE SET digest=excluded.digest,payload=excluded.payload""",
               scope=scope, seq=seq, digest=digest, payload=payload)
    pg.run("DELETE FROM cuttlely_runtime.session_blocks WHERE scope=:scope AND seq>=:count",
           scope=scope, count=(len(blob) + BLOCK - 1) // BLOCK)
    pg.run("""INSERT INTO cuttlely_runtime.session_heads(scope,revision,digest) VALUES(:scope,:revision,:digest)
              ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,digest=excluded.digest""",
           scope=scope, revision=revision, digest=hashlib.sha256(blob).digest())


def write(scope, local, fn):
    # Both locks cover the callback. A replacement that lost its cache always loads
    # the last committed PostgreSQL image before it can advance that revision.
    try:
        with storage(scope, writing=True) as pg:
            if pg is not None:
                revision = head(pg, scope)
                if revision and revision != local_revision(local):
                    with closing(memory_db(image(pg, scope))) as current:
                        current.backup(local)
            local.execute("BEGIN IMMEDIATE")
            result = fn(local)
            if pg is not None:
                persist(pg, scope, local)
            else:
                local.commit()
        if pg is not None:
            try:
                local.commit()
            except sqlite3.Error as exc:
                raise RuntimeError("Session saved in PostgreSQL, but its local cache needs to reopen.") from exc
        return result
    except BaseException:
        local.rollback()
        raise


@contextmanager
def read(scope, local):
    with storage(scope) as pg:
        revision = head(pg, scope) if pg is not None else None
        if revision and revision != local_revision(local):
            with closing(memory_db(image(pg, scope))) as current:
                current.row_factory = local.row_factory
                current.execute("PRAGMA query_only=ON")
                yield current
        else:
            yield local


SETTINGS = re.compile(r"(?:profiles/[a-zA-Z0-9_-]+/)?(?:\.env|config\.yaml|SOUL\.md|harness-roster\.json|skills/harness-playbooks/[a-zA-Z0-9_-]+/SKILL\.md)")


def save_setting(target, staged, *, previous=None):
    """Refuse a stale read-modify-write so one replica cannot erase a newer acknowledged edit."""
    name = runtime_path(target)
    if not name or not SETTINGS.fullmatch(name):
        return
    with storage("setting/" + name, writing=True) as pg:
        if pg is None:
            return
        content = Path(staged).read_bytes()
        crypt = cipher("setting/" + name)
        rows = pg.run("SELECT payload FROM cuttlely_runtime.runtime_settings WHERE scope=:name", name=name)
        if rows:
            payload = rows[0][0]
            stored = crypt.decrypt(payload[:12], payload[12:], name.encode())
            if stored == content:
                return
            if previous is None:
                previous = Path(target).read_bytes() if Path(target).is_file() else b""
            if stored != previous:
                raise RuntimeError("Another host saved this setting. Reload the current PostgreSQL copy before editing it again.")
        nonce = os.urandom(12)
        encrypted = crypt.encrypt(nonce, content, name.encode())
        pg.run("""INSERT INTO cuttlely_runtime.runtime_settings(scope,payload) VALUES(:name,:payload)
                  ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload""", name=name, payload=nonce + encrypted)


def restore_setting(pg, file, scope):
    import tempfile
    data = pg.run("SELECT payload FROM cuttlely_runtime.runtime_settings WHERE scope=:name", name=scope)
    if not data:
        return
    payload = data[0][0]
    clear = cipher("setting/" + scope).decrypt(payload[:12], payload[12:], scope.encode())
    if file.is_file() and file.read_bytes() == clear:
        return
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Replace atomically and leave no plaintext staging file after a failed write.
    with tempfile.TemporaryDirectory(dir=file.parent) as tmp:
        staged = Path(tmp, "setting")
        with staged.open("xb") as out:
            os.fchmod(out.fileno(), 0o600)
            out.write(clear)
        os.replace(staged, file)


def bootstrap(root, entries):
    import tempfile
    root = Path(root)
    for scope in entries:
        if not SETTINGS.fullmatch(scope) and not re.fullmatch(r"(?:profiles/[a-zA-Z0-9_-]+/)?state\.db", scope):
            raise RuntimeError("Invalid runtime database path.")
        file = root / scope
        if file.resolve() != root.resolve() / scope:
            raise RuntimeError("A linked runtime database cannot be initialized.")
        with closing(connect()) as pg:
            pg.run("BEGIN")
            pg.run("SET LOCAL synchronous_commit = on")
            pg.run("SELECT pg_advisory_xact_lock(hashtextextended(:key,519))", key="setting/" + scope if SETTINGS.fullmatch(scope) else scope)
            if SETTINGS.fullmatch(scope):
                restore_setting(pg, file, scope)
                pg.run("COMMIT")
                continue
            revision = head(pg, scope)
            if not revision and file.is_file():
                with closing(sqlite3.connect(file.as_uri() + "?mode=ro", uri=True)) as source, closing(sqlite3.connect(":memory:")) as copy:
                    source.backup(copy)
                    if copy.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                        raise RuntimeError("Runtime session database failed verification.")
                    persist(pg, scope, copy)
                    # Verify the encrypted copy through the same path used after disk loss.
                    restored = image(pg, scope)
                    if not hmac.compare_digest(copy.serialize(), restored):
                        raise RuntimeError("Runtime session database copy failed verification.")
            elif revision and not file.exists():
                file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with tempfile.NamedTemporaryFile(dir=file.parent) as stage:
                    with closing(memory_db(image(pg, scope))) as src, closing(sqlite3.connect(stage.name)) as dst:
                        src.backup(dst)
                    try:
                        os.link(stage.name, file)
                    except FileExistsError:
                        pass
            pg.run("COMMIT")


if __name__ == "__main__":
    import json
    import sys
    bootstrap(sys.argv[1], json.load(sys.stdin))
