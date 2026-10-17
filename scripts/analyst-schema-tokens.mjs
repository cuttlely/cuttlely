#!/usr/bin/env node
// Prompt size for the analyst on the bakery demo database, before and after the table picker.
//
//   psql -d bakery -f samples/demo/bakery/bakery-postgres.sql
//   CUTTLELY_BAKERY_URL=postgresql://127.0.0.1:5432/bakery node scripts/analyst-schema-tokens.mjs
//
// A URL without a login uses PGUSER and PGPASSWORD from the environment.
//
// Before: the whole database written into the specialist's instructions, plus the query tool.
// After: the query tool with one line per selected relation, plus the describe tool. Tokens are counted with the
// o200k_base and cl100k_base encodings, and with the ceil(characters / 4) estimate the harness context caps use.
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    analystDescribeToolSpec,
    analystUrlRelations,
    analystUrlToolSpec,
    describeAnalystUrlRelation,
    listAnalystUrlRelations
} from '../packages/harness/runtime/analyst-store.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELECTION = [
    'public.monthly_sales',
    'public.top_products',
    'public.account_balances',
    'public.weekly_store_revenue',
    'public.wholesale_accounts',
    'public.stores'
]

function encoders() {
    const list = [{ name: 'chars/4', count: (text) => Math.ceil(text.length / 4) }]
    try {
        const components = createRequire(path.join(ROOT, 'packages', 'components', 'package.json'))
        const tiktoken = createRequire(components.resolve('@langchain/core/package.json'))('js-tiktoken')
        for (const name of ['o200k_base', 'cl100k_base']) {
            const encoding = tiktoken.getEncoding(name)
            list.unshift({ name, count: (text) => encoding.encode(text).length })
        }
    } catch {
        // The estimate alone still compares the two prompts.
    }
    return list
}

// What a builder pastes when the whole database goes into the instructions.
function schemaText(described) {
    return described
        .map((item) =>
            [
                `${item.name} (${item.kind})${item.comment ? `: ${item.comment}` : ''}`,
                ...item.columns.map((column) => `  ${column}`),
                item.primaryKey ? `  primary key: ${item.primaryKey.join(', ')}` : '',
                ...(item.relationships || []).map((line) => `  ${line}`),
                item.definition ? `  definition: ${item.definition.replace(/\s+/g, ' ')}` : ''
            ]
                .filter(Boolean)
                .join('\n')
        )
        .join('\n\n')
}

const tool = (spec, name) => JSON.stringify({ name, description: spec.description, parameters: spec.schema })

async function main() {
    const url = process.env.CUTTLELY_BAKERY_URL
    if (!url) {
        console.error('Set CUTTLELY_BAKERY_URL to a database loaded with samples/demo/bakery/bakery-postgres.sql.')
        process.exit(2)
    }
    const everything = await listAnalystUrlRelations(url)
    const allNames = everything.map((relation) => relation.name)
    const described = []
    for (const name of allNames) described.push(await describeAnalystUrlRelation(url, { name }, allNames))
    const selected = await analystUrlRelations(url, SELECTION)
    const allSelected = await analystUrlRelations(url, allNames)
    const describeTool = tool(analystDescribeToolSpec(), 'describe')
    const plainQuery = tool(analystUrlToolSpec(100), 'query')
    const rows = [
        ['Before: whole schema in instructions + query tool', `${schemaText(described)}\n${plainQuery}`],
        ['After: 6 selected relations (query + describe tools)', `${tool(analystUrlToolSpec(100, selected), 'query')}\n${describeTool}`],
        [`After: all ${allSelected.length} relations selected`, `${tool(analystUrlToolSpec(100, allSelected), 'query')}\n${describeTool}`],
        ['Schema part only, before (whole schema)', schemaText(described)],
        [
            'Schema part only, after (6 lines)',
            analystUrlToolSpec(100, selected).description.slice(analystUrlToolSpec(100).description.length)
        ],
        [
            'One describe result (public.account_balances)',
            JSON.stringify(await describeAnalystUrlRelation(url, { name: 'account_balances' }, SELECTION))
        ]
    ]
    const counters = encoders()
    const header = ['Prompt part', ...counters.map((counter) => counter.name)]
    console.log(`| ${header.join(' | ')} |`)
    console.log(`| ${header.map(() => '---').join(' | ')} |`)
    for (const [label, text] of rows) console.log(`| ${label} | ${counters.map((counter) => counter.count(text)).join(' | ')} |`)
}

main().catch((error) => {
    console.error(error.message)
    process.exit(1)
})
