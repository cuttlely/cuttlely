import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

// tsc rewrites import() into require(), which cannot load harness/*.mjs.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<UploadPolicy>

export interface UploadShape {
    rows: number | null
    sheets: string[]
}

export interface UploadQuestionPart {
    mode: 'stub' | 'prepend'
    block: string
    truncated: boolean
    source: unknown
}

export interface UploadPolicy {
    uploadHasText(buffer: Buffer): boolean
    describeSpreadsheet(filename: string, buffer: Buffer): Promise<UploadShape>
    shouldStubUpload(input: { filename?: string; size?: number; rows?: number | null }): boolean
    buildUploadQuestionPart(input: {
        name?: string
        mime?: string
        size?: number
        absolutePath?: string
        rows?: number | null
        sheets?: string[]
        extractedText?: string
        extractedTruncated?: boolean
    }): UploadQuestionPart
    assertAllowlistedUploadPath(candidate: string, roots?: string[]): string
    storageRootFromEnv(env?: NodeJS.ProcessEnv): string
}

let policy: Promise<UploadPolicy> | undefined

export function loadUploadPolicy(): Promise<UploadPolicy> {
    if (!policy) {
        policy = findPolicy().catch((error) => {
            policy = undefined
            throw error
        })
    }
    return policy
}

async function findPolicy(): Promise<UploadPolicy> {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidate = path.join(dir, 'harness', 'uploads.mjs')
        if (fs.existsSync(candidate)) return importEsm(pathToFileURL(candidate).href)
        dir = path.dirname(dir)
    }
    throw new Error('Cuttlely upload policy was not found in this checkout.')
}
