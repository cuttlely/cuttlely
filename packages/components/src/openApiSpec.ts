import $RefParser from '@apidevtools/json-schema-ref-parser'
import { JSON_SCHEMA, load } from 'js-yaml'
import { secureFetch } from './httpSecurity'

/**
 * OpenAPI spec loading for the OpenAPI Toolkit and the OpenAPI Chain.
 *
 * - Every spec document (the uploaded file, the linked spec and each external `$ref` target) is capped at
 *   OPENAPI_SPEC_MAX_BYTES before it is parsed, which also bounds the YAML parse cost.
 * - Remote documents are fetched only over http(s) through secureFetch: the HTTP deny list is checked for every hop of a
 *   redirect chain, the connection is pinned to the checked address, and the whole fetch has a timeout.
 * - json-schema-ref-parser's own file and http resolvers are turned off. External `$ref`s resolve only through
 *   secureFetch, so a `$ref` to a local path or `file:` URL is refused, and so is one to a private or metadata address.
 */
export const OPENAPI_SPEC_MAX_BYTES = 1024 * 1024
export const OPENAPI_SPEC_FETCH_TIMEOUT_MS = 15_000
/** External documents one dereference may fetch (each one capped at OPENAPI_SPEC_MAX_BYTES). */
export const OPENAPI_SPEC_MAX_EXTERNAL_DOCUMENTS = 50

const tooLarge = (what: string) =>
    new Error(`${what} is larger than the ${OPENAPI_SPEC_MAX_BYTES / (1024 * 1024)} MB limit for OpenAPI specs`)

/** Throws unless `text` (a spec document) fits in OPENAPI_SPEC_MAX_BYTES. */
export const assertSpecSize = (text: string | Buffer, what = 'OpenAPI spec'): void => {
    const size = typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : text.length
    if (size > OPENAPI_SPEC_MAX_BYTES) throw tooLarge(what)
}

const isHttpUrl = (value: string): boolean => {
    try {
        const { protocol } = new URL(value)
        return protocol === 'http:' || protocol === 'https:'
    } catch (e) {
        return false
    }
}

/**
 * Fetches one spec document through secureFetch with a timeout, and reads at most OPENAPI_SPEC_MAX_BYTES of it.
 * Only http and https URLs are accepted.
 */
export const fetchSpecDocument = async (url: string, timeoutMs = OPENAPI_SPEC_FETCH_TIMEOUT_MS): Promise<string> => {
    if (!isHttpUrl(url)) throw new Error('OpenAPI spec URLs must use http or https')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        // node-fetch takes the abort signal; the size check below does not rely on its `size` option.
        const response = await secureFetch(url, { signal: controller.signal as any })
        if (!response.ok) throw new Error(`Failed to fetch OpenAPI spec: HTTP ${response.status}`)
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > OPENAPI_SPEC_MAX_BYTES) throw tooLarge('Fetched OpenAPI spec')
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of response.body as AsyncIterable<Buffer | string>) {
            const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
            size += buf.length
            if (size > OPENAPI_SPEC_MAX_BYTES) {
                controller.abort()
                throw tooLarge('Fetched OpenAPI spec')
            }
            chunks.push(buf)
        }
        return Buffer.concat(chunks).toString('utf8')
    } catch (e: any) {
        if (e?.name === 'AbortError' && controller.signal.aborted) throw new Error('Fetching the OpenAPI spec timed out or was aborted')
        throw e
    } finally {
        clearTimeout(timer)
    }
}

/** Parses a spec document as JSON, or as YAML when it is not JSON (or when `yaml` is true), after the size check. */
export const parseSpecDocument = (text: string, yaml?: boolean): any => {
    assertSpecSize(text)
    if (!yaml) {
        try {
            return JSON.parse(text)
        } catch (e) {
            // not JSON; parse as YAML
        }
    }
    return load(text)
}

/**
 * Dereferences a parsed spec. `baseUrl` is the URL the spec was fetched from, so relative `$ref`s resolve against it; for
 * an uploaded spec it is omitted, and any relative `$ref` then names a local path and is refused.
 */
export const dereferenceOpenApiSpec = async (spec: any, baseUrl?: string): Promise<any> => {
    let fetched = 0
    const options = {
        // ref-parser's YAML parser, with this package's js-yaml (the pinned, fixed version) instead of its own copy.
        parse: {
            yaml: {
                order: 200,
                allowEmpty: true,
                canParse: ['.yaml', '.yml', '.json'],
                parse: (file: { data: unknown }) => {
                    const data = Buffer.isBuffer(file.data) ? file.data.toString('utf8') : file.data
                    if (typeof data !== 'string') return data
                    assertSpecSize(data, 'Referenced OpenAPI document')
                    return load(data, { schema: JSON_SCHEMA })
                }
            }
        },
        resolve: {
            file: false,
            http: false,
            secureHttp: {
                order: 1,
                canRead: (file: { url: string }) => isHttpUrl(file.url),
                read: async (file: { url: string }) => {
                    fetched += 1
                    if (fetched > OPENAPI_SPEC_MAX_EXTERNAL_DOCUMENTS)
                        throw new Error(`OpenAPI spec references more than ${OPENAPI_SPEC_MAX_EXTERNAL_DOCUMENTS} external documents`)
                    return fetchSpecDocument(file.url)
                }
            }
        }
    }
    const parser = new $RefParser()
    return baseUrl && isHttpUrl(baseUrl) ? parser.dereference(baseUrl, spec, options as any) : parser.dereference(spec, options as any)
}
