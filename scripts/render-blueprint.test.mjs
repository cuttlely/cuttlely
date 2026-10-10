import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { imageErrors, loadBlueprint, validateBlueprint } from './render-blueprint.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function minimal(extra = '') {
    return `
previews:
    generation: off
databases:
    - name: cuttlely-db
      plan: basic-1gb
      region: oregon
      databaseName: cuttlely
      user: cuttlely
      postgresMajorVersion: '16'
services:
    - type: web
      name: cuttlely
      runtime: docker
      region: oregon
      plan: pro
      branch: main
      autoDeployTrigger: commit
      healthCheckPath: /api/v1/ping
      dockerfilePath: ./Dockerfile
      dockerContext: .
      numInstances: 1
      disk:
          name: cuttlely-data
          mountPath: /var/cuttlely
          sizeGB: 10
      envVars:
          - key: HOST
            value: 0.0.0.0
          - key: DATABASE_TYPE
            value: postgres
          - key: DATABASE_HOST
            fromDatabase:
                name: cuttlely-db
                property: host
          - key: DATABASE_PORT
            fromDatabase:
                name: cuttlely-db
                property: port
          - key: DATABASE_NAME
            fromDatabase:
                name: cuttlely-db
                property: database
          - key: DATABASE_USER
            fromDatabase:
                name: cuttlely-db
                property: user
          - key: DATABASE_PASSWORD
            fromDatabase:
                name: cuttlely-db
                property: password
          - key: DATABASE_PATH
            value: /var/cuttlely/data
          - key: SECRETKEY_PATH
            value: /var/cuttlely/data
          - key: BLOB_STORAGE_PATH
            value: /var/cuttlely/storage
          - key: CUTTLELY_DATA_DIR
            value: /var/cuttlely
          - key: CUTTLELY_HERMES_HOME
            value: /var/cuttlely/hermes
          - key: HERMES_HOME
            value: /var/cuttlely/hermes
          - key: CUTTLELY_ETL_DIR
            value: /var/cuttlely/etl
          - key: LOG_PATH
            value: /var/cuttlely/logs
          - key: WORKOS_API_KEY
            sync: false
          - key: WORKOS_CLIENT_ID
            sync: false
          - key: WORKOS_REDIRECT_URI
            sync: false
          - key: WORKOS_COOKIE_PASSWORD
            sync: false
          - key: CUTTLELY_BOOTSTRAP_EMAIL
            sync: false
          - key: TRUST_PROXY
            value: "1"
          - key: FLOWISE_SECRETKEY_OVERWRITE
            generateValue: true
${extra}`
}

function messages(text) {
    return validateBlueprint(loadBlueprint(text), text).errors
}

// Split so the source line is not itself a secret-shaped token.
const fakeSk = ['sk', 'notarealkey123'].join('-')
const fakeXai = ['xai', 'notarealkey123'].join('-')
const fakeUrl = ['postgres', '://cuttlely:cuttlely@db/cuttlely'].join('')

