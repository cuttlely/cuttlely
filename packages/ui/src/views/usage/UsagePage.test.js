/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('recharts', () => {
    const React = require('react')
    return {
        ResponsiveContainer: ({ children }) => children,
        BarChart: (props) => {
            // The stub only echoes the series so the test can see which days were charted.
            // eslint-disable-next-line react/prop-types
            const rows = props.data || []
            return React.createElement(
                'div',
                { 'data-testid': 'usage-chart-data' },
                rows.map((row) => `${row.day}:${row.Input}:${row.Output}`).join(' ')
            )
        },
        Bar: () => null,
        XAxis: () => null,
        YAxis: () => null,
        Tooltip: () => null,
        CartesianGrid: () => null,
        Legend: () => null
    }
})

jest.mock('@/api/usage', () => ({
    __esModule: true,
    default: {
        getUsage: jest.fn(),
        getModelPrices: jest.fn(),
        setModelPrice: jest.fn(),
        clearModelPrice: jest.fn()
    }
}))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import usageApi from '@/api/usage'
import UsagePage from './UsagePage'

const usage = {
    startDate: '2026-10-06',
    endDate: '2026-10-12',
    estimates: true,
    days: [
        { day: '2026-10-11', inputTokens: 105, outputTokens: 35, estimatedCostUsd: 0.0000716, price: 'partial' },
        { day: '2026-10-12', inputTokens: 116, outputTokens: 39, estimatedCostUsd: 0.0000824, price: 'partial' }
    ],
    flows: [
        { flowId: 'flow-bakery', inputTokens: 210, outputTokens: 70, estimatedCostUsd: 0.0001432, price: 'partial' },
        { flowId: 'flow-orders', inputTokens: 11, outputTokens: 4, estimatedCostUsd: 0.0000108, price: 'known' }
    ],
    models: [
        { model: 'claude', inputTokens: 60, outputTokens: 18, estimatedCostUsd: null, price: 'no price' },
        { model: 'gpt-4.1-mini', inputTokens: 161, outputTokens: 56, estimatedCostUsd: 0.000154, price: 'known' }
    ],
    totals: { inputTokens: 221, outputTokens: 74, estimatedCostUsd: 0.000154, price: 'partial', unpricedModels: ['claude'] }
}

const prices = {
    unit: 'usd_per_million_tokens',
    estimates: true,
    models: [
        {
            model: 'gpt-4.1-mini',
            default: { input: 0.4, output: 1.6 },
            override: { input: 0.5, output: 2 },
            effective: { input: 0.5, output: 2 }
        }
    ]
}

const emptyUsage = {
    startDate: '2026-10-06',
    endDate: '2026-10-12',
    estimates: true,
    days: [{ day: '2026-10-12', inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, price: 'known' }],
    flows: [],
    models: [],
    totals: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, price: 'known', unpricedModels: [] }
}

const renderPage = async (props) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(UsagePage, props)))
    })
    return root
}

