import path from 'node:path'
import { copySqliteApplication } from './copySqliteApplication'

async function main() {
    const [file, ...extra] = process.argv.slice(2)
    if (!file || extra.length || !path.isAbsolute(file))
        throw new Error(
            'Pass the absolute path to the original database.sqlite. Supply the empty PostgreSQL destination through DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER and DATABASE_PASSWORD.'
        )
    const report = await copySqliteApplication(file, process.env)
    process.stdout.write(JSON.stringify({ tables: report, verified: true }, null, 2) + '\n')
}
void main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : 'The application migration failed.') + '\n')
    process.exitCode = 1
})
