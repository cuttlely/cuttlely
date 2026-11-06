import { useEffect, useRef, useState } from 'react'
import { Alert, Button } from '@mui/material'
import PropTypes from 'prop-types'
import client from '@/api/client'
import { MemoizedReactMarkdown } from '@/ui-component/markdown/MemoizedReactMarkdown'

export const accountIdentity = (row) =>
    typeof row?.account_id === 'string' && /^001[A-Za-z0-9]{15}$/.test(row.account_id) ? row.account_id : null
export const healthQuestion = (id) =>
    `Run the full account health report for the verified Salesforce account ID ${id}. Use the ID-based full health source. Preserve exact source facts, dates, coverage and unknowns. Do not resolve or substitute a different account.`

export default function AccountReport({ row, harness, canRun }) {
    const [state, setState] = useState(null)
    const abort = useRef(null)
    const timer = useRef(null)
    const mounted = useRef(true)
    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
            abort.current?.abort()
            clearTimeout(timer.current)
        }
    }, [])
    const id = accountIdentity(row)
    if (!id) return null
    const start = async () => {
        const controller = new AbortController()
        abort.current = controller
        setState({ status: 'Starting full health report…' })
        try {
            const base = `/harnesses/${encodeURIComponent(harness)}/runs`
            const { data } = await client.post(`${base}/async`, { question: healthQuestion(id) }, { signal: controller.signal })
            const poll = async () => {
                try {
                    const { data: result } = await client.get(`${base}/${encodeURIComponent(data.runId)}/result`, {
                        signal: controller.signal
                    })
                    if (!mounted.current) return
                    setState({
                        status: result.status,
                        text: result.result?.text || '',
                        error: result.error ? 'The report run failed. Open the harness run history for details.' : '',
                        finished: result.finished
                    })
                    if (!result.finished) timer.current = setTimeout(poll, 2000)
                } catch (error) {
                    if (mounted.current && !controller.signal.aborted)
                        setState({
                            finished: true,
                            error: error.response?.data?.message || 'Could not read the report. It remains in the harness run history.'
                        })
                }
            }
            if (mounted.current) void poll()
        } catch (error) {
            if (mounted.current && !controller.signal.aborted)
                setState({ finished: true, error: error.response?.data?.message || 'Could not start the report.' })
        }
    }
    return (
        <section className='df-account-report'>
            <h3>{row.account_name || 'Account details'}</h3>
            <p className='df-hash'>{id}</p>
            <p>
                Full health runs Supreme against this exact account. It uses current source data and may differ from this dashboard
                snapshot.
            </p>
            {canRun ? (
                <Button variant='contained' disabled={!!state && !state.finished} onClick={start}>
                    Run full health report
                </Button>
            ) : (
                <Alert severity='info'>Your role can inspect this snapshot. Running a report requires harness run permission.</Alert>
            )}
            {state && <p role='status'>{state.status || 'Report status'} · Closing this panel leaves the run in harness history.</p>}
            {state?.error && <Alert severity='error'>{state.error}</Alert>}
            {state?.text && <MemoizedReactMarkdown>{state.text}</MemoizedReactMarkdown>}
            {state?.finished && !state.error && !state.text && (
                <Alert severity='warning'>This run returned no report text. Inspect the harness run history.</Alert>
            )}
        </section>
    )
}
AccountReport.propTypes = { row: PropTypes.object.isRequired, harness: PropTypes.string.isRequired, canRun: PropTypes.bool }