describe('Usage page', () => {
    beforeEach(() => {
        usageApi.getUsage.mockReset()
        usageApi.getModelPrices.mockReset()
        usageApi.setModelPrice.mockReset()
        usageApi.clearModelPrice.mockReset()
        usageApi.getUsage.mockResolvedValue({ data: usage })
        usageApi.getModelPrices.mockResolvedValue({ data: prices })
        usageApi.setModelPrice.mockResolvedValue({ data: prices.models[0] })
        usageApi.clearModelPrice.mockResolvedValue({ data: { ...prices.models[0], override: null } })
        document.body.innerHTML = ''
    })

    it('renders daily tokens and the estimated cost per flow', async () => {
        const root = await renderPage({ isOwner: false })
        expect(usageApi.getUsage).toHaveBeenCalledWith({ days: 7 })
        expect(document.body.textContent).toContain('flow-bakery')
        expect(document.body.textContent).toContain('210')
        expect(document.body.textContent).toContain('$0.0001432 (some models have no price)')
        expect(document.body.textContent).toContain('flow-orders')
        expect(document.body.textContent).toContain('$0.0000108')
        expect(document.querySelector('[data-testid="usage-chart-data"]').textContent).toContain('2026-10-11:105:35')
        expect(document.querySelector('[data-testid="usage-chart-data"]').textContent).toContain('2026-10-12:116:39')
        expect(document.body.textContent).toContain('No price for claude')
        expect(document.body.textContent).not.toContain('Set a price')
        expect(document.getElementById('model-prices')).toBeNull()
        expect(usageApi.getModelPrices).not.toHaveBeenCalled()
        act(() => root.unmount())
    })

    it('changes the request when the range, flow, or model changes', async () => {
        const root = await renderPage({ isOwner: false })
        usageApi.getUsage.mockClear()

        await act(async () => {
            fireEvent.click(Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '30 days'))
        })
        expect(usageApi.getUsage).toHaveBeenCalledWith({ days: 30 })

        usageApi.getUsage.mockClear()
        await act(async () => {
            fireEvent.click(Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '90 days'))
        })
        expect(usageApi.getUsage).toHaveBeenCalledWith({ days: 90 })

        usageApi.getUsage.mockClear()
        const flow = document.querySelector('[aria-label="Flow"]')
        await act(async () => {
            fireEvent.change(flow, { target: { value: 'flow-bakery' } })
        })
        expect(usageApi.getUsage).toHaveBeenCalledWith({ days: 90, flowId: 'flow-bakery' })

        usageApi.getUsage.mockClear()
        const model = document.querySelector('[aria-label="Model"]')
        await act(async () => {
            fireEvent.change(model, { target: { value: 'gpt-4.1-mini' } })
        })
        expect(usageApi.getUsage).toHaveBeenCalledWith({ days: 90, flowId: 'flow-bakery', model: 'gpt-4.1-mini' })

        usageApi.getUsage.mockClear()
        await act(async () => {
            fireEvent.click(Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Custom'))
        })
        expect(usageApi.getUsage).toHaveBeenCalledWith({
            startDate: '2026-10-06',
            endDate: '2026-10-12',
            flowId: 'flow-bakery',
            model: 'gpt-4.1-mini'
        })

        usageApi.getUsage.mockClear()
        await act(async () => {
            fireEvent.change(document.querySelector('[aria-label="End date"]'), { target: { value: '2026-10-01' } })
        })
        expect(usageApi.getUsage).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('on or after')
        act(() => root.unmount())
    })

    it('shows the empty state when finished runs have not recorded tokens', async () => {
        usageApi.getUsage.mockResolvedValue({ data: emptyUsage })
        const root = await renderPage({ isOwner: false })
        expect(document.body.textContent).toContain('No usage yet')
        expect(document.body.textContent).toContain('Usage is recorded from finished runs.')
        expect(document.querySelector('[data-testid="usage-chart-data"]')).toBeNull()
        act(() => root.unmount())
    })

    it('lets an organization owner set and clear a price, and hides that editor otherwise', async () => {
        const root = await renderPage({ isOwner: true })
        expect(usageApi.getModelPrices).toHaveBeenCalled()
        expect(document.getElementById('model-prices')).not.toBeNull()
        expect(document.body.textContent).toContain('gpt-4.1-mini')
        expect(document.body.textContent).toContain('0.4')
        expect(document.body.textContent).toContain('Set a price')
        expect(document.querySelector('[aria-label="Clear price for gpt-4.1-mini"]').disabled).toBe(false)

        const input = document.querySelector('[aria-label="Input price for gpt-4.1-mini"]')
        const output = document.querySelector('[aria-label="Output price for gpt-4.1-mini"]')
        await act(async () => {
            fireEvent.change(input, { target: { value: '0.55' } })
            fireEvent.change(output, { target: { value: '2.2' } })
        })
        usageApi.getUsage.mockClear()
        await act(async () => {
            fireEvent.click(document.querySelector('[aria-label="Set price for gpt-4.1-mini"]'))
        })
        expect(usageApi.setModelPrice).toHaveBeenCalledWith({ model: 'gpt-4.1-mini', input: 0.55, output: 2.2 })
        expect(usageApi.getUsage).toHaveBeenCalled()

        await act(async () => {
            fireEvent.click(document.querySelector('[aria-label="Clear price for gpt-4.1-mini"]'))
        })
        expect(usageApi.clearModelPrice).toHaveBeenCalledWith('gpt-4.1-mini')
        act(() => root.unmount())
    })
})
