/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { render, screen, fireEvent } from '@testing-library/react'
import RefreshStatus from './RefreshStatus'
const snapshot = {
    refreshedAt: '2026-11-06T12:00:00Z',
    pipelineViews: { views: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, {}])) }
}
it('shows actual progress, active ranges, elapsed time and last-good data during a refresh', () => {
    render(
        <RefreshStatus
            record={{
                refreshing: true,
                snapshot,
                refreshProgress: {
                    status: 'running',
                    phase: 'views',
                    completed: 12,
                    total: 20,
                    active: ['EMEA · Next 90 days'],
                    startedAt: new Date(Date.now() - 30000).toISOString(),
                    updatedAt: new Date().toISOString()
                }
            }}
        />
    )
    expect(screen.getByText('12 / 20 period/region views ready')).toBeTruthy()
    expect(screen.getByText('EMEA · Next 90 days')).toBeTruthy()
    expect(screen.getByText(/Showing last successful snapshot/)).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('60')
})
it('shows a failure and retry without claiming a successful refresh', () => {
    const retry = jest.fn()
    render(
        <RefreshStatus
            onRetry={retry}
            record={{
                snapshot,
                error: 'Source validation failed.',
                refreshProgress: { status: 'failed', failedViews: ['APJ · This quarter'] }
            }}
        />
    )
    expect(screen.getByText('Refresh failed')).toBeTruthy()
    expect(screen.getByText(/Could not prepare: APJ/)).toBeTruthy()
    expect(screen.queryByText(/Ready to publish/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry refresh' }))
    expect(retry).toHaveBeenCalledTimes(1)
})
it('reports completion and discloses first-sync state rather than inventing previous data', () => {
    const { rerender } = render(<RefreshStatus record={{ refreshing: true }} />)
    expect(screen.getByText(/No successful snapshot/)).toBeTruthy()
    rerender(<RefreshStatus record={{ snapshot, refreshProgress: { status: 'completed' } }} />)
    expect(screen.getByText('20 cached views prepared · Ready to publish')).toBeTruthy()
})
