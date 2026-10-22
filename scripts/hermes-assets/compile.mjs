#!/usr/bin/env node
// Recompile scripts/hermes-assets/requirements.txt from requirements.in, pinned with hashes. hermes/uv.lock is the
// constraint, so a shared package (Pillow, packaging, typing-extensions) keeps the version the agent runtime locks.
//
//   node scripts/hermes-assets/compile.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-assets-'))
try {
    const locked = execFileSync('uv', ['export', '--frozen', '--extra', 'mcp', '--no-hashes', '--no-emit-project', '--no-header'], {
        cwd: path.join(ROOT, 'hermes'),
        encoding: 'utf8'
    })
    const constraints = locked
        .split('\n')
        .map((line) => line.replace(/\s*;.*$/, '').trim())
        .filter((line) => line && !line.startsWith('#'))
    fs.writeFileSync(path.join(work, 'constraints.txt'), `${constraints.join('\n')}\n`)
    execFileSync(
        'uv',
        [
            'pip',
            'compile',
            path.join(HERE, 'requirements.in'),
            '-c',
            path.join(work, 'constraints.txt'),
            '--python-version',
            '3.14',
            '--universal',
            '--generate-hashes',
            '--no-header',
            '--no-annotate',
            '-o',
            path.join(HERE, 'requirements.txt')
        ],
        // In hermes/, so the same uv settings apply (exclude-newer) as when scripts/setup-hermes.sh installs the file.
        { cwd: path.join(ROOT, 'hermes'), stdio: 'inherit' }
    )
} finally {
    fs.rmSync(work, { recursive: true, force: true })
}
