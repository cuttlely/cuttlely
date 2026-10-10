import { execFileSync } from 'child_process'
import path from 'path'

// The A3 contention profile and step 5a assume the server's TypeORM runs on sqlite3 6.0.1.
// The check runs in a child process because Jest maps `typeorm` to a mock.
const script = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'check-sqlite-driver.mjs')

describe('sqlite3 driver loaded by the server TypeORM', () => {
    it('resolves sqlite3 6.0.1 from the typeorm package directory and opens a database', () => {
        const output = execFileSync(process.execPath, [script, '--json'], { encoding: 'utf8' })
        const result = JSON.parse(output.trim().split('\n').pop() as string)
        // eslint-disable-next-line no-console -- the version is logged on purpose so CI output shows the loaded driver
        console.log(`server typeorm ${result.typeorm} loads sqlite3 ${result.sqlite3} (SQLite ${result.sqliteLibrary})`)
        expect(result.sqlite3).toBe('6.0.1')
        expect(result.ok).toBe(true)
        expect(result.sqliteLibrary).toMatch(/^3\.\d+\.\d+$/)
    })
})
