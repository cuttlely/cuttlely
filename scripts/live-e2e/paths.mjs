// Live scripts keep state outside the repo. Set CUTTLELY_E2E_ROOT to choose the directory.
import os from 'node:os'
import path from 'node:path'

export const E2E_ROOT = process.env.CUTTLELY_E2E_ROOT ? path.resolve(process.env.CUTTLELY_E2E_ROOT) : path.join(os.tmpdir(), 'cuttlely-e2e')

export const PT_DATA = path.join(E2E_ROOT, 'pt-data')
export const E2E_DATA = path.join(E2E_ROOT, 'e2e-data')

export const pt = (...parts) => path.join(PT_DATA, ...parts)
export const e2e = (...parts) => path.join(E2E_DATA, ...parts)

export function postgresContainer() {
    const name = process.env.CUTTLELY_E2E_POSTGRES_CONTAINER
    if (!name) throw new Error('Set CUTTLELY_E2E_POSTGRES_CONTAINER to the Postgres container name')
    return name
}
