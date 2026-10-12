import fs from 'fs'
import path from 'path'
import type { ICommonObject } from '@cuttlely/components'
import type { IMessage, INodeData, INodeOverrides, IVariable, IVariableOverride } from '../Interface'
import logger from './logger'

/** Node id -> node label for every node in the flow being run. The allowlist (`nodeOverrides`) is keyed by label. */
export type FlowNodeLabels = ReadonlyMap<string, string>

type OverrideShape = 'plain' | 'nodeKeyed' | 'foreignKeyed'

// Flowise node ids are `<nodeName>_<n>` (chatOpenAI_0, pinecone_0, llmAgentflow_2).
const NODE_ID_SUFFIX = /_\d+$/

const labelCache = new WeakMap<object, FlowNodeLabels>()
const nodeNameCache = new WeakMap<FlowNodeLabels, Set<string>>()

/** Node names (`pinecone` for `pinecone_0`) of the nodes in this flow, taken from their ids. */
const getFlowNodeNames = (flowNodeLabels: FlowNodeLabels): Set<string> => {
    let names = nodeNameCache.get(flowNodeLabels)
    if (!names) {
        names = new Set<string>()
        for (const id of flowNodeLabels.keys()) if (NODE_ID_SUFFIX.test(id)) names.add(id.replace(NODE_ID_SUFFIX, ''))
        nodeNameCache.set(flowNodeLabels, names)
    }
    return names
}

/** True for a key shaped like another instance of a node type that is in this flow (`pinecone_9` when the flow has `pinecone_0`). */
const isOtherInstanceOfFlowNode = (key: string, flowNodeLabels: FlowNodeLabels): boolean =>
    !flowNodeLabels.has(key) && NODE_ID_SUFFIX.test(key) && getFlowNodeNames(flowNodeLabels).has(key.replace(NODE_ID_SUFFIX, ''))

// Never copied from a request object into another object.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const isPlainObject = (value: unknown): value is ICommonObject =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/**
 * Keys never applied from a request, whatever the allowlist says, because they carry credentials, decide where the
 * server sends traffic (and with it the operator's stored credentials), run as code, name a server path, or pick another
 * server resource by id. Taken from the input names of every node in packages/components/nodes and every credential in
 * packages/components/credentials; the patterns also cover nodes added later.
 */
export const HARD_DENIED_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
    'analytics',
    'credential',
    'FLOWISE_CREDENTIAL_ID',
    'baseOptions',
    'mcpServerConfig'
])
// Credentials: apiKey, unstructuredAPIKey, webhookSecret, callbackSecret, bearerToken, clientKeyPath, caPemPath, password,
// redisCachePwd, passphrase, accessKeyId, sessionToken, refreshToken, Authorization, ...
const CREDENTIAL_KEY =
    /(api_?key|secret|passw(or)?d|pwd|passphrase|bearer|access_?token|auth_?token|refresh_?token|session_?token|access_?key|private_?key|client_?key|pem_?path|authorization|^token$|^auth$|credential)/i
// Base URLs, hosts and endpoints: basePath, basepath, baseURL, baseUrl, apiBase, endpoint, overrideEndpoint, host, jiraHost,
// qdrantServerUrl, chromaURL, requestsGetUrl, mcpUrl, url, urls, ...
const URL_KEY = /(url|uri|urls|host|endpoint|base_?path|api_?base)$/i
// Request headers: headers, requestsGetHeaders, requestsPostHeaders, ... (any key ending in "headers", any case).
const HEADERS_KEY = /headers$/i
// Ports: port, redisCachePort, db_port. A camel-case "Port" suffix only, so "support" or "export" are not ports.
const PORT_KEY = /(^port$|_port$)/i
const CAMEL_PORT_KEY = /[a-z0-9]Port$/
// Tokens: botToken, jwtToken, apifyApiToken, notionIntegrationToken, UPSTASH_VECTOR_REST_TOKEN, ... A singular "token" suffix
// only, so counts such as maxTokens, budgetTokens or maxNewTokens are not tokens.
const TOKEN_SUFFIX_KEY = /[a-z0-9_]token$/i

const lowerSet = (names: readonly string[]): ReadonlySet<string> => new Set(names.map((name) => name.toLowerCase()))

// Inputs the server fetches or opens, by suffix: openApiLink, yamlLink, repoLink (Link/Links) and webPath, caPemPath,
// clientPemPath, excludePaths, includePaths, ignorePath (Path/Paths). URL_KEY above already covers Url/URL/Uri, Endpoint,
// Host, BaseUrl and basePath.
const LINK_KEY = /links?$/i
const PATH_SUFFIX_KEY = /paths?$/i
// Inputs the server fetches or runs whose names carry no suffix: the GitHub loader's API host (githubInstanceApi) and
// the Supergateway MCP node's command line (`arguments`, which takes `--sse <url>` or `--stdio <command>`).
const FETCH_INPUT_NAMES = lowerSet(['githubInstanceApi', 'arguments'])
// File inputs. Every `file` input in packages/components/nodes, and the names mapExtToInputField and
// mapMimeTypeToInputField give uploaded files (the File Loader reads those without declaring them). A value from the request
// is never applied; only a file the server stored from this request's own multipart upload is (setServerUploadOverride).
const FILE_INPUT_NAMES = lowerSet([
    'caFile',
    'csvFile',
    'docxFile',
    'epubFile',
    'excelFile',
    'file',
    'fileObject',
    'jsonFile',
    'jsonlinesFile',
    'openApiFile',
    'pdfFile',
    'powerpointFile',
    'txtFile',
    'yamlFile'
])

/**
 * Credential-declared input names that are also ordinary data keys (a metadata filter's `user` or `version`, a state item's
 * `key` and `value`). Below the top level they are denied only inside a `...Config` object; every other credential name is
 * denied at every depth.
 */
const AMBIGUOUS_CREDENTIAL_INPUT_NAMES = lowerSet([
    'user',
    'username',
    'key',
    'value',
    'version',
    'scope',
    'clientId',
    'projectId',
    'projectID',
    'teamId'
])

