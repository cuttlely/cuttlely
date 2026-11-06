import PropTypes from 'prop-types'
import ExecutiveTooltip from './ExecutiveTooltip'
import { formatValue, rowLabel } from './presentation'

export function sortedRows(rows, field, order) {
    const list = rows.map((row, index) => ({ row, index }))
    if (order === 'value-desc' || order === 'value-asc')
        list.sort((a, b) => {
            if (a.row[field] == null) return b.row[field] == null ? 0 : 1
            if (b.row[field] == null) return -1
            return (Number(a.row[field]) - Number(b.row[field])) * (order === 'value-desc' ? -1 : 1)
        })
    return list
}
/** Trends always keep returned observation order, including legacy saved value-sort configs. */
export function chartOrderedRows(card, rows) {
    return sortedRows(rows, card.valueField, card.kind === 'trend' ? 'source' : card.sort)
}
export default function Chart({ card, rows, snapshot, inspect }) {
    const ordered = chartOrderedRows(card, rows)
    const numeric = ordered.filter(({ row }) => row[card.valueField] !== null)
    const values = numeric.map(({ row }) => Number(row[card.valueField]))
    const max = Math.max(1, ...values.map(Math.abs))
    const text = (v) => formatValue(v, card.valueField)
    const label = (row) => rowLabel(row, card.labelField)
    if (card.kind === 'trend') {
        const low = Math.min(0, ...values),
            high = Math.max(1, ...values)
        const point = (item, i) =>
            `${20 + (i / Math.max(1, ordered.length - 1)) * 280},${130 - ((Number(item.row[card.valueField]) - low) / (high - low)) * 105}`
        return (
            <div className='nodrag df-trend'>
                <svg viewBox='0 0 320 155' role='img' aria-label={card.title}>
                    {[25, 77, 130].map((y) => (
                        <line key={y} x1='20' x2='300' y1={y} y2={y} stroke='#d8e1d3' strokeDasharray='4 5' />
                    ))}
                    {ordered
                        .slice(1)
                        .map((item, i) =>
                            item.row[card.valueField] != null && ordered[i].row[card.valueField] != null ? (
                                <polyline
                                    key={item.index}
                                    points={`${point(ordered[i], i)} ${point(item, i + 1)}`}
                                    fill='none'
                                    stroke='#9b7aff'
                                    strokeWidth='3'
                                />
                            ) : null
                        )}
                    {ordered.map((item, i) =>
                        item.row[card.valueField] != null ? (
                            <ExecutiveTooltip key={item.index} card={card} row={item.row} snapshot={snapshot}>
                                <circle
                                    cx={point(item, i).split(',')[0]}
                                    cy={point(item, i).split(',')[1]}
                                    r='5'
                                    fill='#b596ff'
                                    tabIndex={0}
                                    role='button'
                                    aria-label={`${label(item.row)}: ${text(item.row[card.valueField])}`}
                                    onClick={() => inspect(item.index)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') inspect(item.index)
                                    }}
                                ></circle>
                            </ExecutiveTooltip>
                        ) : null
                    )}
                </svg>
                <div className='df-chart-ends'>
                    <span>{ordered[0] ? label(ordered[0].row) : 'Not provided'}</span>
                    <span>{ordered.length ? label(ordered.at(-1).row) : 'Not provided'}</span>
                </div>
            </div>
        )
    }
    if (card.kind === 'donut') {
        const total = values.reduce((a, b) => a + b, 0)
        const colors = ['#a17aff', '#42c9d9', '#f49d62', '#f06b99', '#6387ff', '#b2d566', '#9babc8']
        let offset = 0
        return (
            <div className='df-composition nodrag nowheel'>
                <svg viewBox='0 0 180 180' role='img' aria-label={card.title}>
                    <circle cx='90' cy='90' r='65' fill='none' stroke='#dce4d6' strokeWidth='24' />
                    {numeric.map((item, i) => {
                        const length = total > 0 ? (Number(item.row[card.valueField]) / total) * 408.407 : 0
                        const start = offset
                        offset += length
                        return (
                            <ExecutiveTooltip key={item.index} card={card} row={item.row} snapshot={snapshot}>
                                <circle
                                    cx='90'
                                    cy='90'
                                    r='65'
                                    fill='none'
                                    stroke={colors[i % colors.length]}
                                    strokeWidth='24'
                                    strokeDasharray={`${length} ${408.407 - length}`}
                                    strokeDashoffset={-start}
                                    transform='rotate(-90 90 90)'
                                    role='button'
                                    tabIndex={0}
                                    aria-label={`${label(item.row)}: ${text(item.row[card.valueField])}`}
                                    onClick={() => inspect(item.index)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') inspect(item.index)
                                    }}
                                ></circle>
                            </ExecutiveTooltip>
                        )
                    })}
                    <text x='90' y='87' textAnchor='middle' fontSize='11' fill='#41644c'>
                        SOURCE
                    </text>
                    <text x='90' y='104' textAnchor='middle' fontSize='11' fill='#41644c'>
                        COMPOSITION
                    </text>
                </svg>
                <div className='df-chart-legend'>
                    {ordered.map((item, i) => (
                        <ExecutiveTooltip key={item.index} card={card} row={item.row} snapshot={snapshot}>
                            <button onClick={() => inspect(item.index)}>
                                <i style={{ background: colors[i % colors.length] }} />
                                <span>{label(item.row)}</span>
                                <strong>{text(item.row[card.valueField])}</strong>
                            </button>
                        </ExecutiveTooltip>
                    ))}
                </div>
            </div>
        )
    }
    return (
        <div className='df-bars nodrag nowheel'>
            {ordered.map(({ row, index }) => (
                <ExecutiveTooltip key={index} card={card} row={row} snapshot={snapshot}>
                    <button
                        className='df-bar-row'
                        aria-label={`${label(row)}: ${text(row[card.valueField])} · View evidence`}
                        onClick={() => inspect(index)}
                    >
                        <span>{label(row)}</span>
                        <strong>{text(row[card.valueField])}</strong>
                        <i style={{ width: `${(Math.abs(Number(row[card.valueField]) || 0) / max) * 100}%` }} />
                    </button>
                </ExecutiveTooltip>
            ))}
        </div>
    )
}
Chart.propTypes = {
    card: PropTypes.object.isRequired,
    rows: PropTypes.array.isRequired,
    snapshot: PropTypes.object,
    inspect: PropTypes.func.isRequired
}
