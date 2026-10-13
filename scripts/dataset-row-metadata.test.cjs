// DatasetRow metadata must load on every supported driver. Postgres rejects a datetime column type.
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire, Module } = require('node:module')
const { describe, it } = require('node:test')

const serverRequire = createRequire(path.join(__dirname, '../packages/server/package.json'))
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
    if (request === '@cuttlely/components') return {}
    return originalLoad.call(this, request, parent, isMain)
}
serverRequire('ts-node').register({
    transpileOnly: true,
    compilerOptions: {
        module: 'commonjs',
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        strict: false,
        skipLibCheck: true,
        target: 'ES2022'
    }
})
const { DataSource } = serverRequire('typeorm')
const { DatasetRow } = serverRequire('./src/database/entities/DatasetRow.ts')
Module._load = originalLoad

function sourceDate(driver) {
    const dataSource = new DataSource({
        type: driver,
        host: '127.0.0.1',
        port: 1,
        username: 'unused',
        password: 'unused',
        database: driver === 'sqlite' ? ':memory:' : 'unused',
        entities: [DatasetRow],
        synchronize: false
    })
    return dataSource.buildMetadatas().then(() => {
        const column = dataSource.getMetadata(DatasetRow).findColumnWithPropertyName('sourceDate')
        assert.ok(column, `${driver} sourceDate column`)
        const normalized = dataSource.driver.normalizeType(column)
        if (driver === 'postgres') assert.match(normalized, /timestamp/)
        if (driver === 'sqlite') assert.equal(normalized, 'datetime')
        if (driver === 'mysql' || driver === 'mariadb') assert.equal(normalized, 'datetime')
    })
}

describe('DatasetRow sourceDate metadata', () => {
    for (const driver of ['postgres', 'mysql', 'mariadb', 'sqlite']) {
        it(`loads sourceDate on the ${driver} driver`, async () => {
            await sourceDate(driver)
        })
    }
})
