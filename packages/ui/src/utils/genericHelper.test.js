import { applyVisibleInputDefaults, generateExportFlowData, showHideInputs } from './genericHelper'

describe('showHideInputs – declared defaults of sibling fields', () => {
    const buildParams = () => [
        {
            label: 'Schedule Type',
            name: 'scheduleType',
            type: 'options',
            default: 'visualPicker',
            show: { startInputType: 'scheduleInput' }
        },
        {
            label: 'Schedule Input Mode',
            name: 'scheduleInputMode',
            type: 'options',
            default: 'text',
            show: { startInputType: 'scheduleInput' }
        },
        {
            label: 'Frequency',
            name: 'scheduleFrequency',
            type: 'options',
            show: { startInputType: 'scheduleInput', scheduleType: 'visualPicker' }
        },
        {
            label: 'Default Input',
            name: 'scheduleDefaultInput',
            type: 'string',
            show: { startInputType: 'scheduleInput', scheduleInputMode: 'text' }
        }
    ]

    it('shows fields whose `show` references a sibling default value, even if the sibling key is absent', () => {
        const nodeData = {
            inputParams: buildParams(),
            inputs: { startInputType: 'scheduleInput' }
        }

        const result = showHideInputs(nodeData, 'inputParams')
        const byName = Object.fromEntries(result.map((p) => [p.name, p.display]))

        expect(byName.scheduleType).toBe(true)
        expect(byName.scheduleInputMode).toBe(true)
        expect(byName.scheduleFrequency).toBe(true)
        expect(byName.scheduleDefaultInput).toBe(true)
    })

    it('explicit value overrides declared default', () => {
        const nodeData = {
            inputParams: buildParams(),
            inputs: { startInputType: 'scheduleInput', scheduleType: 'cronExpression' }
        }

        const result = showHideInputs(nodeData, 'inputParams')
        const byName = Object.fromEntries(result.map((p) => [p.name, p.display]))

        expect(byName.scheduleFrequency).toBe(false)
        // scheduleInputMode default still applies — Default Input stays visible.
        expect(byName.scheduleDefaultInput).toBe(true)
    })

    it('does not synthesize defaults for fields without a declared `default`', () => {
        const params = [
            { label: 'Other', name: 'other', type: 'string' /* no default */ },
            { label: 'Sib', name: 'sib', type: 'string', show: { other: 'expected' } }
        ]
        const nodeData = { inputParams: params, inputs: {} }

        const result = showHideInputs(nodeData, 'inputParams')
        const byName = Object.fromEntries(result.map((p) => [p.name, p.display]))

        expect(byName.sib).toBe(false)
    })

    it('keeps Form Input fields hidden when type switches to scheduleInput', () => {
        // Sanity: the fix should not accidentally make form-input fields visible
        // after switching away from formInput.
        const params = [
            ...buildParams(),
            {
                label: 'Form Title',
                name: 'formTitle',
                type: 'string',
                show: { startInputType: 'formInput' }
            }
        ]
        const nodeData = {
            inputParams: params,
            // Lingering form values from before the type switch:
            inputs: { startInputType: 'scheduleInput', formTitle: 'leftover' }
        }

        const result = showHideInputs(nodeData, 'inputParams')
        const byName = Object.fromEntries(result.map((p) => [p.name, p.display]))

        expect(byName.formTitle).toBe(false)
    })
})