// Code inputs by name, a backstop to the `code` input type for flows saved without inputParams (some live in tabs, for
// example updateStateMemoryCode). Every `code` input in packages/components/nodes is listed.
const CODE_INPUT_NAMES = lowerSet([
    'customCode',
    'javascriptFunction',
    'customFunctionJavascriptFunction',
    'messageHistoryCode',
    'stateMemoryCode',
    'updateStateMemoryCode',
    'ifFunction',
    'elseFunction',
    'conditionFunction',
    'messageHistory',
    'jsonSchema',
    'requestsGetQueryParamsSchema',
    'requestsDeleteQueryParamsSchema',
    'requestsPostBodySchema',
    'requestsPutBodySchema'
])
// Server paths: agent memory SQLite file, folder, Notion folder and repository loaders, ETL file sources, CA files, JSON path inputs.
const PATH_INPUT_NAMES = lowerSet(['databaseFilePath', 'filePath', 'folderPath', 'repoPath', 'path', 'paths', 'caFile', 'notionFolder'])

/**
 * asyncOptions / asyncMultiOptions load methods that list server resources by id (flows, document stores, assistants, tools,
 * MCP servers and actions, harnesses, ETL pipelines, files and tables reached with the node's stored credential), and the
 * Loop node's loop-back target (listPreviousNodes).
 * Model-name, region and state-key pickers are not resources and stay with the allowlist. A picker that chooses which model,
 * embeddings or vector store card a node builds is denied separately (NODE_PICKER_NAMES, `loadConfig`).
 */
const RESOURCE_LOAD_METHODS: ReadonlySet<string> = new Set([
    'listTools',
    'listStores',
    'listFlows',
    'listAssistants',
    'listAgentflows',
    'listChatflows',
    'listHarnesses',
    'listPipelines',
    'listNamespaces',
    'listServers',
    'listEndpoints',
    'listActions',
    'listApps',
    'listConnections',
    'listFiles',
    'listSpreadsheets',
    'listTables',
    'listTopics',
    'listPreviousNodes'
])
// The inputs those load methods fill, by name (a backstop when the node definition is not at hand, and for array items).
const RESOURCE_SELECTOR_NAMES = lowerSet([
    'agentSelectedTool',
    'toolAgentflowSelectedTool',
    'selectedTool',
    'documentStore',
    'selectedStore',
    'executeFlowSelectedFlow',
    'selectedFlow',
    'selectedAssistant',
    'selectedAgentflow',
    'selectedChatflow',
    'harnessName',
    'pipeline',
    'etlNamespace',
    'mcpServerId',
    'selectedServer',
    'selectedEndpoints',
    'actions',
    'mcpActions',
    'appName',
    'connectedAccountId',
    'selectedFiles',
    'spreadsheetIds',
    'tableName',
    'topicArn',
    'loopBackToNode'
])

const DENIED_INPUT_TYPES: ReadonlySet<string> = new Set(['password', 'code', 'folder', 'file'])

/**
 * Knowledge lists of the agentflow Agent node. Each item is built into an embeddings, vector store or document store node at
 * run time. A request may not add, replace or edit these items: an item built from request data has no stored credential, and
 * some providers then fall back to keys in the server environment (for example OPENAI_API_KEY or the AWS default chain).
 */
const KNOWLEDGE_ITEM_INPUT_NAMES = lowerSet(['agentKnowledgeVSEmbeddings', 'agentKnowledgeDocumentStores'])
/**
 * Pickers that choose which model, embeddings or vector store card a node builds at run time (agentflow Agent, LLM, Condition
 * Agent and Human Input cards, and the Agent's knowledge items). A request may not switch the card the owner picked: the saved
 * credential stays with the owner's card, and a different provider can then fall back to a key in the server environment.
 * Settings on the owner's card (`agentModelConfig`, `llmModelConfig`, ...) still follow the allowlist. Any other input the
 * node declares with `loadConfig` (a picker whose choice loads a card's settings) is denied by type in isDeniedInputParam.
 */
const NODE_PICKER_NAMES = lowerSet(['agentModel', 'llmModel', 'conditionAgentModel', 'humanInputModel', 'embeddingModel', 'vectorStore'])
// Load methods that pick which embeddings, vector store or model node an array item builds. An array input whose items
// carry one of these is a list of request-buildable nodes, denied like the knowledge lists above.
const NODE_TYPE_PICKER_LOAD_METHODS: ReadonlySet<string> = new Set(['listEmbeddings', 'listVectorStores', 'listModels'])

/**
 * Every input name declared by a credential in packages/components/credentials (snapshot; getCredentialInputNames adds the
 * names of the installed @cuttlely/components credentials). Nodes read these from their inputs before the stored credential
 * (getCredentialParam), and findAvailableConfigs offers them as override params, so a regex is not enough: redisCachePwd,
 * accessKeyId, sessionToken, azureOpenAIApiInstanceName (which picks the Azure host) and others.
 */
