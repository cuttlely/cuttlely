import PropTypes from 'prop-types'
import { Typography } from '@mui/material'
import { FREE_SQL_NUDGE, PARAM_TYPES, needsRetestMark } from './model'

const buttonStyle = {
    marginRight: 8,
    marginTop: 8
}

export function FreeSqlNote() {
    return (
        <Typography variant='caption' data-testid='free-sql-nudge' sx={{ display: 'block', mt: 1 }}>
            {FREE_SQL_NUDGE}
        </Typography>
    )
}

function ParamTable({ editor, onParam = () => {}, onSample = () => {} }) {
    if (!editor.params.length) return <p>No parameters yet. Names look like :region.</p>
    return (
        <table data-testid='param-table'>
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Required</th>
                    <th>Sample</th>
                </tr>
            </thead>
            <tbody>
                {editor.params.map((param) => (
                    <tr key={param.name}>
                        <td>{param.name}</td>
                        <td>
                            <label>
                                Type for {param.name}
                                <select
                                    data-testid={`type-${param.name}`}
                                    value={param.type || ''}
                                    onChange={(event) => onParam(param.name, { type: event.target.value })}
                                >
                                    <option value=''>Choose a type</option>
                                    {PARAM_TYPES.map((type) => (
                                        <option key={type} value={type}>
                                            {type}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </td>
                        <td>
                            <label>
                                Required
                                <input
                                    type='checkbox'
                                    data-testid={`required-${param.name}`}
                                    checked={param.required !== false}
                                    onChange={(event) => onParam(param.name, { required: event.target.checked })}
                                />
                            </label>
                        </td>
                        <td>
                            <label>
                                Sample for {param.name}
                                <input
                                    data-testid={`sample-${param.name}`}
                                    value={editor.samples?.[param.name] ?? ''}
                                    onChange={(event) => onSample(param.name, event.target.value)}
                                />
                            </label>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}

ParamTable.propTypes = {
    editor: PropTypes.object.isRequired,
    onParam: PropTypes.func,
    onSample: PropTypes.func
}

function ResultPanel({ result }) {
    if (!result) return null
    const columns = Array.isArray(result.columns) ? result.columns : []
    const rows = Array.isArray(result.rows) ? result.rows : []
    const guard = Array.isArray(result.guard) ? result.guard : []
    return (
        <section data-testid='test-result'>
            <p data-testid='test-summary'>
                {result.rowCount} rows in {result.timeMs} ms
            </p>
            <p data-testid='test-columns'>
                Columns: {columns.length ? columns.map((column) => `${column.name} ${column.type || 'type unread'}`).join(', ') : 'none'}
            </p>
            {result.possiblyTruncated ? <p data-testid='possibly-truncated'>possibly truncated</p> : null}
            <ul data-testid='guard-words'>
                {guard.map((line) => (
                    <li key={line}>{line}</li>
                ))}
            </ul>
            {rows.length ? (
                <table data-testid='result-rows'>
                    <thead>
                        <tr>
                            {Object.keys(rows[0]).map((name) => (
                                <th key={name}>{name}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, index) => (
                            <tr key={index}>
                                {Object.keys(rows[0]).map((name) => (
                                    <td key={name}>{row[name] == null ? '' : String(row[name])}</td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : null}
            <details data-testid='tool-preview'>
                <summary>Tool the agent will see</summary>
                <pre>{JSON.stringify(result.tool || {}, null, 2)}</pre>
            </details>
        </section>
    )
}

ResultPanel.propTypes = {
    result: PropTypes.object
}

export function PinnedQueriesView({
    enabled = false,
    pins = [],
    editor = null,
    warning = '',
    busy = false,
    disabled = false,
    error = '',
    result = null,
    onAdd,
    onEdit,
    onRemove,
    onClose,
    onField,
    onParam,
    onSample,
    onRemoveSemicolon,
    onAddLimit,
    onTestSave
}) {
    if (!enabled) return null
    return (
        <section data-testid='pinned-queries'>
            <Typography variant='subtitle2'>Pinned queries</Typography>
            {warning ? <p data-testid='pin-warning'>{warning}</p> : null}
            <button type='button' data-testid='pinned-add' onClick={onAdd} style={buttonStyle} disabled={busy || disabled}>
                Add
            </button>
            <ul data-testid='pinned-list'>
                {pins.map((pin) => (
                    <li key={pin.id} data-testid={`pin-${pin.id}`}>
                        <span>{pin.name}</span>
                        {needsRetestMark(pin) ? <span data-testid='needs-retest'>Needs re-test</span> : null}
                        <button type='button' onClick={() => onEdit(pin)} disabled={busy}>
                            Edit
                        </button>
                        <button type='button' onClick={() => onRemove(pin.id)} disabled={busy || disabled}>
                            Remove
                        </button>
                    </li>
                ))}
            </ul>
            {editor ? (
                <section role='dialog' aria-label='Pinned query' data-testid='pinned-query-editor'>
                    {needsRetestMark(editor) ? <p data-testid='editor-needs-retest'>Needs re-test</p> : null}
                    <label>
                        Purpose
                        <input data-testid='purpose' value={editor.purpose} onChange={(event) => onField('purpose', event.target.value)} />
                    </label>
                    <label>
                        Tool name
                        <span data-testid='tool-prefix'>pq_</span>
                        <input data-testid='tool-slug' value={editor.slug} onChange={(event) => onField('slug', event.target.value)} />
                    </label>
                    <label>
                        SQL
                        <textarea data-testid='sql' value={editor.sql} onChange={(event) => onField('sql', event.target.value)} />
                    </label>
                    <button type='button' data-testid='remove-semicolon' onClick={onRemoveSemicolon}>
                        Remove trailing semicolon
                    </button>
                    <button type='button' data-testid='add-limit' onClick={onAddLimit}>
                        Add LIMIT 100
                    </button>
                    <ParamTable editor={editor} onParam={onParam} onSample={onSample} />
                    <details data-testid='advanced'>
                        <summary>Advanced</summary>
                        <label>
                            Description
                            <textarea
                                data-testid='description'
                                value={editor.description || ''}
                                onChange={(event) => onField('description', event.target.value)}
                            />
                        </label>
                        <label>
                            Row cap
                            <input
                                data-testid='row-cap'
                                value={editor.rowCap ?? ''}
                                onChange={(event) => onField('rowCap', event.target.value)}
                            />
                        </label>
                        {editor.params.map((param) => (
                            <fieldset key={param.name}>
                                <legend>{param.name}</legend>
                                <label>
                                    Default
                                    <input
                                        data-testid={`default-${param.name}`}
                                        value={param.default ?? ''}
                                        onChange={(event) => onParam(param.name, { default: event.target.value })}
                                    />
                                </label>
                                <label>
                                    Allowed values
                                    <input
                                        data-testid={`allowed-${param.name}`}
                                        value={
                                            Array.isArray(param.allowedValues) ? param.allowedValues.join(', ') : param.allowedValues ?? ''
                                        }
                                        onChange={(event) => onParam(param.name, { allowedValues: event.target.value })}
                                    />
                                </label>
                                <label>
                                    Min
                                    <input
                                        data-testid={`min-${param.name}`}
                                        value={param.min ?? ''}
                                        onChange={(event) => onParam(param.name, { min: event.target.value })}
                                    />
                                </label>
                                <label>
                                    Max
                                    <input
                                        data-testid={`max-${param.name}`}
                                        value={param.max ?? ''}
                                        onChange={(event) => onParam(param.name, { max: event.target.value })}
                                    />
                                </label>
                                <label>
                                    Secure
                                    <input
                                        type='checkbox'
                                        data-testid={`secure-${param.name}`}
                                        checked={param.secure === true}
                                        onChange={(event) => onParam(param.name, { secure: event.target.checked })}
                                    />
                                </label>
                            </fieldset>
                        ))}
                    </details>
                    {error ? <p data-testid='pinned-error'>{error}</p> : null}
                    <ResultPanel result={result} />
                    <button type='button' data-testid='test-save' disabled={busy || disabled} onClick={onTestSave}>
                        {busy ? 'Testing…' : 'Test & save'}
                    </button>
                    <button type='button' onClick={onClose}>
                        Close
                    </button>
                </section>
            ) : null}
        </section>
    )
}

PinnedQueriesView.propTypes = {
    enabled: PropTypes.bool,
    pins: PropTypes.array,
    editor: PropTypes.object,
    warning: PropTypes.string,
    busy: PropTypes.bool,
    disabled: PropTypes.bool,
    error: PropTypes.string,
    result: PropTypes.object,
    onAdd: PropTypes.func,
    onEdit: PropTypes.func,
    onRemove: PropTypes.func,
    onClose: PropTypes.func,
    onField: PropTypes.func,
    onParam: PropTypes.func,
    onSample: PropTypes.func,
    onRemoveSemicolon: PropTypes.func,
    onAddLimit: PropTypes.func,
    onTestSave: PropTypes.func
}
