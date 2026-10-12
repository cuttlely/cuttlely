import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

// tsc rewrites import() into require(), which cannot load the ESM pipeline package.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

const modules = new Map<string, Promise<any>>()

export function loadEtlModule(file: string): Promise<any> {
    let loading = modules.get(file)
    if (!loading) {
        loading = findModule(file).catch((error) => {
            modules.delete(file)
            throw error
        })
        modules.set(file, loading)
    }
    return loading
}

async function findModule(file: string): Promise<any> {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidates = [path.join(dir, 'packages', 'etl', file), path.join(dir, 'etl', file)]
        const candidate = candidates.find((item) => fs.existsSync(item))
        if (candidate) return importEsm(pathToFileURL(candidate).href)
        dir = path.dirname(dir)
    }
    throw new Error(`Cuttlely ETL module ${file} was not found in this checkout.`)
}

export function streamingOnlyError(label: string): Error {
    return new Error(`${label} streams inside an ETL pipeline. Open the ETL menu, add it to a pipeline canvas, and run the pipeline.`)
}