describe('render blueprint', () => {
    it('accepts the minimal blueprint', () => {
        const text = minimal()
        const result = validateBlueprint(loadBlueprint(text), text)
        assert.deepEqual(result.errors, [])
        assert.equal(result.ok, true)
    })

    it('rejects a missing disk, a wrong health check, and a free plan', () => {
        const text = minimal()
            .replace('healthCheckPath: /api/v1/ping', 'healthCheckPath: /healthz')
            .replace(/disk:[\s\S]*sizeGB: 10/, 'disk: null')
            .replace('plan: pro', 'plan: free')
        const errors = messages(text)
        assert.ok(errors.some((error) => error.includes('healthCheckPath')))
        assert.ok(errors.some((error) => error.includes('disk')))
        assert.ok(errors.some((error) => error.includes('free')))
    })

    it('rejects a missing database and a DATABASE_URL stand-in', () => {
        const noDb = messages(minimal().replace(/databases:[\s\S]*?services:/, 'services:'))
        assert.ok(noDb.some((error) => error.includes('databases')))
        const urlOnly = messages(
            minimal()
                .replace('value: postgres', 'value: sqlite')
                .replace(
                    `- key: DATABASE_HOST
            fromDatabase:
                name: cuttlely-db
                property: host`,
                    `- key: DATABASE_URL
            value: ${fakeUrl}`
                )
        )
        assert.ok(urlOnly.some((error) => error.includes('DATABASE_URL') || error.includes('literal secret')))
        assert.ok(urlOnly.some((error) => error.includes('DATABASE_TYPE') || error.includes('DATABASE_HOST')))
    })

    it('rejects a literal provider key, a generated key with a value, and a secret in a comment', () => {
        const keyed = messages(
            minimal().replace(
                `- key: WORKOS_API_KEY
            sync: false`,
                `- key: WORKOS_API_KEY
            sync: false
            value: ${fakeSk}`
            )
        )
        assert.ok(keyed.some((error) => error.includes('WORKOS_API_KEY') || error.includes('sk')))

        const providers = messages(`${minimal()}
          - key: OPENAI_API_KEY
            sync: false
          - key: XAI_API_KEY
            sync: false`)
        assert.ok(providers.some((error) => error.includes('OPENAI_API_KEY')))
        assert.ok(providers.some((error) => error.includes('XAI_API_KEY')))

        const generated = messages(
            minimal().replace(
                `- key: FLOWISE_SECRETKEY_OVERWRITE
            generateValue: true`,
                `- key: FLOWISE_SECRETKEY_OVERWRITE
            value: local-dev-key`
            )
        )
        assert.ok(generated.some((error) => error.includes('FLOWISE_SECRETKEY_OVERWRITE')))

        const commented = messages(`${minimal()}\n# example ${fakeXai}\n`)
        assert.ok(commented.some((error) => error.includes('xai')))
    })

    it('rejects a pinned PORT and a path off the disk', () => {
        const errors = messages(
            `${minimal()}
          - key: PORT
            value: "10000"`.replace('value: /var/cuttlely/storage', 'value: /tmp/uploads')
        )
        assert.ok(errors.some((error) => error.includes('PORT')))
        assert.ok(errors.some((error) => error.includes('BLOB_STORAGE_PATH')))
    })

    it('rejects scaling above one instance', () => {
        const errors = messages(minimal().replace('numInstances: 1', 'numInstances: 2'))
        assert.ok(errors.some((error) => error.includes('numInstances')))
    })

    it('checks the Dockerfile starts Hermes on Node 24', () => {
        const bad = imageErrors('FROM node:20-alpine\nCMD ["pnpm", "start"]\n')
        assert.ok(bad.some((error) => error.includes('node:24')))
        assert.ok(bad.some((error) => error.includes('setup-hermes.sh')))
        assert.ok(bad.some((error) => error.includes('start-cuttlely.sh')))
        assert.deepEqual(imageErrors(fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')), [])
    })

    it('rejects wiring the analyst URL to the application database', () => {
        const wired = minimal().replace(
            `- key: DATABASE_PASSWORD
            fromDatabase:
                name: cuttlely-db
                property: password`,
            `- key: DATABASE_PASSWORD
            fromDatabase:
                name: cuttlely-db
                property: password
          - key: CUTTLELY_POSTGRES_URL
            fromDatabase:
                name: cuttlely-db
                property: connectionString`
        )
        const errors = messages(wired)
        assert.ok(errors.some((error) => error.includes('CUTTLELY_POSTGRES_URL') && error.includes('fromDatabase')))

        const literal = messages(`${minimal()}
          - key: CUTTLELY_POSTGRES_URL
            value: ${fakeUrl}`)
        assert.ok(literal.some((error) => error.includes('CUTTLELY_POSTGRES_URL')))

        const switched = messages(`${minimal()}
          - key: CUTTLELY_ANALYST
            value: auto`)
        assert.ok(switched.some((error) => error.includes('CUTTLELY_ANALYST') && error.includes('Dashboard')))
    })

    it('accepts the repo render.yaml', () => {
        const file = path.join(ROOT, 'render.yaml')
        const text = fs.readFileSync(file, 'utf8')
        const result = validateBlueprint(loadBlueprint(text), text)
        assert.deepEqual(result.errors, [])
        assert.equal(result.ok, true)
        const doc = loadBlueprint(text)
        assert.equal(doc.services[0].runtime, 'docker')
        assert.equal(doc.services[0].disk.mountPath, '/var/cuttlely')
        assert.ok(doc.databases[0].name)
        const keys = doc.services[0].envVars.map((entry) => entry.key)
        assert.equal(keys.includes('CUTTLELY_POSTGRES_URL'), false)
        assert.equal(keys.includes('CUTTLELY_ANALYST'), false)
    })
})
