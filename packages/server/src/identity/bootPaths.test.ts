/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Static import walk of the boot files.
 */

import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')

const BOOT_ROOTS = [
    'index.ts',
    'utils/constants.ts',
    'routes/index.ts',
    'UsageCacheManager.ts',
    'utils/quotaUsage.ts',
    'commands/worker.ts',
    'queue/QueueManager.ts',
    'queue/ScheduleQueue.ts',
    'schedule/ScheduleExecutor.ts'
]

const FORBIDDEN = /enterprise\/sso\/|Auth0SSO|AzureSSO|GithubSSO|GoogleSSO|initializeSSO|StripeManager/
const VALUE_IDENTITY_MANAGER = /import\s+(?!type\b)[^'"\n]*IdentityManager|require\([^)]*IdentityManager/

function resolveImport(fromRel: string, spec: string): string | undefined {
    const base = path.normalize(path.join(path.dirname(fromRel), spec)).replace(/\\/g, '/')
    if (base === 'enterprise' || base.startsWith('enterprise/')) return undefined
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, 'index.ts').replace(/\\/g, '/')]
    return candidates.find((candidate) => fs.existsSync(path.join(SRC, candidate)) && fs.statSync(path.join(SRC, candidate)).isFile())
}

function walk(rel: string, seen: Set<string>, hits: string[]): void {
    if (seen.has(rel)) return
    if (rel === 'enterprise' || rel.startsWith('enterprise/') || rel === 'IdentityManager.ts') return
    seen.add(rel)
    const abs = path.join(SRC, rel)
    const text = fs.readFileSync(abs, 'utf8')
    if (FORBIDDEN.test(text) || VALUE_IDENTITY_MANAGER.test(text)) hits.push(`${rel}`)
    const importRe = /from ['"](\.[^'"]+)['"]/g
    for (const match of text.matchAll(importRe)) {
        const next = resolveImport(rel, match[1])
        if (next) walk(next, seen, hits)
    }
    const dynamicRe = /import\(['"](\.[^'"]+)['"]\)/g
    for (const match of text.matchAll(dynamicRe)) {
        const next = resolveImport(rel, match[1])
        if (next) walk(next, seen, hits)
    }
}

describe('apache boot paths', () => {
    it('does not import SSO providers, IdentityManager, or StripeManager', () => {
        const hits: string[] = []
        const seen = new Set<string>()
        for (const root of BOOT_ROOTS) walk(root, seen, hits)
        expect(hits).toEqual([])
        expect(seen.has('index.ts')).toBe(true)
    })

    it('does not keep the commercial tree on disk', () => {
        expect(fs.existsSync(path.join(SRC, 'enterprise'))).toBe(false)
        expect(fs.existsSync(path.join(SRC, 'IdentityManager.ts'))).toBe(false)
        expect(fs.existsSync(path.join(SRC, 'StripeManager.ts'))).toBe(false)
    })

    it('has no enterprise import in Apache sources', () => {
        const hits: string[] = []
        const importRe = /(?:from|import|require)\(?\s*['"][^'"]*enterprise\//
        const walkDir = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const abs = path.join(dir, entry.name)
                if (entry.isDirectory()) {
                    if (entry.name === 'enterprise') {
                        hits.push(path.relative(SRC, abs))
                        continue
                    }
                    walkDir(abs)
                    continue
                }
                if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.js')) continue
                const text = fs.readFileSync(abs, 'utf8')
                if (importRe.test(text)) hits.push(path.relative(SRC, abs))
            }
        }
        walkDir(SRC)
        expect(hits).toEqual([])
    })
})
