// Read-only aggregate dry-run. Use the deployment's normal database configuration, preferably on a restored backup.
const { createRequire } = require('node:module')
const path = require('node:path')
const serverRequire = createRequire(path.join(__dirname, '../packages/server/package.json'))
const { getDataSource } = serverRequire('./dist/DataSource.js')
const { planLegacyAccess } = serverRequire('./dist/database/migrations/accessKeyGrants.js')
async function main() {
    const data = getDataSource()
    await data.initialize()
    try {
        const quote = (name) => (['mysql', 'mariadb'].includes(data.options.type) ? '`' + name + '`' : '"' + name + '"')
        const read = (table, fields) => data.query(`SELECT ${fields.map(quote).join(', ')} FROM ${quote(table)}`)
        const keys = await read('apikey', ['id', 'workspaceId', 'harnesses'])
        const flows = await read('chat_flow', ['id', 'name', 'type', 'workspaceId', 'apikeyid'])
        console.log(JSON.stringify(planLegacyAccess(keys, flows).report, null, 2))
    } finally {
        await data.destroy()
    }
}
main().catch(() => {
    console.error('Access key dry-run unavailable. Check database configuration and build the server first.')
    process.exitCode = 1
})