export const CREDENTIAL_INPUT_NAMES_SNAPSHOT: readonly string[] = [
    'UPSTASH_VECTOR_REST_TOKEN',
    'UPSTASH_VECTOR_REST_URL',
    'accessKey',
    'accessToken',
    'accessTokenUrl',
    'additionalParameters',
    'agentflowApiKey',
    'alibabaApiKey',
    'anthropicApiKey',
    'apiKey',
    'apiVersion',
    'apifyApiToken',
    'applicationToken',
    'arizeApiKey',
    'arizeEndpoint',
    'arizeSpaceId',
    'assemblyAIApiKey',
    'authorizationUrl',
    'awsKey',
    'awsSecret',
    'awsSession',
    'azureFoundryApiKey',
    'azureFoundryEndpoint',
    'azureOpenAIApiDeploymentName',
    'azureOpenAIApiInstanceName',
    'azureOpenAIApiKey',
    'azureOpenAIApiVersion',
    'azureSubscriptionKey',
    'baseURL',
    'basicAuthPassword',
    'basicAuthUsername',
    'bearerToken',
    'botToken',
    'braveApiKey',
    'browserlessApiToken',
    'cerebrasApiKey',
    'chatflowApiKey',
    'chromaApiKey',
    'chromaDatabase',
    'chromaTenant',
    'clientId',
    'clientSecret',
    'cloudId',
    'cloudflareAccountId',
    'cloudflareApiToken',
    'cohereApiKey',
    'cometApiKey',
    'composioApi',
    'connectionString',
    'corpusID',
    'customerID',
    'dbEndPoint',
    'deepseekApiKey',
    'e2bApiKey',
    'elevenLabsApiKey',
    'endpoint',
    'exaSearchApiKey',
    'externalId',
    'firecrawlApiToken',
    'firecrawlApiUrl',
    'fireworksApiKey',
    'googleApplicationCredential',
    'googleApplicationCredentialFilePath',
    'googleCustomSearchApiId',
    'googleCustomSearchApiKey',
    'googleGenerativeAPIKey',
    'googleMakerSuiteKey',
    'groqApiKey',
    'huggingFaceApiKey',
    'jinaAIAPIKey',
    'jwtToken',
    'key',
    'langFuseEndpoint',
    'langFusePublicKey',
    'langFuseSecretKey',
    'langSmithApiKey',
    'langSmithEndpoint',
    'langWatchApiKey',
    'langWatchEndpoint',
    'litellmApiKey',
    'localAIApiKey',
    'lunaryAppId',
    'lunaryEndpoint',
    'meilisearchAdminApiKey',
    'meilisearchSearchApiKey',
    'milvusPassword',
    'milvusUser',
    'mistralAIAPIKey',
    'momentoApiKey',
    'momentoCache',
    'momentoEndpoint',
    'mongoDBConnectUrl',
    'notionIntegrationToken',
    'nvidiaNIMApiKey',
    'oauthScopes',
    'ollamaApiKey',
    'openAIApiKey',
    'openRouterApiKey',
    'openSearchUrl',
    'opikApiKey',
    'opikUrl',
    'opikWorkspace',
    'password',
    'perplexityApiKey',
    'personalAccessToken',
    'phoenixApiKey',
    'phoenixEndpoint',
    'pineconeApiKey',
    'postgresUrl',
    'projectID',
    'projectId',
    'qdrantApiKey',
    'qianfanAccessKey',
    'qianfanSecretKey',
    'redisCacheHost',
    'redisCachePort',
    'redisCachePwd',
    'redisCacheSslEnabled',
    'redisCacheUser',
    'redisUrl',
    'replicateApiKey',
    'roleArn',
    'sambanovaApiKey',
    'scope',
    'searchApiKey',
    'secretAccessKey',
    'serpApiKey',
    'serperApiKey',
    'serviceRegion',
    'serviceUrl',
    'spiderApiKey',
    'stripeApiToken',
    'supabaseApiKey',
    'tavilyApiKey',
    'tdHostIp',
    'tdPassword',
    'tdUsername',
    'teamId',
    'togetherAIApiKey',
    'token',
    'unstructuredAPIKey',
    'upstashConnectionToken',
    'upstashConnectionUrl',
    'upstashRestToken',
    'url',
    'user',
    'username',
    'value',
    'version',
    'watsonxAIApikey',
    'watsonxAIAuthType',
    'watsonxAIBearerToken',
    'weaviateApiKey',
    'wolframAlphaAppId',
    'xaiApiKey'
]

let credentialInputNames: ReadonlySet<string> | undefined

/** Lower-case names of every credential-declared input: the snapshot plus the installed credential definitions. */
export const getCredentialInputNames = (): ReadonlySet<string> => {
    if (credentialInputNames) return credentialInputNames
    const names = new Set(CREDENTIAL_INPUT_NAMES_SNAPSHOT.map((name) => name.toLowerCase()))
    try {
        const dir = path.join(path.dirname(require.resolve('@cuttlely/components')), '..', 'credentials')
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.credential.js')) continue
            try {
                const mod = require(path.join(dir, file))
                const credential = typeof mod?.credClass === 'function' ? new mod.credClass() : undefined
                for (const input of credential?.inputs ?? []) if (typeof input?.name === 'string') names.add(input.name.toLowerCase())
            } catch (e) {
                // the snapshot still applies
            }
        }
    } catch (e) {
        // the snapshot still applies
    }
    credentialInputNames = names
    return names
}

/** The node input definitions the hard deny reads (node `inputParams`, including tab children and array item fields). */
export interface OverrideInputParam {
    name?: string
    type?: string
    loadMethod?: string
    loadConfig?: boolean
    array?: OverrideInputParam[]
    tabs?: OverrideInputParam[]
}

const findInputParam = (params: readonly OverrideInputParam[] | undefined, key: string): OverrideInputParam | undefined => {
    if (!Array.isArray(params)) return undefined
    for (const param of params) {
        if (param?.name === key) return param
        // A tab's children are top-level inputs of the node (updateStateMemoryCode under updateStateMemory).
        const inTab = Array.isArray(param?.tabs) ? findInputParam(param.tabs, key) : undefined
        if (inTab) return inTab
    }
    return undefined
}

const isDeniedInputParam = (param: OverrideInputParam | undefined, fileInputs = true): boolean => {
    if (!param) return false
    if (param.type === 'file') return fileInputs
    if (param.type && DENIED_INPUT_TYPES.has(param.type)) return true
    // A picker whose choice loads another card's settings chooses which card the node builds.
    if ((param.type === 'asyncOptions' || param.type === 'asyncMultiOptions') && param.loadConfig === true) return true
    if (
        param.type === 'array' &&
        Array.isArray(param.array) &&
        param.array.some(
            (item) =>
                (item?.type === 'asyncOptions' || item?.type === 'asyncMultiOptions') &&
                NODE_TYPE_PICKER_LOAD_METHODS.has(item?.loadMethod ?? '')
        )
    )
        return true
    return (param.type === 'asyncOptions' || param.type === 'asyncMultiOptions') && RESOURCE_LOAD_METHODS.has(param.loadMethod ?? '')
}

/**
 * Which credential-declared input names a name check applies: `all` for top-level keys and keys inside a `...Config` object
 * (the places a node reads them as inputs), `unambiguous` for other nested keys (all but AMBIGUOUS_CREDENTIAL_INPUT_NAMES),
 * `none` for var names and state keys.
 */
type CredentialNameRule = 'all' | 'unambiguous' | 'none'

