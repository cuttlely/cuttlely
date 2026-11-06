import { useState } from 'react'
import PropTypes from 'prop-types'
import { accountIdentity } from './AccountReport'
import { fieldLabel, formatValue, humanColumns } from './presentation'

export default function SourceTable({ rows, selectedColumns, onAccount, limit = 100 }) {
    const [sort, setSort] = useState(null)
    const ordered = rows.map((row, index) => ({ row, index }))
    if (sort)
        ordered.sort(
            (a, b) =>
                String(a.row[sort.field] ?? '').localeCompare(String(b.row[sort.field] ?? ''), undefined, { numeric: true }) *
                sort.direction
        )
    const columns = humanColumns(rows, selectedColumns)
    return (
        <div className='df-table-scroll nodrag nowheel'>
            <table>
                <thead>
                    <tr>
                        {columns.map((key) => (
                            <th key={key} aria-sort={sort?.field === key ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none'}>
                                <button
                                    className='df-sort-header'
                                    onClick={() => setSort({ field: key, direction: sort?.field === key ? -sort.direction : 1 })}
                                >
                                    {fieldLabel(key)} {sort?.field === key ? (sort.direction === 1 ? '↑' : '↓') : '↕'}
                                </button>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {ordered.slice(0, limit).map(({ row, index }) => (
                        <tr key={index}>
                            {columns.map((key) => (
                                <td
                                    key={key}
                                    title={typeof row[key] === 'object' ? '' : String(row[key] ?? '')}
                                    className={key.endsWith('_id') ? 'df-secondary-id' : undefined}
                                >
                                    {onAccount && key === 'account_name' && accountIdentity(row) ? (
                                        <button className='df-account-link' onClick={() => onAccount(row, index)}>
                                            {formatValue(row[key], key)} ↗
                                        </button>
                                    ) : /risk_radar|recorded_risk/.test(key) && row[key] ? (
                                        <span
                                            className={`df-risk-pill ${
                                                /^high/i.test(row[key])
                                                    ? 'df-risk-high'
                                                    : /^moderate/i.test(row[key])
                                                    ? 'df-risk-moderate'
                                                    : ''
                                            }`}
                                        >
                                            {formatValue(row[key], key)}
                                        </span>
                                    ) : (
                                        formatValue(row[key], key)
                                    )}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
SourceTable.propTypes = {
    rows: PropTypes.array.isRequired,
    selectedColumns: PropTypes.array,
    onAccount: PropTypes.func,
    limit: PropTypes.number
}
