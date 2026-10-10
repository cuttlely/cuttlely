import { sampleTemplates } from '../../marketplaces/sampleTemplates'
import { estimateTemplateNodeSize, TEMPLATE_CLEARANCE } from '../../marketplaces/templateLayout'
import { classicAsPlan, classicCanvas, outputTypesOf, plugProblems, plugsOf, settingsOf, shortText } from '../classic'
import { closest } from '../examples'
import { layerLayout } from '../layout'
import { Plan, PlanNode } from '../plan'
import { PartDefinition, Recipe, RecipeContext } from '../recipe'

const FILE_SOURCE = 'etlFileSource'
const REPO_SOURCE = 'etlRepoSource'
const TRANSFORM = 'etlTransform'
const LOCAL_STORE = 'etlLocalVectorStore'
const LOCAL_EMBEDDINGS = 'localHashEmbeddings'
const STREAM_SOURCES = new Set([FILE_SOURCE, REPO_SOURCE])
// Vectara Upload File sends whole files and cannot update or delete a chunk, so a pipeline cannot use it.
const UNSUPPORTED = new Set(['vectaraUpload'])
const PART_CATEGORIES = new Set(['Text Splitters', 'Embeddings', 'Vector Stores', 'Document Loaders'])
const RECORD_FORMATS = new Set(['csv', 'tsv', 'jsonl'])
const COLLECTION_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/
const MAX_EXAMPLES = 2
const ORIGIN = 40

const disabled = () => (process.env.DISABLED_NODES ? process.env.DISABLED_NODES.split(',') : [])
const deprecated = (part: PartDefinition) => /deprecat/i.test(String(part.badge || ''))
const isStore = (part?: PartDefinition) => part?.category === 'Vector Stores'
const isSource = (part?: PartDefinition) => STREAM_SOURCES.has(String(part?.name)) || part?.category === 'Document Loaders'

export const etlParts = (componentNodes: Record<string, PartDefinition>) =>
    Object.values(componentNodes).filter(
        (part) =>
            (STREAM_SOURCES.has(part.name) || part.name === TRANSFORM || PART_CATEGORIES.has(String(part.category))) &&
            !UNSUPPORTED.has(part.name) &&
            !deprecated(part) &&
            !disabled().includes(part.name)
    )

export const etlRules = [
    `One source line ending in one store: a source (${FILE_SOURCE} for files and folders, ${REPO_SOURCE} for a code repository), optionally one ${TRANSFORM}, then exactly one vector store. Connect each step to the next with "input": "document".`,
    `Use ${LOCAL_STORE} with ${LOCAL_EMBEDDINGS} unless the description names another store or embeddings. Connect the embeddings with "input": "embeddings".`,
    'A text splitter plugs into the source with "input": "textSplitter". Use markdownTextSplitter for Markdown, recursiveCharacterTextSplitter otherwise; set chunkSize when the description asks for a size.',
    `Put the paths, files and columns from the description in the source "inputs". ${FILE_SOURCE}: "paths" (absolute server paths, one per line, exactly as the description gives them; never make one up), "format" (auto, text, csv, tsv or jsonl), and for csv, tsv or jsonl an "idColumn" that names each row, so a second run updates rows instead of adding them again, plus "textColumns" and "metadataColumns" when named. ${REPO_SOURCE}: "repoPath" (an absolute path) or "gitUrl", and "include" globs when only some files are wanted. Globs follow .gitignore rules: a bare name such as README.md matches that file in every folder, so start it with a slash (/README.md) when only the top-level file is meant.`,
    `Give the store "inputs": {"collection": "short-lowercase-name"}.`,
    'Starter questions are searches someone would run against the stored chunks.'
]

// The bundled pipelines keep their paths as {{samples}} and {{repo}} placeholders; examples show them as
// ordinary server paths so the model sees where a path goes.
const PLACEHOLDERS: Record<string, string> = { '{{samples}}': '/srv/cuttlely/samples/etl', '{{repo}}': '/srv/cuttlely' }
const PATH_INPUTS = ['paths', 'repoPath']
const globs = (value: unknown) =>
    String(value || '')
        .split(/[,\n]/)
        .map((glob) => glob.trim())
        .filter(Boolean)
// A glob with no slash matches that name in every folder (.gitignore rules), which a bare README.md hides.
const bareGlobs = (value: unknown) => globs(value).filter((glob) => !glob.includes('/'))

