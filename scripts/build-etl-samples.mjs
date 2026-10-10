// Regenerates samples/etl/*.pipeline.json from the built node definitions, the same way the canvas
// initializes a dropped node. Run after `pnpm --filter flowise-components build`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadFlowiseNode } from '../harness/bridge.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'samples', 'etl')

const PARAM_TYPES = new Set([
    'asyncOptions',
    'asyncMultiOptions',
    'options',
    'multiOptions',
    'array',
    'datagrid',
    'string',
    'number',
    'boolean',
    'password',
    'json',
    'code',
    'date',
    'file',
    'folder',
    'tabs'
])

async function canvasNode(name, id, position, values = {}) {
    const node = await loadFlowiseNode(name)
    const inputs = node.inputs || []
    const inputParams = []
    const inputAnchors = []
    for (const input of inputs) {
        const withId = { ...input, id: `${id}-input-${input.name}-${input.type}` }
        if (PARAM_TYPES.has(input.type)) inputParams.push(withId)
        else inputAnchors.push(withId)
    }
    if (node.credential) inputParams.unshift({ ...node.credential, id: `${id}-input-${node.credential.name}-${node.credential.type}` })
    const outputAnchors = node.outputs?.length
        ? [
              {
                  name: 'output',
                  label: 'Output',
                  type: 'options',
                  description: node.outputs[0].description ?? '',
                  options: node.outputs.map((output) => ({
                      id: `${id}-output-${output.name}-${output.baseClasses.join('|')}`,
                      name: output.name,
                      label: output.label,
                      description: output.description ?? '',
                      type: output.baseClasses.join(' | ')
                  })),
                  default: node.outputs[0].name
              }
          ]
        : [
              {
                  id: `${id}-output-${node.name}-${node.baseClasses.join('|')}`,
                  name: node.name,
                  label: node.type,
                  description: node.description ?? '',
                  type: node.baseClasses.join(' | ')
              }
          ]
    const defaults = Object.fromEntries(inputs.map((input) => [input.name, input.default ?? '']))
    return {
        id,
        position,
        type: 'customNode',
        width: 300,
        data: {
            id,
            label: node.label,
            version: node.version,
            name: node.name,
            type: node.type,
            baseClasses: node.baseClasses,
            category: node.category,
            description: node.description,
            inputParams,
            inputAnchors,
            inputs: { ...defaults, ...values },
            outputAnchors,
            outputs: node.outputs?.length ? { output: node.outputs[0].name } : {},
            selected: false
        }
    }
}

function edge(source, target, inputName) {
    const sourceHandle = source.data.outputAnchors[0].options ? source.data.outputAnchors[0].options[0].id : source.data.outputAnchors[0].id
    const anchor = target.data.inputAnchors.find((input) => input.name === inputName)
    const targetHandle = anchor.id
    target.data.inputs[inputName] = anchor.list
        ? [...(target.data.inputs[inputName] || []).filter(Boolean), `{{${source.id}.data.instance}}`]
        : `{{${source.id}.data.instance}}`
    return {
        source: source.id,
        sourceHandle,
        target: target.id,
        targetHandle,
        type: 'buttonedge',
        id: `${source.id}-${sourceHandle}-${target.id}-${targetHandle}`
    }
}

async function catalog() {
    const splitter = await canvasNode(
        'recursiveCharacterTextSplitter',
        'recursiveCharacterTextSplitter_0',
        { x: 40, y: 60 },
        { chunkSize: 800, chunkOverlap: 80 }
    )
    const source = await canvasNode(
        'etlFileSource',
        'etlFileSource_0',
        { x: 400, y: 40 },
        {
            paths: '{{samples}}/data/outdoor-catalog.csv',
            format: 'csv',
            textColumns: 'name, category, description',
            idColumn: 'sku',
            metadataColumns: 'sku, category, price'
        }
    )
    const transform = await canvasNode(
        'etlTransform',
        'etlTransform_0',
        { x: 760, y: 40 },
        { normalizeWhitespace: true, normalizeUnicode: true, minChars: 20 }
    )
    const embeddings = await canvasNode('localHashEmbeddings', 'localHashEmbeddings_0', { x: 760, y: 520 }, { dimensions: 384 })
    const store = await canvasNode(
        'etlLocalVectorStore',
        'etlLocalVectorStore_0',
        { x: 1120, y: 200 },
        { collection: 'outdoor-catalog', topK: 4 }
    )
    const edges = [
        edge(splitter, source, 'textSplitter'),
        edge(source, transform, 'document'),
        edge(transform, store, 'document'),
        edge(embeddings, store, 'embeddings')
    ]
    return {
        name: 'Outdoor catalog',
        description:
            'A product CSV, one chunk per row keyed by SKU, embedded with Local Hash Embeddings into a Local Vector Store. Runs offline.',
        flowData: { nodes: [splitter, source, transform, embeddings, store], edges, viewport: { x: 0, y: 0, zoom: 0.8 } }
    }
}

async function handbook() {
    const splitter = await canvasNode(
        'markdownTextSplitter',
        'markdownTextSplitter_0',
        { x: 40, y: 60 },
        { chunkSize: 1200, chunkOverlap: 100 }
    )
    const source = await canvasNode(
        'etlRepoSource',
        'etlRepoSource_0',
        { x: 400, y: 40 },
        {
            repoPath: '{{repo}}',
            include: 'README.md, AGENTS.md, docs/**/*.md, .projects/**/*.md, samples/**/*.md',
            repoLabel: 'cuttlely',
            maxFileKb: 512
        }
    )
    const transform = await canvasNode(
        'etlTransform',
        'etlTransform_0',
        { x: 760, y: 40 },
        { prefixTemplate: 'File: {path}\\n', minChars: 40 }
    )
    const embeddings = await canvasNode('localHashEmbeddings', 'localHashEmbeddings_0', { x: 760, y: 520 }, { dimensions: 384 })
    const store = await canvasNode(
        'etlLocalVectorStore',
        'etlLocalVectorStore_0',
        { x: 1120, y: 200 },
        { collection: 'cuttlely-handbook', topK: 4 }
    )
    const edges = [
        edge(splitter, source, 'textSplitter'),
        edge(source, transform, 'document'),
        edge(transform, store, 'document'),
        edge(embeddings, store, 'embeddings')
    ]
    return {
        name: 'Cuttlely handbook',
        description:
            "This checkout's README, AGENTS.md, and docs, walked as a code repository with .gitignore rules and split by Markdown structure.",
        flowData: { nodes: [splitter, source, transform, embeddings, store], edges, viewport: { x: 0, y: 0, zoom: 0.8 } }
    }
}

fs.mkdirSync(outDir, { recursive: true })
for (const [file, build] of [
    ['outdoor-catalog', catalog],
    ['cuttlely-handbook', handbook]
]) {
    const sample = await build()
    fs.writeFileSync(path.join(outDir, `${file}.pipeline.json`), `${JSON.stringify(sample, null, 2)}\n`)
    console.log(`wrote samples/etl/${file}.pipeline.json`)
}