/** Name rules shared by top-level keys, nested keys, var names and state keys. `fileInputs` false skips only the file names. */
const isHardDeniedName = (key: string, credentialNames: CredentialNameRule, fileInputs = true): boolean => {
    const lower = key.toLowerCase()
    if (UNSAFE_KEYS.has(key)) return true
    if (HARD_DENIED_OVERRIDE_KEYS.has(key) || [...HARD_DENIED_OVERRIDE_KEYS].some((name) => name.toLowerCase() === lower)) return true
    if (CODE_INPUT_NAMES.has(lower) || PATH_INPUT_NAMES.has(lower) || RESOURCE_SELECTOR_NAMES.has(lower)) return true
    if (KNOWLEDGE_ITEM_INPUT_NAMES.has(lower) || NODE_PICKER_NAMES.has(lower)) return true
    if (FETCH_INPUT_NAMES.has(lower) || LINK_KEY.test(key) || PATH_SUFFIX_KEY.test(key)) return true
    if (fileInputs && FILE_INPUT_NAMES.has(lower)) return true
    // The loadConfig companion of a resource selector (agentSelectedToolConfig, selectedToolConfig, ...).
    if (lower.endsWith('config') && RESOURCE_SELECTOR_NAMES.has(lower.slice(0, -'config'.length))) return true
    if (
        CREDENTIAL_KEY.test(key) ||
        TOKEN_SUFFIX_KEY.test(key) ||
        URL_KEY.test(key) ||
        HEADERS_KEY.test(key) ||
        PORT_KEY.test(key) ||
        CAMEL_PORT_KEY.test(key)
    )
        return true
    if (credentialNames === 'none' || !getCredentialInputNames().has(lower)) return false
    return credentialNames === 'all' || !AMBIGUOUS_CREDENTIAL_INPUT_NAMES.has(lower)
}

/**
 * True when `key` is hard-denied as a top-level override key: a known credential or tracer key; a name that marks a credential,
 * a base URL, host, endpoint, link, path, port, headers, code, a server path, a fetched host or command line, or a file; a
 * resource selector; a model, embeddings or vector store card picker; an Agent knowledge list; any credential-declared input
 * name; or a key the node itself declares as a `password`, `code`, `folder` or `file` input, as a resource-picking or
 * `loadConfig` asyncOptions input, or as an array whose items pick an embeddings, vector store or model node.
 */
export const isHardDeniedOverrideKey = (key: string, inputParams?: readonly OverrideInputParam[]): boolean =>
    isHardDeniedName(key, 'all') || isDeniedInputParam(findInputParam(inputParams, key))

/** True when `key` is a file input (by name, or by the node's declared `file` type). */
export const isFileInputKey = (key: string, inputParams?: readonly OverrideInputParam[]): boolean =>
    FILE_INPUT_NAMES.has(key.toLowerCase()) || findInputParam(inputParams, key)?.type === 'file'

// File values the server itself stored from the request's multipart upload, per overrideConfig object and key. A value
// the client sent under the same key is never in here, so it stays hard-denied.
const serverUploads = new WeakMap<object, Map<string, string>>()

/**
 * Puts a file the server stored from this request's multipart upload (`FILE-STORAGE::[...]`) on `overrideConfig[field]`
 * and records it as server-made. A later upload to the same field in the same request is appended; a value the client sent in
 * that field is replaced, never merged.
 */
export const setServerUploadOverride = (overrideConfig: ICommonObject, field: string, storagePath: string): void => {
    const marks = serverUploads.get(overrideConfig) ?? new Map<string, string>()
    const previous = marks.get(field)
    let value = storagePath
    if (previous !== undefined && overrideConfig[field] === previous) {
        const names = [...JSON.parse(previous.replace('FILE-STORAGE::', '')), ...JSON.parse(storagePath.replace('FILE-STORAGE::', ''))]
        value = `FILE-STORAGE::${JSON.stringify(names)}`
    }
    overrideConfig[field] = value
    marks.set(field, value)
    serverUploads.set(overrideConfig, marks)
}

/** True when `overrideConfig[key]` is still exactly the value setServerUploadOverride put there. */
export const isServerUploadOverride = (overrideConfig: ICommonObject, key: string): boolean => {
    const value = serverUploads.get(overrideConfig)?.get(key)
    return value !== undefined && overrideConfig[key] === value
}

/**
 * A server-stored upload on a file input that no other rule denies. It still has to be allowlisted for the node.
 */
const isAllowedServerUpload = (overrideConfig: ICommonObject, key: string, inputParams?: readonly OverrideInputParam[]): boolean =>
    isServerUploadOverride(overrideConfig, key) &&
    isFileInputKey(key, inputParams) &&
    !isHardDeniedName(key, 'all', false) &&
    !isDeniedInputParam(findInputParam(inputParams, key), false)

/** Objects and arrays inside an allowed value are checked to this depth; anything deeper drops the whole value. */
export const MAX_OVERRIDE_DEPTH = 8

type NestedVerdict = 'ok' | 'denied' | 'tooDeep'

/**
 * Walks an allowed value (objects, arrays and JSON object or array strings) and reports a hard-denied key at any level, or
 * nesting deeper than MAX_OVERRIDE_DEPTH. The top-level value is depth 1. `itemParams` are the array item fields of the
 * node's `array` input, checked by type on the items' keys. When `trail` is given and the value is denied, it is filled
 * with the path to the denied key (keys and `[index]` items), for logging; values are never recorded.
 */
const checkNestedValue = (
    value: unknown,
    depth: number,
    credentialInputs: boolean,
    itemParams?: readonly OverrideInputParam[],
    trail?: string[]
): NestedVerdict => {
    if (typeof value === 'string') {
        const text = value.trim()
        if (!(text.startsWith('{') || text.startsWith('['))) return 'ok'
        try {
            const parsed = JSON.parse(text)
            return parsed !== null && typeof parsed === 'object'
                ? checkNestedValue(parsed, depth, credentialInputs, itemParams, trail)
                : 'ok'
        } catch (e) {
            return 'ok'
        }
    }
    if (value === null || typeof value !== 'object') return 'ok'
    if (depth > MAX_OVERRIDE_DEPTH) return 'tooDeep'
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const verdict = checkNestedValue(value[i], depth + 1, credentialInputs, itemParams, trail)
            if (verdict !== 'ok') {
                if (verdict === 'denied') trail?.unshift(`[${i}]`)
                return verdict
            }
        }
        return 'ok'
    }
    for (const key of Object.keys(value)) {
        const credentialNames = credentialInputs ? 'all' : 'unambiguous'
        if (isHardDeniedName(key, credentialNames) || isDeniedInputParam(findInputParam(itemParams, key))) {
            trail?.unshift(key)
            return 'denied'
        }
        // All credential names, the ambiguous ones included, are checked from here down once any key on the path is a
        // `...Config` object (agentKnowledgeVSEmbeddings[].embeddingModelConfig becomes the embeddings node's inputs).
        const verdict = checkNestedValue(
            (value as ICommonObject)[key],
            depth + 1,
            credentialInputs || key.toLowerCase().endsWith('config'),
            undefined,
            trail
        )
        if (verdict !== 'ok') {
            if (verdict === 'denied') trail?.unshift(key)
            return verdict
        }
    }
    return 'ok'
}