export function etlSampleAsPlan(flow: { nodes: any[]; edges: any[] }, keep: string[]): Plan {
    const plan = classicAsPlan(flow, keep)
    for (const node of plan.nodes) {
        const inputs = flow.nodes.find((n: any) => n.id === node.id)?.data?.inputs || {}
        for (const key of PATH_INPUTS) {
            if (typeof inputs[key] !== 'string' || !inputs[key]) continue
            const value = Object.entries(PLACEHOLDERS).reduce((text, [from, to]) => text.split(from).join(to), inputs[key])
            node.inputs = { ...(node.inputs || {}), [key]: value }
        }
        // Same match, written out: README.md in a sample already means every folder, so show it as **/README.md.
        if (typeof node.inputs?.include === 'string' && bareGlobs(node.inputs.include).length)
            node.inputs.include = globs(node.inputs.include)
                .map((glob) => (glob.includes('/') ? glob : `**/${glob}`))
                .join(', ')
    }
    return plan
}

export function etlExamples(request: string, ctx?: RecipeContext) {
    const samples = sampleTemplates()
        .filter((template) => template.type === 'ETL')
        .map((t) => ({
            title: t.templateName,
            description: t.description,
            usecases: t.usecases || [],
            plan: etlSampleAsPlan(JSON.parse(t.flowData), [
                'format',
                'textColumns',
                'idColumn',
                'metadataColumns',
                'include',
                'chunkSize',
                'chunkOverlap',
                'collection',
                'minChars',
                'prefixTemplate'
            ])
        }))
        .filter((sample) => !ctx || !etlProblems(sample.plan, ctx).length)
    return closest(request, samples, (s) => [s.title, s.description, ...s.usecases].join(' '), MAX_EXAMPLES).map(
        ({ title, description, plan }) => ({
            title,
            description,
            plan
        })
    )
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '')

export function etlProblems(plan: Plan, ctx: RecipeContext): string[] {
    const problems: string[] = []
    const def = (node?: PlanNode) => (node ? ctx.componentNodes[node.name] : undefined)
    const byId = new Map(plan.nodes.map((node) => [node.id, node]))
    const stores = plan.nodes.filter((node) => isStore(def(node)))
    const sources = plan.nodes.filter((node) => isSource(def(node)))
    const transforms = plan.nodes.filter((node) => node.name === TRANSFORM)
    if (stores.length !== 1) problems.push(`A pipeline writes to exactly one vector store; this plan has ${stores.length}.`)
    if (sources.length !== 1)
        problems.push(`A pipeline reads one source (${FILE_SOURCE} or ${REPO_SOURCE}); this plan has ${sources.length}.`)
    if (transforms.length > 1) problems.push(`Use at most one ${TRANSFORM}; this plan has ${transforms.length}.`)
    const into = (id: string, input: string) => plan.edges.filter((edge) => edge.to === id && edge.input === input)
    const store = stores[0]
    if (store) {
        const collection = text(store.inputs?.collection)
        if (collection && !COLLECTION_RE.test(collection))
            problems.push(
                `The store "collection" must be short and lowercase, with letters, digits, dashes or underscores (like "product-notes").`
            )
        // The document line: store <- (transform <-) source.
        const feeding = plan.edges.filter(
            (edge) => edge.to === store.id && (edge.input === 'document' || (!edge.input && isSource(def(byId.get(edge.from)))))
        )
        const firstStep = feeding.length === 1 ? byId.get(feeding[0].from) : undefined
        if (!feeding.length) problems.push(`Connect the source (or ${TRANSFORM}) to the store with "input": "document".`)
        else if (feeding.length > 1) problems.push('Only one line of documents goes into the store.')
        if (firstStep?.name === TRANSFORM) {
            const upstream = plan.edges.filter((edge) => edge.to === firstStep.id && edge.input !== 'textSplitter')
            if (upstream.length !== 1 || !isSource(def(byId.get(upstream[0].from))))
                problems.push(`Connect the source to ${TRANSFORM} with "input": "document".`)
        } else if (firstStep && !isSource(def(firstStep)))
            problems.push(`"${firstStep.id}" (${firstStep.name}) cannot feed documents into the store.`)
    }
    for (const source of sources) {
        const label = `"${source.label || source.id}"`
        if (source.name === FILE_SOURCE) {
            const paths = text(source.inputs?.paths)
            if (!paths) problems.push(`${label} needs "inputs.paths": the files or folders from the description.`)
            for (const line of paths
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean))
                if (!line.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(line))
                    problems.push(`${label} path "${line}" is not absolute: give the full path on the server.`)
            const format = text(source.inputs?.format).toLowerCase()
            const records = RECORD_FORMATS.has(format) || /\.(csv|tsv|jsonl)\s*$/im.test(paths)
            if (records && !text(source.inputs?.idColumn))
                problems.push(
                    `${label} reads rows, so it needs "inputs.idColumn" (the column that names each row); without it a second run adds the rows again.`
                )
        }
        if (source.name === REPO_SOURCE && !text(source.inputs?.repoPath) && !text(source.inputs?.gitUrl))
            problems.push(`${label} needs "inputs.repoPath" (a checkout on the server) or "inputs.gitUrl".`)
        if (source.name === REPO_SOURCE)
            for (const glob of bareGlobs(source.inputs?.include))
                problems.push(
                    `${label} include "${glob}" has no slash, so it matches ${glob} in every folder. Write "/${glob}" for the top-level one only, or "**/${glob}" for every folder.`
                )
        if (def(source)?.category === 'Document Loaders' && !transforms.some((t) => text(t.inputs?.keyTemplate)))
            problems.push(
                `${label} is a document loader, so add ${TRANSFORM} with "inputs.keyTemplate" (how each record key is built from its metadata).`
            )
    }
    // Every part must reach the store.
    const reaches = (id: string, seen = new Set<string>()): boolean => {
        if (store && id === store.id) return true
        if (seen.has(id)) return false
        seen.add(id)
        return plan.edges.some((edge) => edge.from === id && reaches(edge.to, seen))
    }
    for (const node of plan.nodes)
        if (!reaches(node.id)) problems.push(`"${node.label || node.id}" (${node.name}) does not reach the store, so nothing would use it.`)
    if (
        store &&
        !into(store.id, 'embeddings').length &&
        !plan.edges.some((e) => e.to === store.id && def(byId.get(e.from))?.category === 'Embeddings')
    )
        problems.push(`Connect embeddings (${LOCAL_EMBEDDINGS} unless another is named) to the store with "input": "embeddings".`)
    // The store's document plug is optional on chat flows; a pipeline needs it, and the line check above covers it.
    return [...problems, ...plugProblems(plan, ctx)]
}

