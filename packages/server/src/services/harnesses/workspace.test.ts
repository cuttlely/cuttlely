import { canvasTeamQuery } from './index'

// Jest maps the package name to a decorator stub. The SQL check needs the real driver.
const { DataSource } = require('../../../../../node_modules/typeorm/data-source/DataSource.js')

const CANVAS = '11111111-1111-4111-8111-111111111111'

function generated(type: 'postgres' | 'mysql' | 'sqlite'): string {
    const ds = new DataSource({
        type,
        database: type === 'sqlite' ? ':memory:' : 'harness',
        host: '127.0.0.1',
        username: 'harness',
        password: 'harness'
    })
    return canvasTeamQuery(ds, CANVAS).getQuery()
}

describe('canvas team lookup', () => {
    test('quotes workspaceId for postgres', () => {
        const sql = generated('postgres')
        expect(sql).toContain('"chat_flow"."workspaceId"')
        expect(sql).not.toMatch(/[^"]workspaceId/)
    })

    test('quotes workspaceId for mysql and sqlite', () => {
        expect(generated('mysql')).toContain('`chat_flow`.`workspaceId`')
        expect(generated('sqlite')).toContain('"chat_flow"."workspaceId"')
    })
})
