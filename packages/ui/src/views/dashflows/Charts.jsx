import PropTypes from 'prop-types'

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
export default function Chart({ card, rows, inspect }) {
    const ordered = sortedRows(rows, card.valueField, card.sort)
    const numeric = ordered.filter(({ row }) => row[card.valueField] !== null)
    const values = numeric.map(({ row }) => Number(row[card.valueField]))
    const max = Math.max(1, ...values.map(Math.abs))
    const text = (v) => (v == null ? 'Unavailable' : String(v))
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
                            <circle
                                key={item.index}
                                cx={point(item, i).split(',')[0]}
                                cy={point(item, i).split(',')[1]}
                                r='5'
                                fill='#b596ff'
                                tabIndex={0}
                                role='button'
                                aria-label={`${text(item.row[card.labelField])}: ${text(item.row[card.valueField])}`}
                                onClick={() => inspect(item.index)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') inspect(item.index)
                                }}
                            >
                                <title>
                                    {text(item.row[card.labelField])}: {text(item.row[card.valueField])}
                                </title>
                            </circle>
                        ) : null
                    )}
                </svg>
                <div className='df-chart-ends'>
                    <span>{text(ordered[0]?.row[card.labelField])}</span>
                    <span>{text(ordered.at(-1)?.row[card.labelField])}</span>
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
                            <circle
                                key={item.index}
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
                                aria-label={`${text(item.row[card.labelField])}: ${text(item.row[card.valueField])}`}
                                onClick={() => inspect(item.index)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') inspect(item.index)
                                }}
                            >
                                <title>
                                    {text(item.row[card.labelField])}: {text(item.row[card.valueField])}
                                </title>
                            </circle>
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
                        <button key={item.index} onClick={() => inspect(item.index)}>
                            <i style={{ background: colors[i % colors.length] }} />
                            <span>{text(item.row[card.labelField])}</span>
                            <strong>{text(item.row[card.valueField])}</strong>
                        </button>
                    ))}
                </div>
            </div>
        )
    }
    return (
        <div className='df-bars nodrag nowheel'>
            {ordered.map(({ row, index }) => (
                <button
                    key={index}
                    className='df-bar-row'
                    title={`${text(row[card.labelField])}: ${text(row[card.valueField])} · Click for evidence`}
                    onClick={() => inspect(index)}
                >
                    <span>{text(row[card.labelField])}</span>
                    <strong>{text(row[card.valueField])}</strong>
                    <i style={{ width: `${(Math.abs(Number(row[card.valueField]) || 0) / max) * 100}%` }} />
                </button>
            ))}
        </div>
    )
}
Chart.propTypes = { card: PropTypes.object.isRequired, rows: PropTypes.array.isRequired, inspect: PropTypes.func.isRequired }