// Left to right in the order the data moves: splitter and source, transform, store, with embeddings below the
// line feeding the store.
export function etlLayout(nodes: any[], edges: any[]) {
    const size = (node: any) => estimateTemplateNodeSize(node.data)
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const ids = nodes.map((node) => node.id)
    const positions = layerLayout(
        ids,
        edges.map((edge) => ({ from: edge.source, to: edge.target })),
        (id) => size(byId.get(id)),
        { x0: ORIGIN, y0: ORIGIN, columnGap: TEMPLATE_CLEARANCE + 40, rowGap: TEMPLATE_CLEARANCE }
    )
    for (const node of nodes) {
        const box = size(node)
        node.position = positions[node.id]
        node.positionAbsolute = positions[node.id]
        node.width = box.width
        node.height = box.height
    }
}

export function etlCanvas(plan: Plan, ctx: RecipeContext) {
    const built = classicCanvas(plan, ctx)
    etlLayout(built.nodes, built.edges)
    return { nodes: built.nodes, edges: built.edges, missingCredentials: built.missingCredentials }
}

export const etlRecipe: Recipe = {
    kind: 'etl',
    parts: (ctx) => etlParts(ctx.componentNodes),
    partsSummary: (ctx) => {
        const parts = etlParts(ctx.componentNodes)
        const settings = (part: PartDefinition) =>
            settingsOf(part)
                .map((s) => `${s.name}${s.options ? ` (${s.options.map((o: any) => o.name).join('/')})` : ''}`)
                .join(', ')
        const describe = (part: PartDefinition, detailed: boolean) => {
            const plugs = plugsOf(part)
                .map((plug) => `${plug.name}: ${plug.type}`)
                .join('; ')
            return `- ${part.name}: ${part.label}. ${shortText(part.description, detailed ? 160 : 80)}${
                part.credential ? ' (needs a credential)' : ''
            }${plugs ? ` Plugs: ${plugs}.` : ''}${detailed ? ` Settings: ${settings(part)}.` : ''} Gives: ${outputTypesOf(part)
                .slice(0, 3)
                .join(', ')}`
        }
        const main = new Set([FILE_SOURCE, REPO_SOURCE, TRANSFORM, LOCAL_STORE, LOCAL_EMBEDDINGS])
        const first = parts.filter((part) => main.has(part.name))
        const splitters = parts.filter((part) => part.category === 'Text Splitters')
        const rest = parts.filter((part) => !main.has(part.name) && part.category !== 'Text Splitters')
        return `${first.map((p) => describe(p, true)).join('\n')}\n\nText splitters:\n${splitters
            .map((p) => describe(p, false))
            .join('\n')}\n\nOther stores, embeddings and loaders (only when the description names them):\n${rest
            .map((p) => describe(p, false))
            .join('\n')}`
    },
    examples: (request, ctx) => etlExamples(request, ctx),
    rules: etlRules,
    check: etlProblems,
    materialize: etlCanvas
}