describe('applyVisibleInputDefaults', () => {
    const buildParams = () => [
        {
            name: 'scheduleType',
            type: 'options',
            default: 'visualPicker',
            show: { startInputType: 'scheduleInput' }
        },
        {
            name: 'scheduleInputMode',
            type: 'options',
            default: 'text',
            show: { startInputType: 'scheduleInput' }
        },
        // Hidden in this scenario — its default must NOT be merged.
        {
            name: 'formTitle',
            type: 'string',
            default: 'Untitled Form',
            show: { startInputType: 'formInput' }
        },
        // Visible but no default — stays missing.
        {
            name: 'scheduleFrequency',
            type: 'options',
            show: { startInputType: 'scheduleInput', scheduleType: 'visualPicker' }
        }
    ]

    it('writes declared defaults for currently visible fields whose value is missing', () => {
        const result = applyVisibleInputDefaults(buildParams(), { startInputType: 'scheduleInput' })

        expect(result.scheduleType).toBe('visualPicker')
        expect(result.scheduleInputMode).toBe('text')
    })

    it('does not synthesize defaults for hidden fields', () => {
        const result = applyVisibleInputDefaults(buildParams(), { startInputType: 'scheduleInput' })

        expect(result).not.toHaveProperty('formTitle')
    })

    it('does not synthesize defaults for fields without a `default`', () => {
        const result = applyVisibleInputDefaults(buildParams(), { startInputType: 'scheduleInput' })

        expect(result).not.toHaveProperty('scheduleFrequency')
    })

    it('preserves existing values, including falsy ones (empty string, false, 0, null)', () => {
        const params = [
            { name: 'a', type: 'string', default: 'fallback' },
            { name: 'b', type: 'boolean', default: 'fallback' },
            { name: 'c', type: 'number', default: 'fallback' },
            { name: 'd', type: 'string', default: 'fallback' }
        ]
        const result = applyVisibleInputDefaults(params, { a: '', b: false, c: 0, d: null })

        expect(result.a).toBe('')
        expect(result.b).toBe(false)
        expect(result.c).toBe(0)
        expect(result.d).toBeNull()
    })

    it('does not mutate the input map', () => {
        const inputs = { startInputType: 'scheduleInput' }
        const inputsBefore = { ...inputs }
        applyVisibleInputDefaults(buildParams(), inputs)
        expect(inputs).toEqual(inputsBefore)
    })

    it('handles undefined or null inputs gracefully', () => {
        expect(() => applyVisibleInputDefaults(buildParams(), undefined)).not.toThrow()
        expect(() => applyVisibleInputDefaults(buildParams(), null)).not.toThrow()
    })
})

describe('export of a node that is not installed', () => {
    const savedNode = {
        id: 'n1',
        position: { x: 1, y: 2 },
        data: {
            id: 'n1',
            label: 'Sample Pack Node',
            version: 1,
            name: 'samplePackNode',
            type: 'SamplePackNode',
            nodePack: 'sample-pack',
            inputs: { samplePackApi_CREDENTIAL_ID: 'cred-1', note: 'keep me' },
            extra: { untouched: true }
        }
    }

    it('keeps the missing node byte-identical and still exports a loaded node', () => {
        const saved = { nodes: [savedNode], edges: [{ id: 'e1' }] }
        const exported = generateExportFlowData(JSON.parse(JSON.stringify(saved)), ['chatOpenAI'])
        expect(JSON.stringify(exported.nodes[0])).toBe(JSON.stringify(saved.nodes[0]))
        expect(JSON.stringify(exported)).toBe(JSON.stringify(saved))

        const loaded = {
            nodes: [
                {
                    id: 'n2',
                    data: {
                        id: 'n2',
                        label: 'Sample Pack Node',
                        version: 1,
                        name: 'samplePackNode',
                        type: 'SamplePackNode',
                        nodePack: 'sample-pack',
                        baseClasses: ['SamplePackNode'],
                        inputParams: [{ name: 'note', type: 'string' }],
                        inputAnchors: [],
                        inputs: { note: 'keep me', samplePackApi_CREDENTIAL_ID: 'cred-1' },
                        outputAnchors: [],
                        outputs: {},
                        selected: false
                    }
                }
            ],
            edges: []
        }
        const out = generateExportFlowData(JSON.parse(JSON.stringify(loaded)), ['samplePackNode'])
        expect(out.nodes[0].data.nodePack).toBe('sample-pack')
        expect(out.nodes[0].data.inputs.samplePackApi_CREDENTIAL_ID).toBe('cred-1')
        expect(out.nodes[0].data.inputs.note).toBe('keep me')
    })

    it('exports the Rules text and its cap on a PostgreSQL MCP node, so an import gets both back', () => {
        const rules = 'Use monthly_sales for sales by month.\nWrite shop names as stores has them, for example Old Town.'
        const flow = {
            nodes: [
                {
                    id: 'postgreSQLMCP_0',
                    data: {
                        id: 'postgreSQLMCP_0',
                        label: 'PostgreSQL MCP',
                        version: 1.3,
                        name: 'postgreSQLMCP',
                        type: 'PostgreSQL MCP Tool',
                        baseClasses: ['Tool'],
                        inputParams: [
                            { name: 'analystRelations', type: 'asyncMultiOptions' },
                            { name: 'analystRules', type: 'string', rows: 6, maxLength: 2000 }
                        ],
                        inputAnchors: [],
                        inputs: { analystRelations: '["public.monthly_sales"]', analystRules: rules },
                        outputAnchors: [],
                        outputs: {},
                        selected: false
                    }
                }
            ],
            edges: []
        }
        const out = JSON.parse(JSON.stringify(generateExportFlowData(JSON.parse(JSON.stringify(flow)), ['postgreSQLMCP'])))
        expect(out.nodes[0].data.inputs.analystRules).toBe(rules)
        expect(out.nodes[0].data.inputParams.find((param) => param.name === 'analystRules').maxLength).toBe(2000)
    })
})
