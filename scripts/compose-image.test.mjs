// The Compose files pull the published image and keep a build fallback, and the image
// name matches what pnpm release pushes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defaultImage } from './release.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const yaml = require('js-yaml')
const PUBLISHED = `${defaultImage('cuttlely/cuttlely')}:latest`

function service(file) {
    const doc = yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8'))
    return doc.services.cuttlely
}

for (const [file, context] of [
    ['docker-compose.yml', '.'],
    ['docker/docker-compose.yml', '..']
]) {
    test(`${file} pulls ${PUBLISHED} by default and can still build the root Dockerfile`, () => {
        const Cuttlely = service(file)
        assert.equal(Cuttlely.image, `\${CUTTLELY_IMAGE:-${PUBLISHED}}`)
        assert.equal(Cuttlely.build.context, context)
        assert.equal(Cuttlely.build.dockerfile, 'Dockerfile')
        assert.ok(fs.existsSync(path.join(ROOT, path.dirname(file), context, 'Dockerfile')))
    })
}

test('the image build allowlist names packages that exist and build', () => {
    const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const filters = [...root.scripts['build:docker'].matchAll(/--filter=(\.\/\S+)/g)].map((match) => match[1])
    assert.ok(filters.length > 0, 'build:docker names no directory filters')
    for (const filter of filters) {
        const dir = path.join(ROOT, filter)
        assert.equal(fs.existsSync(dir), true, filter)
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
        assert.equal(typeof manifest.scripts?.build, 'string', `${filter} has no build script`)
        assert.ok(manifest.scripts.build.length > 0, filter)
    }
})

test('the root Compose file checks health with ping', () => {
    assert.match(service('docker-compose.yml').healthcheck.test.join(' '), /\/api\/v1\/ping/)
})

test('the Dockerfile has a ping health check and names its source repository', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    assert.match(dockerfile, /^HEALTHCHECK .*\n\s+CMD curl -fsS "http:\/\/127\.0\.0\.1:\$\{PORT:-43117\}\/api\/v1\/ping"/m)
    assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/cuttlely\/cuttlely"/)
})

test('the geolocation database stays unless the slim build argument is set', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    assert.match(dockerfile, /^ARG CUTTLELY_OMIT_GEOIP=false$/m)
    assert.match(dockerfile, /node scripts\/omit-geoip-database\.mjs/)
    assert.doesNotMatch(dockerfile, /ARG CUTTLELY_OMIT_GEOIP=true/)
    for (const file of ['docker-compose.yml', 'docker/docker-compose.yml']) {
        const doc = yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8'))
        assert.equal(doc.services.cuttlely.build.args.CUTTLELY_OMIT_GEOIP, '${CUTTLELY_OMIT_GEOIP:-false}')
    }
})

test('the image keeps node packs unless INCLUDE_NODE_PACKS=0', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    assert.match(dockerfile, /^ARG INCLUDE_NODE_PACKS=1$/m)
    assert.match(dockerfile, /node scripts\/omit-node-packs\.mjs/)
    assert.match(dockerfile, /node scripts\/build-node-pack-index\.mjs --check/)
    assert.match(dockerfile, /cp packages\/server\/src\/utils\/node-pack-index\.json packages\/server\/dist\/utils\/node-pack-index\.json/)
    const indexBuild = dockerfile.indexOf('node scripts/build-node-pack-index.mjs --check')
    const omitPacks = dockerfile.indexOf('node scripts/omit-node-packs.mjs')
    assert.ok(indexBuild !== -1 && omitPacks > indexBuild, 'the committed pack index is checked before packs are left out')
    assert.match(dockerfile, /\/etc\/cuttlely\/no-node-packs/)
    assert.doesNotMatch(dockerfile, /ARG INCLUDE_NODE_PACKS=0/)
    for (const file of ['docker-compose.yml', 'docker/docker-compose.yml']) {
        const doc = yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8'))
        assert.equal(doc.services.cuttlely.build.args.INCLUDE_NODE_PACKS, '${INCLUDE_NODE_PACKS:-1}')
    }
})

test('the production image checks that the built UI is present and the UI libraries are not', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    assert.match(dockerfile, /node scripts\/check-static-ui-image\.mjs/)
    const install = dockerfile.indexOf('pnpm install --frozen-lockfile --prod')
    const check = dockerfile.indexOf('node scripts/check-static-ui-image.mjs')
    assert.ok(install !== -1 && check > install, 'the UI check runs after the production install')
})

