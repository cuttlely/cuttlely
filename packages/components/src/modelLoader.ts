import axios from 'axios'
import * as fs from 'fs'
import * as path from 'path'
import { INodeOptionsValue } from './Interface'

export enum MODEL_TYPE {
    CHAT = 'chat',
    LLM = 'llm',
    EMBEDDING = 'embedding'
}

const getModelsJSONPath = (): string => {
    const checkModelsPaths = [path.join(__dirname, '..', 'models.json'), path.join(__dirname, '..', '..', 'models.json')]
    for (const checkPath of checkModelsPaths) {
        if (fs.existsSync(checkPath)) {
            return checkPath
        }
    }
    return ''
}

const isValidUrl = (urlString: string) => {
    let url
    try {
        url = new URL(urlString)
    } catch (e) {
        return false
    }
    return url.protocol === 'http:' || url.protocol === 'https:'
}

/**
 * The model list the Cuttlely maintainers keep by hand in this repository (docs/reference/model-list.md).
 * Servers read it from here so new models arrive without a release, and fall back to the copy bundled
 * with this build whenever the fetch fails or returns something that is not a model list.
 * MODEL_LIST_CONFIG_JSON=bundled turns the fetch off; a path or URL there replaces this address.
 */
export const MODEL_LIST_URL = 'https://raw.githubusercontent.com/cuttlely/cuttlely/main/packages/components/models.json'

/** Fetch timeout and refresh interval. Mutable so tests can shorten them. */
export const modelListSettings = {
    timeoutMs: 5000,
    refreshMs: 24 * 60 * 60 * 1000,
    maxBytes: 10 * 1024 * 1024
}

export type ModelListSource = { kind: 'bundled' } | { kind: 'url'; url: string } | { kind: 'file'; path: string }

export const modelListSource = (value: string | undefined = process.env.MODEL_LIST_CONFIG_JSON): ModelListSource => {
    const setting = (value ?? '').trim()
    if (!setting) return { kind: 'url', url: MODEL_LIST_URL }
    if (setting.toLowerCase() === 'bundled') return { kind: 'bundled' }
    if (isValidUrl(setting)) return { kind: 'url', url: setting }
    return { kind: 'file', path: setting }
}

const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)

const isModelEntry = (entry: unknown): boolean =>
    isObject(entry) &&
    typeof entry.name === 'string' &&
    entry.name.length > 0 &&
    (entry.models === undefined ||
        (Array.isArray(entry.models) &&
            entry.models.every(
                (model: unknown) => isObject(model) && typeof model.name === 'string' && typeof model.label === 'string'
            ))) &&
    (entry.regions === undefined || Array.isArray(entry.regions))

/** True when data has the models.json shape: chat, llm and embedding lists of { name, models } entries. */
export const isModelList = (data: unknown): boolean =>
    isObject(data) &&
    Object.values(MODEL_TYPE).every((category) => Array.isArray(data[category]) && data[category].every(isModelEntry)) &&
    Object.values(MODEL_TYPE).some((category) => data[category].length > 0)

const readBundledModelList = async () => {
    const models = await fs.promises.readFile(getModelsJSONPath(), 'utf8')
    return models ? JSON.parse(models) : {}
}

const fetchModelList = async (url: string) => {
    const resp = await axios.get(url, {
        timeout: modelListSettings.timeoutMs,
        signal: AbortSignal.timeout(modelListSettings.timeoutMs),
        maxContentLength: modelListSettings.maxBytes,
        maxRedirects: 3,
        validateStatus: (status) => status === 200
    })
    const data = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data
    if (!isModelList(data)) throw new Error('the response is not a model list')
    return data
}

let cachedList: { url: string; data: any; refreshAt: number } | undefined
let pendingList: { url: string; promise: Promise<any> } | undefined

/** Forget the fetched list. For tests. */
export const resetModelListCache = () => {
    cachedList = undefined
    pendingList = undefined
}

const getModelListFromUrl = async (url: string) => {
    const now = Date.now()
    if (cachedList && cachedList.url === url && now < cachedList.refreshAt) return cachedList.data
    if (pendingList && pendingList.url === url) return pendingList.promise
    const promise = (async () => {
        let data: any
        try {
            data = await fetchModelList(url)
        } catch (error) {
            if (url !== MODEL_LIST_URL) {
                // eslint-disable-next-line no-console
                console.warn(`[Cuttlely] Could not load the model list from ${url} (${(error as Error)?.message}); using the bundled list.`)
            }
            data = await readBundledModelList()
        }
        // A failed fetch also waits for the next refresh, so a server never asks more than once a day.
        cachedList = { url, data, refreshAt: Date.now() + modelListSettings.refreshMs }
        return data
    })()
    pendingList = { url, promise }
    try {
        return await promise
    } finally {
        if (pendingList?.promise === promise) pendingList = undefined
    }
}

/**
 * Load the raw model list: the maintainers' list from MODEL_LIST_URL (5 second timeout, refreshed at most
 * once a day), unless MODEL_LIST_CONFIG_JSON is `bundled`, a file path or another URL. Anything that
 * fails or is not a model list falls back to the models.json bundled with this build.
 */
export const getRawModelFile = async () => {
    const source = modelListSource()
    try {
        if (source.kind === 'url') return await getModelListFromUrl(source.url)
        if (source.kind === 'file') {
            const data = JSON.parse(await fs.promises.readFile(source.path, 'utf8'))
            if (isModelList(data)) return data
        }
    } catch {
        // fall through to the bundled list
    }
    return readBundledModelList()
}

const getModelConfig = async (category: MODEL_TYPE, name: string) => {
    const models = await getRawModelFile()

    const categoryModels = models[category]
    return categoryModels.find((model: INodeOptionsValue) => model.name === name)
}

export const getModelConfigByModelName = async (category: MODEL_TYPE, provider: string | undefined, name: string | undefined) => {
    const models = await getRawModelFile()

    const categoryModels = models[category]
    return getSpecificModelFromCategory(categoryModels, provider, name)
}

const getSpecificModelFromCategory = (categoryModels: any, provider: string | undefined, name: string | undefined) => {
    for (const cm of categoryModels) {
        if (cm.models && cm.name.toLowerCase() === provider?.toLowerCase()) {
            for (const m of cm.models) {
                if (m.name === name) {
                    return m
                }
            }
        }
    }
    return undefined
}

export const getModels = async (category: MODEL_TYPE, name: string) => {
    const returnData: INodeOptionsValue[] = []
    try {
        const modelConfig = await getModelConfig(category, name)
        returnData.push(...modelConfig.models)
        return returnData
    } catch (e) {
        throw new Error(`Error: getModels - ${e}`)
    }
}

export const getRegions = async (category: MODEL_TYPE, name: string) => {
    const returnData: INodeOptionsValue[] = []
    try {
        const modelConfig = await getModelConfig(category, name)
        returnData.push(...modelConfig.regions)
        return returnData
    } catch (e) {
        throw new Error(`Error: getRegions - ${e}`)
    }
}
