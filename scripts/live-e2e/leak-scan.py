#!/usr/bin/env python3
"""Secret-leak scan for the pressure test. Counts hits only and never prints a match.

Keys come from the environment (PINECONE_API_KEY, OPENAI_API_KEY, XAI_API_KEY, CUTTLELY_GITHUB_PAT) and from the
chat flow API key file (E2E_API_KEYS, default <CUTTLELY_E2E_ROOT>/pt-data/apikeys.json). For each key it counts the full value
and a fingerprint: the first 8 characters followed, inside one token, by the last 4.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
E2E_ROOT = os.environ.get('CUTTLELY_E2E_ROOT') or os.path.join(tempfile.gettempdir(), 'cuttlely-e2e')
PT = os.path.join(E2E_ROOT, 'pt-data')
E2E = os.path.join(E2E_ROOT, 'e2e-data')
KEYS_FILE = os.environ.get('E2E_API_KEYS', os.path.join(PT, 'apikeys.json'))
SECRETS_FILE = os.environ.get('CUTTLELY_SECRETS_FILE', '')
EXCLUDE = {KEYS_FILE}
if SECRETS_FILE:
    EXCLUDE.add(SECRETS_FILE)
SKIP_DIRS = {'node_modules', '.git'}


def needles():
    out = {}
    for name in ('PINECONE_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'CUTTLELY_GITHUB_PAT'):
        value = os.environ.get(name, '')
        if len(value) >= 16:
            out[name] = value
    if os.path.exists(KEYS_FILE):
        for label, row in json.load(open(KEYS_FILE)).items():
            if row.get('key') and len(row['key']) >= 16:
                out[f'chatflow-apikey:{label}'] = row['key']
    return out


def patterns(keys):
    pats = {}
    for name, value in keys.items():
        fp = re.compile(re.escape(value[:8]) + r'[A-Za-z0-9_\-.]{0,300}?' + re.escape(value[-4:]))
        pats[name] = (value, fp)
    return pats


def count(text, pats):
    hits = {}
    for name, (value, fp) in pats.items():
        full = text.count(value)
        fps = len(fp.findall(text))
        if full or fps:
            hits[name] = {'full': full, 'fingerprint': fps}
    return hits


def scan_paths(paths, pats):
    total, files = {}, 0
    for root in paths:
        if not os.path.exists(root):
            continue
        walk = [(root, [], [os.path.basename(root)])] if os.path.isfile(root) else os.walk(root)
        for dirpath, dirnames, filenames in walk:
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for fn in filenames:
                path = root if os.path.isfile(root) else os.path.join(dirpath, fn)
                if path in EXCLUDE or os.path.getsize(path) > 300 * 1024 * 1024:
                    continue
                try:
                    text = open(path, 'rb').read().decode('latin-1')
                except OSError:
                    continue
                files += 1
                for name, h in count(text, pats).items():
                    agg = total.setdefault(name, {'full': 0, 'fingerprint': 0, 'files': 0})
                    agg['full'] += h['full']
                    agg['fingerprint'] += h['fingerprint']
                    agg['files'] += 1
    return {'filesScanned': files, 'hits': total}


def scan_text(text, pats):
    return {'bytes': len(text), 'hits': count(text, pats)}


def main():
    pats = patterns(needles())
    report = {'keys': sorted(pats), 'locations': {}}
    loc = report['locations']
    loc['pt-data logs (server.log, net/metrics jsonl, test logs), both instances'] = scan_paths([os.path.join(PT, 'logs'), os.path.join(PT, 'logs2')], pats)
    tmux = ''
    tmux_socket = os.environ.get('CUTTLELY_E2E_TMUX_SOCKET', '')
    tmux_session = os.environ.get('CUTTLELY_E2E_TMUX_SESSION', 'cuttlely')
    if tmux_socket:
        for win in ('main', 'inst2'):
            tmux += subprocess.run(['tmux', '-L', tmux_socket, 'capture-pane', '-p', '-S', '-', '-t', f'{tmux_session}:{win}'], capture_output=True, text=True).stdout
    loc['server stdout (tmux scrollback, when CUTTLELY_E2E_TMUX_SOCKET is set)'] = scan_text(tmux, pats)
    postgres = os.environ.get('CUTTLELY_E2E_POSTGRES_CONTAINER', '')
    dump = ''
    if postgres:
        dump = subprocess.run(['docker', 'exec', postgres, 'pg_dump', '-U', 'cuttlely', '-d', 'cuttlely', '--data-only'], capture_output=True, text=True).stdout
    tables = {}
    current = None
    for line in dump.split('\n'):
        m = re.match(r'COPY public\.("?[\w]+"?) ', line)
        if m:
            current = m.group(1).strip('"')
            tables[current] = []
        elif line == '\\.':
            current = None
        elif current:
            tables[current].append(line)
    pg = {}
    for table, rows in tables.items():
        hits = count('\n'.join(rows), pats)
        pg[table] = {'rows': len(rows), 'hits': hits} if hits else {'rows': len(rows)}
    loc['Postgres tables (pg_dump --data-only)'] = pg
    loc['ETL control DB / run records (etl.sqlite*, both instances)'] = scan_paths([os.path.join(PT, 'cuttlely', 'etl'), os.path.join(PT, 'cuttlely2')], pats)
    loc['Hermes profiles (e2e-data/cuttlely/hermes, ~/.hermes)'] = scan_paths([os.path.join(E2E, 'cuttlely', 'hermes'), os.path.expanduser('~/.hermes')], pats)
    loc['saved API responses and state (api-evidence.json, state.json, api-state.json, override-confirm)'] = scan_paths(
        [os.path.join(PT, 'api-evidence.json'), os.path.join(PT, 'state.json'), os.path.join(PT, 'api-state.json')], pats
    )
    loc['pt-data other (corpus, flowise storage/uploads, nginx, scripts)'] = scan_paths(
        [os.path.join(PT, name) for name in ('corpus', 'flowise', os.path.join('cuttlely', 'storage'), os.path.join('cuttlely', 'uploads'), 'nginx', 'netcount.cjs')], pats
    )
    loc['old SQLite e2e instance (e2e-data, incl. database.sqlite and logs)'] = scan_paths([E2E], pats)
    loc['test scripts dir (scripts/live-e2e)'] = scan_paths([os.path.join(REPO, 'scripts', 'live-e2e')], pats)
    loc['worktree outside scripts (git-tracked + untracked, no node_modules)'] = scan_paths(
        [os.path.join(REPO, p) for p in subprocess.run(['git', '-C', REPO, 'ls-files', '-co', '--exclude-standard'], capture_output=True, text=True).stdout.split('\n') if p and not p.startswith('scripts/live-e2e')],
        pats,
    )
    loc['/tmp test logs (e2e-*, pt-*)'] = scan_paths([os.path.join('/tmp', f) for f in os.listdir('/tmp') if re.match(r'(e2e|pt)-.*\.(log|json)$', f)], pats)
    json.dump(report, sys.stdout, indent=1)


main()
