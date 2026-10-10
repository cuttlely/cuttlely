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

test('the root Compose file checks health with ping', () => {
    assert.match(service('docker-compose.yml').healthcheck.test.join(' '), /\/api\/v1\/ping/)
})

test('the Dockerfile has a ping health check and names its source repository', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    assert.match(dockerfile, /^HEALTHCHECK .*\n\s+CMD curl -fsS "http:\/\/127\.0\.0\.1:\$\{PORT:-43117\}\/api\/v1\/ping"/m)
    assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/cuttlely\/cuttlely"/)
})

test('.env.example documents CUTTLELY_IMAGE with the published name', () => {
    const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')
    assert.match(env, /^# CUTTLELY_IMAGE=ghcr\.io\/cuttlely\/cuttlely:\d+\.\d+\.\d+$/m)
})