/** The nested check for the value of top-level key `config` on a node with `inputParams`. */
const checkOverrideValue = (config: string, value: unknown, inputParams?: readonly OverrideInputParam[]): NestedVerdict =>
    checkNestedValue(value, 1, config.toLowerCase().endsWith('config'), findInputParam(inputParams, config)?.array)

const HARD_DENIED_REASON = 'hard-denied, never overridable'
const NESTED_DENIED_REASON = 'hard-denied key inside the value'
const TOO_DEEP_REASON = `value nested deeper than ${MAX_OVERRIDE_DEPTH} levels`

/**
 * Builds (once per nodes array) the node id -> label map that replaceInputsWithConfig needs.
 */
export const getFlowNodeLabels = (nodes: { id: string; data?: { label?: string } }[]): FlowNodeLabels => {
    const cached = labelCache.get(nodes)
    if (cached) return cached
    const labels = new Map<string, string>()
    for (const node of nodes ?? []) {
        if (node?.id) labels.set(node.id, node.data?.label ?? '')
    }
    labelCache.set(nodes, labels)
    return labels
}

/**
 * True only when the chatflow's API override allowlist enables `paramName` on nodes labelled `nodeLabel`.
 * A missing entry, a malformed entry, or `enabled` that is not strictly `true` is false.
 */
export const isParameterEnabled = (nodeOverrides: INodeOverrides | undefined | null, nodeLabel: string, paramName: string): boolean => {
    if (!nodeOverrides || typeof nodeOverrides !== 'object') return false
    if (!Object.prototype.hasOwnProperty.call(nodeOverrides, nodeLabel)) return false
    const params = nodeOverrides[nodeLabel]
    if (!Array.isArray(params)) return false
    return params.some((param) => param?.name === paramName && param?.enabled === true)
}

// Log lines name keys only after sanitizing them; raw client strings and values are never logged.
const MAX_LOGGED_KEYS = 20
const MAX_LOGGED_KEY_LENGTH = 64

/** One key for a log line: characters outside [A-Za-z0-9._-] become `_`, then cut to 64 characters. */
export const sanitizeLogKey = (key: unknown): string =>
    String(key)
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, MAX_LOGGED_KEY_LENGTH)

/** Up to 20 sanitized keys, comma separated, with `(+N more)` when there are more. */
export const formatLogKeys = (keys: readonly unknown[]): string => {
    const shown = keys.slice(0, MAX_LOGGED_KEYS).map(sanitizeLogKey).join(', ')
    return keys.length > MAX_LOGGED_KEYS ? `${shown} (+${keys.length - MAX_LOGGED_KEYS} more)` : shown
}

// Each key is reported at most once per request (overrideConfig object) and reason.
const warned = new WeakMap<object, Set<string>>()

/** Ignored keys collected while one node is processed, flushed as one warn line per reason. */
type IgnoredKeys = Map<string, string[]>

const noteIgnored = (ignored: IgnoredKeys, reason: string, ...keys: string[]) => {
    const list = ignored.get(reason) ?? []
    list.push(...keys)
    ignored.set(reason, list)
}

/** Logs the count and the sanitized names of keys not already reported for this request and reason. */
const flushIgnored = (overrideConfig: ICommonObject, ignored: IgnoredKeys, label = 'overrideConfig') => {
    let seen = warned.get(overrideConfig)
    if (!seen) {
        seen = new Set()
        warned.set(overrideConfig, seen)
    }
    for (const [reason, keys] of ignored) {
        const fresh: string[] = []
        for (const key of keys) {
            const id = `${label}|${reason}|${key}`
            if (seen.has(id)) continue
            seen.add(id)
            fresh.push(key)
        }
        if (fresh.length) logger.warn(`[server]: ${label}: ${fresh.length} ignored (${reason}): ${formatLogKeys(fresh)}`)
    }
}

const warnIgnored = (overrideConfig: ICommonObject, reason: string, keys: string[], label = 'overrideConfig') =>
    flushIgnored(overrideConfig, new Map([[reason, keys]]), label)

const classify = (value: unknown, flowNodeLabels: FlowNodeLabels): OverrideShape => {
    if (!isPlainObject(value)) return 'plain'
    const keys = Object.keys(value)
    if (keys.length === 0) return 'plain'
    const inFlow = keys.filter((key) => flowNodeLabels.has(key))
    if (inFlow.length === keys.length) return 'nodeKeyed'
    if (inFlow.length > 0) return 'foreignKeyed' // node ids mixed with other keys
    // Decided against this flow's node ids, not a pattern: `pinecone_9` is foreign when the flow has `pinecone_0` but no
    // `pinecone_9`. A key such as `chapter_1` that names no node type in the flow keeps the object a plain value.
    if (keys.some((key) => isOtherInstanceOfFlowNode(key, flowNodeLabels))) return 'foreignKeyed'
    return 'plain'
}

const mergeObjectValue = (existingValue: unknown, overrideValue: ICommonObject) => {
    if (isPlainObject(existingValue)) return Object.assign({}, existingValue, overrideValue)
    if (typeof existingValue === 'string' && existingValue.startsWith('{') && existingValue.endsWith('}')) {
        try {
            const parsedExisting = JSON.parse(existingValue)
            if (isPlainObject(parsedExisting)) return Object.assign({}, parsedExisting, overrideValue)
        } catch (e) {
            // not JSON; the override replaces it
        }
    }
    return overrideValue
}

