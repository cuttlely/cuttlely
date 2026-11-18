import { spawnSync } from 'child_process'
import path from 'path'
import { In } from 'typeorm'
import { makeSource, shouldRegisterCredentialSource } from './credentialSource'

describe('credential source registration', () => {
    const originalType = process.env.DATABASE_TYPE

    afterEach(() => {
        if (originalType == null) delete process.env.DATABASE_TYPE
        else process.env.DATABASE_TYPE = originalType
    })

    it.each([
        ['sqlite', true],
        ['postgres', true],
        ['POSTGRES', true],
        [' mysql ', false],
        ['mariadb', false],
        ['', false],
        [undefined, false]
    ])('DATABASE_TYPE=%s registers=%s', (value, expected) => {
        if (value == null) delete process.env.DATABASE_TYPE
        else process.env.DATABASE_TYPE = value
        expect(shouldRegisterCredentialSource(value)).toBe(expected)
    })

    it('rows issues one In(ids) query and readRow uses the repository', async () => {
        process.env.DATABASE_TYPE = 'postgres'
        const find = jest.fn().mockResolvedValue([
            { id: 'b', updatedDate: new Date('2026-11-17T12:00:00.000Z') },
            { id: 'a', updatedDate: new Date('2026-11-17T11:00:00.000Z') }
        ])
        const findOne = jest
            .fn()
            .mockImplementation(async ({ where: { id } }: { where: { id: string } }) =>
                id === 'a' ? { id: 'a', credentialName: 'openAIApi', encryptedData: 'enc' } : null
            )
        const getRepository = jest.fn().mockReturnValue({ find, findOne })
        const dataSource = { getRepository } as any
        const source = makeSource(dataSource)
        expect(source.dialect).toBe('postgres')
        const rows = await source.rows(['b', 'a'])
        expect(getRepository).toHaveBeenCalledTimes(1)
        expect(find).toHaveBeenCalledTimes(1)
        const query = find.mock.calls[0][0]
        expect(query.select).toEqual(['id', 'updatedDate'])
        expect(query.where).toEqual({ id: In(['b', 'a']) })
        expect(rows.map((row) => row.id).sort()).toEqual(['a', 'b'])
        const row = await source.readRow('a')
        expect(findOne).toHaveBeenCalledWith({ where: { id: 'a' }, select: ['id', 'credentialName', 'encryptedData'] })
        expect(row).toEqual({ id: 'a', credentialName: 'openAIApi', encryptedData: 'enc' })
        expect(await source.readRow('missing')).toBeNull()
    })

    it('mysql hosts do not register a source', () => {
        expect(shouldRegisterCredentialSource('mysql')).toBe(false)
        expect(shouldRegisterCredentialSource('mariadb')).toBe(false)
    })
})

describe('split-path SQLite credential rotation', () => {
    it('rotation on a split-path SQLite host updates the stamp and row from the app database, not the secret-path file', () => {
        // Jest maps `typeorm` to a decorator stub and cannot `import()` the ESM
        // harness store without --experimental-vm-modules. The assertions run in a
        // child Node process with the real TypeORM sqlite driver and a real DataSource.
        const child = path.join(__dirname, 'credentialSource.split-path.child.mjs')
        const result = spawnSync(process.execPath, [child], {
            encoding: 'utf8',
            env: process.env
        })
        if (result.status !== 0) {
            throw new Error(`split-path child exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
        }
        expect(result.stdout).toContain('split-path SQLite rotation assertions passed')
    })
})

describe('split-path SQLite with the server DataSource', () => {
    it('the registered source reads and rotates credentials in the DATABASE_PATH database, never the SECRETKEY_PATH file', () => {
        // The child builds the real server DataSource, runs the sqlite migrations on a
        // temp file and calls registerAppCredentialSource with the decorated entity.
        const child = path.join(__dirname, 'credentialSource.server-datasource.child.mjs')
        const result = spawnSync(process.execPath, [child], {
            encoding: 'utf8',
            env: process.env
        })
        if (result.status !== 0) {
            throw new Error(`server DataSource child exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
        }
        expect(result.stdout).toContain('server DataSource split-path assertions passed')
    })
})
