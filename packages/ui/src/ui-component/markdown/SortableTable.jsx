import { Children, cloneElement, isValidElement, useState } from 'react'
import PropTypes from 'prop-types'
import { tableRowOrder } from '@cuttlely/chat'

const elements = (children) => Children.toArray(children).filter(isValidElement)
const text = (children) =>
    Children.toArray(children)
        .map((child) => (isValidElement(child) ? text(child.props.children) : String(child)))
        .join('')
const interactive = (children) =>
    elements(children).some(
        (child) => ['a', 'button', 'input', 'select', 'textarea'].includes(child.type) || interactive(child.props.children)
    )

export default function SortableTable({ children, node: _node, ...props }) {
    const [sort, setSort] = useState(null)
    const sections = elements(children)
    const head = sections.find((section) => section.type === 'thead')
    const body = sections.find((section) => section.type === 'tbody')
    const headRows = elements(head?.props.children)
    const headers = elements(headRows[0]?.props.children)
    const rows = elements(body?.props.children)
    const cells = rows.map((row) => elements(row.props.children))
    const simple =
        headRows.length === 1 &&
        rows.length > 0 &&
        cells.every((row) => row.length === headers.length) &&
        [...headers, ...cells.flat()].every((cell) => !cell.props.colSpan && !cell.props.rowSpan)
    if (!simple) return <table {...props}>{children}</table>

    const labels = headers.map((header) => text(header.props.children))
    const order = sort
        ? tableRowOrder(
              cells.map((row) => row.map((cell) => text(cell.props.children))),
              sort.column,
              sort.direction,
              labels[sort.column]
          )
        : rows.map((_, index) => index)
    const sortedHead = cloneElement(
        head,
        {},
        cloneElement(
            headRows[0],
            {},
            headers.map((header, column) => {
                if (!labels[column] || interactive(header.props.children)) return header
                const active = sort?.column === column
                const next = active && sort.direction === 'ascending' ? 'descending' : 'ascending'
                return cloneElement(
                    header,
                    { scope: 'col', 'aria-sort': active ? sort.direction : 'none' },
                    <button
                        type='button'
                        className='markdown-table-sort'
                        aria-label={`Sort by ${labels[column]}, ${next}`}
                        title={`Sort displayed rows by ${labels[column]} (${next})`}
                        onClick={() => setSort({ column, direction: next })}
                    >
                        {header.props.children}
                        <span className='markdown-table-sort-icon' aria-hidden='true'>
                            {active ? (sort.direction === 'ascending' ? '↑' : '↓') : '↕'}
                        </span>
                    </button>
                )
            })
        )
    )
    return (
        <table {...props}>
            {sections.map((section) =>
                section === head
                    ? sortedHead
                    : section === body
                    ? cloneElement(
                          body,
                          {},
                          order.map((index) => rows[index])
                      )
                    : section
            )}
        </table>
    )
}

SortableTable.propTypes = { children: PropTypes.node, node: PropTypes.object }