// Allowed values keep today's merge semantics. Falsy values (0, false, '') apply; only undefined and null are skipped.
// A plain array concatenates (unique) with an existing array; a node-keyed array replaces it, as on main.
const applyValue = (inputs: ICommonObject, config: string, value: unknown, nodeKeyed = false) => {
    if (value === undefined || value === null) return
    const existingValue = inputs[config]
    if (Array.isArray(value)) {
        inputs[config] = !nodeKeyed && Array.isArray(existingValue) ? [...new Set([...existingValue, ...value])] : value
    } else if (isPlainObject(value)) {
        inputs[config] = mergeObjectValue(existingValue, value)
    } else if (typeof value === 'object') {
        return // class instances and the like never come from JSON
    } else if (value === 'true') {
        inputs[config] = true
    } else if (value === 'false') {
        inputs[config] = false
    } else {
        inputs[config] = value
    }
}

// startState is checked per key against the Start node's declared state; every other allowed value uses applyValue.
const applyOne = (inputs: ICommonObject, config: string, value: unknown, overrideConfig: ICommonObject, nodeKeyed = false) => {
    if (config === 'startState') applyStartState(inputs, filterStartStateOverride(value, inputs.startState, overrideConfig))
    else applyValue(inputs, config, value, nodeKeyed)
}

/**
 * Keeps only the variables enabled in `variableOverrides`, in place on `overrideConfig.vars`.
 * Returns the kept variables (empty object when none).
 */
const filterVarsInPlace = (overrideConfig: ICommonObject, variableOverrides: IVariableOverride[]): ICommonObject => {
    const vars = overrideConfig.vars
    if (!isPlainObject(vars)) {
        // A string, array, number or class instance is never accepted as vars.
        warnIgnored(overrideConfig, 'not an object', ['vars'])
        delete overrideConfig.vars
        return {}
    }
    const filtered = pickAllowedVars(vars, variableOverrides)
    const dropped = Object.keys(vars).filter((name) => !Object.prototype.hasOwnProperty.call(filtered, name))
    const denied = dropped.filter((name) => isHardDeniedName(name, 'none'))
    const notAllowed = dropped.filter((name) => !isHardDeniedName(name, 'none'))
    if (denied.length) warnIgnored(overrideConfig, HARD_DENIED_REASON, denied, 'overrideConfig.vars')
    if (notAllowed.length) warnIgnored(overrideConfig, 'variable not allowlisted', notAllowed, 'overrideConfig.vars')
    overrideConfig.vars = filtered
    return filtered
}

/**
 * The request vars whose names are enabled (`enabled === true`) in `variableOverrides`, checked key by key. Hard-denied names
 * (the same name rules as override keys, for example `apiUrl`) and prototype keys are never copied, even when enabled.
 * A non-object `vars` gives an empty object.
 */
const pickAllowedVars = (vars: unknown, variableOverrides: IVariableOverride[] | undefined): ICommonObject => {
    const allowed: ICommonObject = {}
    if (!isPlainObject(vars)) return allowed
    for (const name of Object.keys(vars)) {
        // Each key is checked on its own against variableOverrides; nothing is accepted for the object as a whole.
        const override = isHardDeniedName(name, 'none') ? undefined : (variableOverrides ?? []).find((v) => v?.name === name)
        if (override?.enabled === true) allowed[name] = vars[name]
    }
    return allowed
}

/** Declared state keys of a Start node (`inputs.startState`: an array of `{ key, value }` or its JSON string). */
const getDeclaredStateKeys = (startState: unknown): Set<string> => {
    let items: unknown = startState
    if (typeof items === 'string') {
        try {
            items = JSON.parse(items)
        } catch (e) {
            items = []
        }
    }
    const keys = new Set<string>()
    if (Array.isArray(items)) {
        for (const item of items) {
            if (isPlainObject(item) && typeof item.key === 'string' && item.key && !UNSAFE_KEYS.has(item.key)) keys.add(item.key)
        }
    }
    return keys
}

/**
 * The per-key check for a `startState` override. Hard-denied key names (the override-key name rules, for example
 * `apiUrl`) and values holding a hard-denied key or nested past MAX_OVERRIDE_DEPTH are dropped. Then only keys the flow owner
 * declared on the Start node (`inputs.startState`) are kept; any other key, and any value that is not an array of `{ key, value }` or a plain object, is dropped.
 */
export const filterStartStateOverride = (override: unknown, declaredStartState: unknown, overrideConfig?: ICommonObject): ICommonObject => {
    const declared = getDeclaredStateKeys(declaredStartState)
    const entries: [string, unknown][] = []
    if (Array.isArray(override)) {
        for (const item of override) {
            if (isPlainObject(item) && typeof item.key === 'string' && item.value !== undefined) entries.push([item.key, item.value])
        }
    } else if (isPlainObject(override)) {
        entries.push(...Object.entries(override))
    } else if (override !== undefined && override !== null && overrideConfig) {
        warnIgnored(overrideConfig, 'not an array or object', ['startState'])
    }
    const kept: ICommonObject = {}
    const dropped: string[] = []
    const denied: string[] = []
    for (const [key, value] of entries) {
        // The same name rules as override keys, even for a declared key; then only keys the Start node declares.
        // Only the request's startState is filtered here; the flow's saved startState is never checked or changed.
        const trail: string[] = []
        if (isHardDeniedName(key, 'none')) denied.push(key)
        else if (checkNestedValue(value, 1, false, undefined, trail) !== 'ok') {
            denied.push(key)
            // The path to the dropped key, sanitized; never the value.
            if (trail.length)
                logger.debug(
                    `[server]: overrideConfig.startState: dropped ${[key, ...trail]
                        .map((part) => (/^\[\d+\]$/.test(part) ? part : sanitizeLogKey(part)))
                        .join('.')}`
                )
        } else if (declared.has(key)) kept[key] = value
        else dropped.push(key)
    }
    if (denied.length && overrideConfig) warnIgnored(overrideConfig, HARD_DENIED_REASON, denied, 'overrideConfig.startState')
    if (dropped.length && overrideConfig)
        warnIgnored(overrideConfig, 'state key not declared on the Start node', dropped, 'overrideConfig.startState')
    return kept
}

