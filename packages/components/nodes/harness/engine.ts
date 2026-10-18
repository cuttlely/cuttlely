import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

// Options a chat flow or a server-initiated run hands to harness tools.
export interface HarnessFlowOptions {
    appDataSource?: unknown
    databaseEntities?: unknown
    logger?: unknown
    orgId?: unknown
    workspaceId?: unknown
    chatflowid?: unknown
    callerChatflowId?: unknown
    cachePool?: unknown
    baseURL?: unknown
    componentNodes?: unknown
    usageCacheManager?: unknown
    updateStorageUsage?: unknown
    checkStorage?: unknown
    // Who the run acts for: { via: 'session' }, { via: 'flow' }, or { via: 'api_key', apiKeyId, harnesses }.
    // The engine refuses a run without one, and a key runs only the harnesses on its list.
    harnessCaller?: unknown
}

export interface HarnessRunArgs {
    name: string
    chatId: string
    input: string
    componentNodes?: unknown
    flowOptions?: HarnessFlowOptions
    baseUrl?: string
    fetchImpl?: unknown
    loadNode?: unknown
    forceSpecialistFailure?: unknown
    metadata?: unknown
    timeoutMs?: number
    modelBaseUrl?: string
    onEvent?: (event: { type: string; [key: string]: unknown }) => void
    signal?: AbortSignal
    budgetMs?: number
    source?: string
    traceId?: string
    onRecorded?: (run: unknown) => void
    // Image data URLs or links the user attached. Harness Prime sees them.
    images?: string[]
}

export interface HarnessRuntimeContext {
    componentNodes?: unknown
    loadNode?: unknown
    flowOptions?: HarnessFlowOptions
}

// Roster turns record route, specialists, and handoff. The single-tool path records prepare, fill, and tool.
export type HarnessRunTimings =
    | {
          routeMs: number
          specialistsMs: number
          handoffMs: number
      }
    | {
          prepareMs: number
          fillMs: number
          toolMs: number
      }

// P5 prediction report from harness/run.mjs predictionReport. Tokens stay null when the model reported no usage.
// Direct-tool turns still fill route/handoff with 0 and specialistsMs with the tool time.
export interface HarnessRunReport {
    tokens: {
        prompt: number | null
        completion: number | null
    }
    timings: {
        routeMs: number
        specialistsMs: number
        handoffMs: number
        profileMs: number
    }
    truncated: string[]
}

export interface HarnessRunResult {
    text?: string
    harness?: string
    agents?: unknown
    sources?: unknown
    artifacts?: unknown
    timings: HarnessRunTimings
    report: HarnessRunReport
}

export interface HarnessEngine {
    listHarnesses(): Array<{ name: string; description?: string }>
    runHarness(args: HarnessRunArgs): Promise<HarnessRunResult>
    runQueuedHarness?(args: HarnessRunArgs): Promise<HarnessRunResult>
    assertHarnessWorkspace?(name: string, flowOptions?: HarnessFlowOptions): void
    configureHarnessRuntime(options: {
        contextFor?: (
            record: { chatflowId?: string; workspaceId?: string | null; name?: string } | null
        ) => HarnessRuntimeContext | Promise<HarnessRuntimeContext>
    }): void
    warmHarnessProfiles(options?: { names?: string[]; baseUrl?: string; fetchImpl?: unknown; healthWaitMs?: number }): Promise<unknown>
}

// tsc rewrites import() into require(), which cannot load the ESM harness package.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<HarnessEngine>

let engine: Promise<HarnessEngine> | undefined

export function loadHarnessEngine(): Promise<HarnessEngine> {
    if (!engine) {
        engine = findEngine().catch((error) => {
            engine = undefined
            throw error
        })
    }
    return engine
}

async function findEngine(): Promise<HarnessEngine> {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidates = [path.join(dir, 'packages', 'harness', 'run.mjs'), path.join(dir, 'harness', 'run.mjs')]
        const candidate = candidates.find((file) => fs.existsSync(file))
        if (candidate) return importEsm(pathToFileURL(candidate).href)
        dir = path.dirname(dir)
    }
    throw new Error('Cuttlely harness engine was not found in this checkout.')
}
