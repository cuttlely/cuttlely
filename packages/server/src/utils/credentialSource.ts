import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { DataSource, In } from 'typeorm'
import { Credential } from '../database/entities/Credential'

// The server build targets CommonJS, and tsc rewrites import() into require().
// require() cannot load the ESM harness package, so keep a real dynamic import.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

export function shouldRegisterCredentialSource(databaseType = process.env.DATABASE_TYPE): boolean {
    const type = String(databaseType || '')
        .trim()
        .toLowerCase()
    return type === 'sqlite' || type === 'postgres'
}

export function makeSource(dataSource: DataSource, CredentialEntity: typeof Credential = Credential) {
    const type = String(process.env.DATABASE_TYPE || '')
        .trim()
        .toLowerCase()
    const dialect = type === 'postgres' ? 'postgres' : 'sqlite'
    return {
        dialect: dialect as 'sqlite' | 'postgres',
        async readRow(id: string) {
            const row = await dataSource.getRepository(CredentialEntity).findOne({
                where: { id },
                select: ['id', 'credentialName', 'encryptedData']
            })
            return row ? { id: row.id, credentialName: row.credentialName, encryptedData: row.encryptedData } : null
        },
        async rows(ids: string[]) {
            if (!ids.length) return []
            const found = await dataSource.getRepository(CredentialEntity).find({
                where: { id: In(ids) },
                select: ['id', 'updatedDate']
            })
            return found.map((row) => ({ id: row.id, updatedDate: row.updatedDate }))
        }
    }
}

async function loadCredentialStore() {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidates = [
            path.join(dir, 'packages', 'harness', 'credential-store.mjs'),
            path.join(dir, 'harness', 'credential-store.mjs')
        ]
        const candidate = candidates.find((item) => fs.existsSync(item))
        if (candidate) return importEsm(pathToFileURL(candidate).href)
        dir = path.dirname(dir)
    }
    throw new Error('Harness module credential-store.mjs was not found.')
}

export async function registerAppCredentialSource(dataSource: DataSource): Promise<void> {
    if (!shouldRegisterCredentialSource()) return
    const { setCredentialSource } = await loadCredentialStore()
    setCredentialSource(makeSource(dataSource))
}