/** Writes allowed state values over the Start node's declared items; never adds an item or replaces the array wholesale. */
const applyStartState = (inputs: ICommonObject, kept: ICommonObject) => {
    if (!Object.keys(kept).length) return
    let items: unknown = inputs.startState
    if (typeof items === 'string') {
        try {
            items = JSON.parse(items)
        } catch (e) {
            return
        }
    }
    if (!Array.isArray(items)) return
    inputs.startState = items.map((item) =>
        isPlainObject(item) && typeof item.key === 'string' && Object.prototype.hasOwnProperty.call(kept, item.key)
            ? { ...item, value: kept[item.key] }
            : item
    )
}

/** The recursive hard deny on an allowed value; a hard-denied nested key or too deep a value drops the whole top-level key. */
const nestedValueAllowed = (ignored: IgnoredKeys, config: string, value: unknown, inputParams: unknown) => {
    const verdict = checkOverrideValue(config, value, inputParams as OverrideInputParam[] | undefined)
    if (verdict === 'ok') return true
    // Only the top-level key is logged, never the nested key or its path.
    noteIgnored(ignored, verdict === 'denied' ? NESTED_DENIED_REASON : TOO_DEEP_REASON, config)
    return false
}

/**
 * Apply a prediction request's overrideConfig to one node's inputs, deny by default.
 *
 * 0. Hard-denied keys (isHardDeniedOverrideKey: `analytics`, credentials and credential-declared inputs, base URLs, hosts,
 *    endpoints, links, paths, ports, headers, code, server paths, fetched hosts and command lines, file inputs, resource
 *    selectors, model, embeddings and vector store card pickers, the Agent node's knowledge lists and other arrays of
 *    request-buildable nodes) never apply, even when allowlisted. Settings on the owner's chosen card still can. The one exception is a file input holding the file the server stored from
 *    this request's multipart upload (setServerUploadOverride), which still needs the allowlist. Inside an allowed
 *    object or array value the same name rules run on every key to depth 8; a match, or deeper nesting, drops the whole key.
 * 1. Every key except `vars` must be allowlisted for this node's label before any branching, for every value type.
 *    An empty allowlist overrides nothing.
 * 2. An object whose keys are all node ids of this flow is node-keyed. Each target node must allowlist the param
 *    (all or nothing), and this node applies only its own entry (a node-keyed array replaces, as on main). Node ids mixed
 *    with other keys, or another instance of a node type in this flow (`pinecone_9` next to `pinecone_0`), reject the
 *    whole override. Any other object, including one with keys like `chapter_1`, is a plain value.
 * 3. `vars` follows `variableOverrides`, key by key: the filtered set stays on `overrideConfig.vars`, and enabled variables
 *    are merged into `inputs.vars`, which `getVars` in @cuttlely/components reads (CustomFunction, CustomTool, IfElse, others).
 * 4. `startState` (Start node) is checked per key: only keys declared in the Start node's state are written.
 *
 * @param {INodeData} flowNodeData node being initialised; its inputs are updated in place
 * @param {ICommonObject} overrideConfig request overrideConfig (shared across the request's nodes)
 * @param {INodeOverrides} nodeOverrides allowlist from apiConfig.overrideConfig.nodes, keyed by node label
 * @param {IVariableOverride[]} variableOverrides allowlist from apiConfig.overrideConfig.variables
 * @param {FlowNodeLabels} flowNodeLabels node id -> label for every node in this flow (getFlowNodeLabels)
 * @returns {INodeData}
 */
export const replaceInputsWithConfig = (
    flowNodeData: INodeData,
    overrideConfig: ICommonObject,
    nodeOverrides: INodeOverrides,
    variableOverrides: IVariableOverride[],
    flowNodeLabels: FlowNodeLabels
) => {
    if (!overrideConfig || typeof overrideConfig !== 'object') return flowNodeData
    const inputs: ICommonObject = flowNodeData.inputs ?? {}
    const ignored: IgnoredKeys = new Map()

    for (const config of Object.keys(overrideConfig)) {
        if (config === 'vars') {
            const kept = filterVarsInPlace(overrideConfig, variableOverrides)
            // Merged key by key; a request never replaces inputs.vars as a whole.
            if (Object.keys(kept).length) inputs.vars = { ...(isPlainObject(inputs.vars) ? inputs.vars : {}), ...kept }
            continue
        }

        // Never from a request, whatever the allowlist says. A file the server stored from this request's own upload is the
        // one exception for file inputs, and it still needs the allowlist below.
        const inputParams = flowNodeData.inputParams as OverrideInputParam[] | undefined
        if (isHardDeniedOverrideKey(config, inputParams) && !isAllowedServerUpload(overrideConfig, config, inputParams)) {
            noteIgnored(ignored, HARD_DENIED_REASON, config)
            continue
        }

        // Deny by default: one allowlist check, before any branching, for every value type.
        if (!isParameterEnabled(nodeOverrides, flowNodeData.label, config)) {
            // Warn only when no node in this flow allows it, so an override applied to another node is not reported as ignored.
            const allowedElsewhere = [...new Set(flowNodeLabels.values())].some((label) => isParameterEnabled(nodeOverrides, label, config))
            if (!allowedElsewhere) noteIgnored(ignored, 'not allowlisted', config)
            continue
        }

        const value = overrideConfig[config]
        const shape = classify(value, flowNodeLabels)
        if (shape === 'foreignKeyed') {
            noteIgnored(ignored, 'foreign node id', config)
            continue
        }
        if (shape === 'nodeKeyed') {
            const targets = Object.keys(value)
            const everyTargetAllows = targets.every((id) => isParameterEnabled(nodeOverrides, flowNodeLabels.get(id) as string, config))
            if (!everyTargetAllows) {
                noteIgnored(ignored, 'not allowlisted', config)
                continue
            }
            if (!Object.prototype.hasOwnProperty.call(value, flowNodeData.id)) continue
            const own = value[flowNodeData.id]
            if (config !== 'startState' && !nestedValueAllowed(ignored, config, own, flowNodeData.inputParams)) continue
            applyOne(inputs, config, own, overrideConfig, true)
            continue
        }
        if (config !== 'startState' && !nestedValueAllowed(ignored, config, value, flowNodeData.inputParams)) continue
        applyOne(inputs, config, value, overrideConfig)
    }

    flushIgnored(overrideConfig, ignored)
    if (!flowNodeData.inputs) flowNodeData.inputs = inputs
    return flowNodeData
}

