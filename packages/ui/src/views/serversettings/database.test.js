import { switchValues } from './database'

describe('Switch database', () => {
    it('sends only the choice for SQLite', () => {
        expect(switchValues('sqlite', { DATABASE_HOST: 'x' })).toEqual({ DATABASE_TYPE: 'sqlite' })
    })

    it('sends the Postgres fields, trimmed, with a default port', () => {
        expect(
            switchValues('postgres', {
                DATABASE_HOST: ' db.rosas-bakery.example ',
                DATABASE_PORT: '',
                DATABASE_NAME: 'bakery',
                DATABASE_USER: 'cuttlely',
                DATABASE_PASSWORD: '',
                DATABASE_SSL: 'true'
            })
        ).toEqual({
            DATABASE_TYPE: 'postgres',
            DATABASE_HOST: 'db.rosas-bakery.example',
            DATABASE_PORT: '5432',
            DATABASE_NAME: 'bakery',
            DATABASE_USER: 'cuttlely',
            DATABASE_PASSWORD: '',
            DATABASE_SSL: 'true'
        })
    })
})
