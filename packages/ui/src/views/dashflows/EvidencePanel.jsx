import { useEffect, useRef, useState } from 'react'
import { Alert, Button, TextField, MenuItem } from '@mui/material'
import PropTypes from 'prop-types'
import AccountReport, { accountIdentity } from './AccountReport'
import SourceTable from './SourceTable'
import { fieldLabel, formatValue, sourceRecords } from './presentation'

export default function EvidencePanel({ evidence, harness, canRun, publicToken, onClose }) {
    const { card, snapshot } = evidence
    const initial = evidence.row === undefined ? null : snapshot.rows[evidence.row]
    const [selected, setSelected] = useState(initial && accountIdentity(initial) ? initial : null)
    const [search, setSearch] = useState('')
    const [risk, setRisk] = useState('All risks')
    const selectedPanel = useRef(null)
    useEffect(() => {
        if (selected) selectedPanel.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    }, [selected])
    const records = sourceRecords(snapshot)
    const risks = [...new Set(records.rows.map((r) => r.risk_radar || r.recorded_risk).filter(Boolean))]
    const visible = records.rows.filter(
        (r) =>
            (risk === 'All risks' || (r.risk_radar || r.recorded_risk) === risk) &&
            Object.values(r).some(
                (v) =>
                    typeof v !== 'object' &&
                    String(v ?? '')
                        .toLowerCase()
                        .includes(search.toLowerCase())
            )
    )
    const summaryRows = initial ? [initial] : snapshot.rows
    return (
        <div className='df-drawer df-evidence-panel'>
            <div className='df-evidence-heading'>
                <div>
                    <span className='df-eyebrow'>BEHIND THE NUMBERS</span>
                    <h2>{card.title}</h2>
                </div>
                <Button onClick={onClose}>Close</Button>
            </div>
            <p>{card.scope}</p>
            <div className='df-evidence-freshness'>
                <span>Stored snapshot</span>
                <strong>{new Date(snapshot.fetchedAt).toLocaleString()}</strong>
                <span>Exploring does not run a query</span>
            </div>
            {card.kind !== 'table' && (
                <section className='df-evidence-section'>
                    <h3>{initial ? 'Selected insight' : 'Source summary'}</h3>
                    <SourceTable
                        rows={summaryRows}
                        selectedColumns={
                            card.kind === 'metric'
                                ? [
                                      card.valueField,
                                      'window_start_inclusive',
                                      'window_end_exclusive',
                                      'start_date',
                                      'end_exclusive',
                                      'cohort_start',
                                      'cohort_end_exclusive',
                                      'renewal_year',
                                      'source_as_of',
                                      'latest_opportunity_sync'
                                  ]
                                : [
                                      card.labelField,
                                      card.valueField,
                                      'risk_signal_scope',
                                      'percent_of_risk_accounts',
                                      'known_deal_acv',
                                      'known_acv_count'
                                  ].filter(Boolean)
                        }
                    />
                </section>
            )}
            <section className='df-evidence-section'>
                <div className='df-evidence-section-heading'>
                    <h3>Accounts & opportunities</h3>
                    <span>{records.rows.length} available here · up to 100</span>
                </div>
                {records.rows.length ? (
                    <>
                        <p className='df-coverage'>
                            {records.total != null
                                ? `${records.rows.length} of ${formatValue(records.total)} source records in this scope.`
                                : `${records.rows.length} stored source records.`}{' '}
                            {records.paged ||
                            records.available > 100 ||
                            (records.total != null && Number(records.total) > records.rows.length)
                                ? 'This is a limited selection, not the full population. Totals above cover the source-defined cohort.'
                                : 'All available records from this source snapshot are shown.'}
                        </p>
                        <div className='df-evidence-filters'>
                            <TextField
                                size='small'
                                label='Find account or opportunity'
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                            <TextField select size='small' label='Recorded risk' value={risk} onChange={(e) => setRisk(e.target.value)}>
                                {['All risks', ...risks].map((v) => (
                                    <MenuItem key={v} value={v}>
                                        {v}
                                    </MenuItem>
                                ))}
                            </TextField>
                            <span>{visible.length} matching records</span>
                        </div>
                        <SourceTable rows={visible} onAccount={(row) => setSelected(row)} />
                        {!visible.length && <p>No records match these filters.</p>}
                    </>
                ) : (
                    <Alert severity='info'>
                        This source provides summary measures, not individual account records. Its available source rows are shown above; no
                        account list has been inferred from the totals.
                    </Alert>
                )}
            </section>
            {selected && (
                <section ref={selectedPanel} className='df-evidence-section df-selected-account'>
                    <div className='df-evidence-section-heading'>
                        <h3>{selected.account_name || 'Account name not provided'}</h3>
                        <Button onClick={() => setSelected(null)}>Clear selection</Button>
                    </div>
                    <div className='df-account-facts'>
                        {[
                            'opportunity_name',
                            'renewal_date',
                            'close_date',
                            'renewal_acv',
                            'deal_acv',
                            'current_account_acv',
                            'risk_radar',
                            'recorded_risk',
                            'risk_signal_scope'
                        ]
                            .filter((k) => selected[k] != null)
                            .map((key) => (
                                <div key={key}>
                                    <span>{fieldLabel(key)}</span>
                                    <strong>{formatValue(selected[key], key)}</strong>
                                </div>
                            ))}
                    </div>
                    {(selected.risk_drivers || selected.recorded_risk_drivers) && (
                        <p className='df-risk-context'>{selected.risk_drivers || selected.recorded_risk_drivers}</p>
                    )}
                    <details>
                        <summary>Record identifiers</summary>
                        <dl>
                            <dt>Account ID</dt>
                            <dd>{selected.account_id}</dd>
                            {selected.opportunity_id && (
                                <>
                                    <dt>Opportunity ID</dt>
                                    <dd>{selected.opportunity_id}</dd>
                                </>
                            )}
                        </dl>
                    </details>
                    <AccountReport key={selected.account_id} row={selected} harness={harness} canRun={canRun} publicToken={publicToken} />
                </section>
            )}
            <details className='df-technical-evidence'>
                <summary>Source verification & exact data</summary>
                <Alert severity='info'>
                    Pinned execution verified. Business scope and parameter selection are author supplied; they are not independently
                    certified.
                </Alert>
                <dl>
                    <dt>Harness / query</dt>
                    <dd>
                        {snapshot.source.harness} / {snapshot.source.pin}
                    </dd>
                    <dt>Source version</dt>
                    <dd>{snapshot.source.version}</dd>
                    <dt>Query fingerprint</dt>
                    <dd className='df-hash'>{snapshot.source.hash}</dd>
                    <dt>Exact parameters</dt>
                    <dd>
                        <pre>{JSON.stringify(snapshot.source.params, null, 2)}</pre>
                    </dd>
                </dl>
                <details>
                    <summary>Original typed source data</summary>
                    <pre>{JSON.stringify(snapshot.evidenceRows || snapshot.rows, null, 2)}</pre>
                </details>
            </details>
        </div>
    )
}
EvidencePanel.propTypes = {
    evidence: PropTypes.object.isRequired,
    harness: PropTypes.string.isRequired,
    canRun: PropTypes.bool,
    publicToken: PropTypes.string,
    onClose: PropTypes.func.isRequired
}