test('the image keeps Chromium unless INCLUDE_BROWSER=0', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    assert.match(dockerfile, /^ARG INCLUDE_BROWSER=1$/m)
    assert.match(dockerfile, /INCLUDE_BROWSER=0 skips Chromium/)
    assert.match(dockerfile, /\/etc\/cuttlely\/no-browser/)
    assert.match(dockerfile, /ln -sfn "\$CHROME" \/usr\/local\/bin\/cuttlely-chromium/)
    for (const file of ['docker-compose.yml', 'docker/docker-compose.yml']) {
        const doc = yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8'))
        assert.equal(doc.services.cuttlely.build.args.INCLUDE_BROWSER, '${INCLUDE_BROWSER:-1}')
    }
})

test('.env.example documents CUTTLELY_IMAGE with the published name', () => {
    const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')
    assert.match(env, /^# CUTTLELY_IMAGE=ghcr\.io\/cuttlely\/cuttlely:\d+\.\d+\.\d+$/m)
})

// Docker's ignore matcher (moby patternmatcher). A copied .turbo cache makes the image
// build treat the UI task as a hit and restore only the outputs in turbo.json. The UI
// writes build/, which this context also excludes, so the hit leaves the image with no UI.
const ESCAPE = new Set('.+()|{}$'.split(''))

function cleanPosix(p) {
    const abs = p.startsWith('/')
    const parts = []
    for (const seg of p.split('/')) {
        if (seg === '' || seg === '.') continue
        if (seg === '..') {
            if (parts.length && parts.at(-1) !== '..') parts.pop()
            else if (!abs) parts.push('..')
            continue
        }
        parts.push(seg)
    }
    const body = parts.join('/')
    if (abs) return `/${body}`
    return body || '.'
}

function parseDockerignore(text) {
    const patterns = []
    for (const raw of String(text).split('\n')) {
        let line = raw.replace(/\r$/, '').trim()
        if (!line || line.startsWith('#')) continue
        line = cleanPosix(line)
        let exclusion = false
        if (line.startsWith('!')) {
            exclusion = true
            line = line.slice(1)
        }
        patterns.push({ exclusion, ...compilePattern(line) })
    }
    return patterns
}

function compilePattern(pattern) {
    let regStr = '^'
    let matchType = 'exact'
    let i = 0
    while (i < pattern.length) {
        const start = i
        const ch = pattern[i]
        i += 1
        if (ch === '*') {
            if (pattern[i] === '*') {
                i += 1
                if (pattern[i] === '/') i += 1
                if (i >= pattern.length) {
                    if (matchType === 'exact') matchType = 'prefix'
                    else {
                        regStr += '.*'
                        matchType = 'regexp'
                    }
                } else {
                    regStr += '(?:.*/)?'
                    matchType = 'regexp'
                }
                if (start === 0) matchType = 'suffix'
            } else {
                regStr += '[^/]*'
                matchType = 'regexp'
            }
        } else if (ch === '?') {
            regStr += '[^/]'
            matchType = 'regexp'
        } else if (ESCAPE.has(ch)) regStr += `\\${ch}`
        else if (ch === '\\') {
            regStr += i < pattern.length ? `\\${pattern[i]}` : '\\'
            if (i < pattern.length) i += 1
            matchType = 'regexp'
        } else if (ch === '[' || ch === ']') {
            regStr += ch
            matchType = 'regexp'
        } else regStr += ch
    }
    if (matchType === 'regexp') return { matchType, pattern, re: new RegExp(`${regStr}$`) }
    return { matchType, pattern }
}

function patternMatches(compiled, file) {
    if (compiled.matchType === 'exact') return file === compiled.pattern
    if (compiled.matchType === 'prefix') return file.startsWith(compiled.pattern.slice(0, -2))
    if (compiled.matchType === 'suffix') {
        const suffix = compiled.pattern.slice(2)
        if (file.endsWith(suffix)) return true
        return suffix.startsWith('/') && file === suffix.slice(1)
    }
    return compiled.re.test(file)
}

function patternHits(compiled, file) {
    if (patternMatches(compiled, file)) return true
    const dir = path.posix.dirname(file)
    if (dir === '.' || dir === file) return false
    const segments = dir.split('/')
    for (let i = 0; i < segments.length; i += 1) {
        if (patternMatches(compiled, segments.slice(0, i + 1).join('/'))) return true
    }
    return false
}

function dockerignoreExcludes(text, file) {
    let matched = false
    for (const pattern of parseDockerignore(text)) {
        if (pattern.exclusion !== matched) continue
        if (patternHits(pattern, file)) matched = !pattern.exclusion
    }
    return matched
}

function packageOutputDirs(root) {
    const dirs = new Set()
    const packages = path.join(root, 'packages')
    for (const name of fs.readdirSync(packages)) {
        const dir = path.join(packages, name)
        if (!fs.statSync(dir).isDirectory()) continue
        const configs = []
        const walk = (current) => {
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue
                const full = path.join(current, entry.name)
                if (entry.isDirectory()) walk(full)
                else if (/^vite\.config\./.test(entry.name) || entry.name === 'tsconfig.json') configs.push(full)
            }
        }
        walk(dir)
        for (const file of configs) {
            const text = fs.readFileSync(file, 'utf8')
            if (file.endsWith('tsconfig.json') && /"noEmit"\s*:\s*true/.test(text)) continue
            const quoted = text.match(/["']outDir["']\s*:\s*["']([^"']+)["']/)
            const vite = text.match(/outDir:\s*["']([^"']+)["']/)
            const resolved = text.match(/outDir:\s*resolve\([^)]*["']([^"']+)["']\s*\)/)
            const value = quoted?.[1] || vite?.[1] || resolved?.[1]
            if (value) dirs.add(path.posix.basename(value.replace(/\/$/, '')))
        }
    }
    return [...dirs].sort()
}

test('the image context excludes the turbo cache, including a cache inside a package', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
    const excluded = [
        '.turbo',
        '.turbo/cache/abc',
        'packages/ui/.turbo',
        'packages/ui/.turbo/turbo-build.log',
        '.cache',
        'packages/ui/.cache/vite',
        '.eslintcache',
        'packages/ui/.eslintcache',
        'app.tsbuildinfo',
        'packages/ui/src/app.tsbuildinfo',
        '.pnpm-store/v1/files',
        '.verify/verify-report.json',
        'coverage/lcov.info',
        'packages/ui/coverage/lcov.info',
        'hermes/agent/__pycache__/mod.pyc',
        'hermes/foo.pyc',
        '.pytest_cache/v/cache',
        'hermes/.pytest_cache/README',
        'hermes/.mypy_cache/3.14',
        'hermes/.ruff_cache/CACHEDIR.TAG',
        'packages/ui/build/index.html',
        'node_modules/turbo/package.json',
        '.env',
        '.env.local'
    ]
    for (const rel of excluded) assert.equal(dockerignoreExcludes(ignore, rel), true, rel)
    for (const rel of ['Dockerfile', 'turbo.json', 'packages/ui/package.json', 'packages/server/src/index.ts', '.env.example']) {
        assert.equal(dockerignoreExcludes(ignore, rel), false, rel)
    }
    const withoutTurbo = ignore
        .split('\n')
        .filter((line) => !['.turbo', '**/.turbo'].includes(line.trim()))
        .join('\n')
    assert.equal(dockerignoreExcludes(withoutTurbo, '.turbo/cache/abc'), false)
    assert.equal(dockerignoreExcludes('.turbo\n**/.turbo\n!.turbo\n!**/.turbo\n', 'packages/ui/.turbo/log'), false)
})

test('turbo build outputs cover every package build folder', () => {
    const turbo = JSON.parse(fs.readFileSync(path.join(ROOT, 'turbo.json'), 'utf8'))
    const outputs = turbo.tasks.build.outputs
    const dirs = packageOutputDirs(ROOT)
    assert.ok(dirs.includes('build'), 'the UI vite build writes build/')
    assert.ok(dirs.includes('dist'))
    for (const dir of dirs) assert.ok(outputs.includes(`${dir}/**`), `${dir}/ is a package build folder`)
    const widget = fs.readFileSync(path.join(ROOT, 'packages/chat-widget/scripts/build.mjs'), 'utf8')
    assert.match(widget, /dist\/chat\.js/)
    assert.ok(outputs.includes('dist/**'))
})