/**
 * The request's `analytics` override for the agentflow tracer. `analytics` is hard-denied (it carries tracer
 * credentials and base URLs), so this is always an empty object, even when overrides are on and `analytics` is allowlisted
 * on the Start node. A client-sent tracer field (for example `langFuse.baseUrl`) never reaches the tracer.
 */
export const getAllowedAnalyticsOverride = (overrideConfig: ICommonObject | undefined): ICommonObject => {
    if (overrideConfig && overrideConfig.analytics !== undefined && overrideConfig.analytics !== null)
        warnIgnored(overrideConfig, HARD_DENIED_REASON, ['analytics'])
    return {}
}

/**
 * The request's `startState` override for an agentflow's runtime state. Both checks must pass: API overrides are on
 * (the overrides switch) and `startState` is allowlisted on the Start node; then each key is checked on its own against the
 * keys declared on the Start node (filterStartStateOverride). Otherwise it is an empty object.
 */
export const getAllowedStartStateOverride = (
    overrideConfig: ICommonObject | undefined,
    apiOverrideStatus: boolean,
    nodeOverrides: INodeOverrides | undefined,
    startNode: { data: { label: string; inputs?: ICommonObject } } | undefined
): ICommonObject => {
    if (apiOverrideStatus !== true || !overrideConfig || !startNode) return {}
    const override = overrideConfig.startState
    if (override === undefined || override === null) return {}
    if (!isParameterEnabled(nodeOverrides, startNode.data.label, 'startState')) {
        warnIgnored(overrideConfig, 'not allowlisted', ['startState'])
        return {}
    }
    return filterStartStateOverride(override, startNode.data.inputs?.startState, overrideConfig)
}

/** Server-side fields of a prediction, as buildChatflow builds them. */
export interface ServerFlowFields {
    chatflowid: string
    chatId: string
    sessionId: string
    chatHistory?: IMessage[]
    apiMessageId?: string
}

/**
 * The `$flow` object used to resolve `{{$flow.*}}` in Multi-Agent and Sequential Agent nodes. It is built from
 * server-side fields only, the same fields buildFlow uses for chatflows; nothing from the request's overrideConfig is in it.
 */
export const buildServerFlowConfig = (fields: ServerFlowFields): ICommonObject => ({
    chatflowid: fields.chatflowid,
    chatflowId: fields.chatflowid,
    chatId: fields.chatId,
    sessionId: fields.sessionId,
    chatHistory: fields.chatHistory,
    apiMessageId: fields.apiMessageId
})

/**
 * The variables used to resolve `{{$vars.*}}` in Multi-Agent and Sequential Agent nodes. The workspace variables
 * are copied (the shared list is never changed). A request var is added, as a static value, only when API overrides are on and
 * that var's own `variableOverrides` entry has `enabled === true`: the same per-key rule as `inputs.vars`. Prototype keys are
 * never copied.
 */
export const getAllowedVariables = (
    availableVariables: IVariable[] | undefined,
    overrideConfig: ICommonObject | undefined,
    apiOverrideStatus: boolean | undefined,
    variableOverrides: IVariableOverride[] | undefined
): IVariable[] => {
    const variables = (availableVariables ?? []).map((variable) => ({ ...variable }))
    if (apiOverrideStatus !== true || !overrideConfig) return variables
    const allowed = pickAllowedVars(overrideConfig.vars, variableOverrides)
    for (const name of Object.keys(allowed)) {
        const existing = variables.find((variable) => variable.name === name)
        if (existing) {
            existing.type = 'static'
            existing.value = allowed[name]
        } else {
            const now = new Date()
            variables.push({ id: '', name, type: 'static', value: allowed[name], workspaceId: '', createdDate: now, updatedDate: now })
        }
    }
    return variables
}

/**
 * The names of the request vars that getAllowedVariables takes from this request (overrides on, var allowlisted). Agent
 * graphs use them to keep those values out of code inputs as code (codeInputLiteral.ts).
 */
export const getAllowedRequestVarNames = (
    overrideConfig: ICommonObject | undefined,
    apiOverrideStatus: boolean | undefined,
    variableOverrides: IVariableOverride[] | undefined
): Set<string> => {
    if (apiOverrideStatus !== true || !overrideConfig) return new Set()
    return new Set(Object.keys(pickAllowedVars(overrideConfig.vars, variableOverrides)))
}

// Flows already warned about in this process. Allowlist labels are the owner's config, never request values.
const unmatchedLabelWarned = new Set<string>()

/**
 * Warn, once per flow per process, about allowlist entries whose node label matches no node in the flow, for example
 * an allowlist saved as "ChatOpenAI" before upstream #5893 renamed that node's label to "OpenAI". Such entries silently
 * allow nothing. Only entries with at least one enabled parameter are reported. Values are never logged.
 * Returns the unmatched labels (empty when nothing was logged).
 */
export const warnUnmatchedAllowlistLabels = (
    flowId: string | undefined,
    nodeOverrides: INodeOverrides | undefined | null,
    flowNodeLabels: FlowNodeLabels
): string[] => {
    if (!flowId || unmatchedLabelWarned.has(flowId) || !nodeOverrides || typeof nodeOverrides !== 'object') return []
    const labels = new Set(flowNodeLabels.values())
    const unmatched = Object.keys(nodeOverrides).filter((label) => {
        const params = nodeOverrides[label]
        return !labels.has(label) && Array.isArray(params) && params.some((param) => param?.enabled === true)
    })
    if (!unmatched.length) return []
    unmatchedLabelWarned.add(flowId)
    logger.warn(
        `[server]: chatflow ${sanitizeLogKey(flowId)}: ${
            unmatched.length
        } API override allowlist entries match no node label in the flow ` +
            `and allow nothing: ${formatLogKeys(unmatched)}. Re-save the override configuration so it uses the nodes' current labels.`
    )
    return unmatched
}

/** Test hook: forget which flows were warned about. */
export const resetUnmatchedAllowlistWarnings = () => unmatchedLabelWarned.clear()
