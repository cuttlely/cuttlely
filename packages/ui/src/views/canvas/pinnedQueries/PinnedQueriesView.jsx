import { useId, useState } from 'react'
import PropTypes from 'prop-types'
import { Box, Dialog, Stack, Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { FREE_SQL_NUDGE, PARAM_TYPES, PIN_COLLAPSE_AT, filterPins, needsRetestMark, pinTitle } from './model'

export function FreeSqlNote() {
    return (
        <Typography variant='caption' data-testid='free-sql-nudge' sx={{ display: 'block', mt: 1 }}>
            {FREE_SQL_NUDGE}
        </Typography>
    )
}

function ParamTable({ editor, onParam = () => {}, onSample = () => {} }) {
    if (!editor.params.length) return <p>No parameters yet. Write :name in the SQL to add one, for example :region.</p>
    return (
        <div style={{ overflowX: 'auto' }}>
            <table data-testid='param-table' style={{ minWidth: 420 }}>
                <thead>
                    <tr>
                        <th scope='col'>Name</th>
                        <th scope='col'>Type</th>
                        <th scope='col'>Required</th>
                        <th scope='col'>Sample</th>
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
        </div>
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
                <div style={{ overflowX: 'auto' }}>
                    <table data-testid='result-rows'>
                        <thead>
                            <tr>
                                {Object.keys(rows[0]).map((name) => (
                                    <th key={name} scope='col'>
                                        {name}
                                    </th>
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
                </div>
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

const rowButton = {
    flexShrink: 0,
    whiteSpace: 'nowrap',
    font: 'inherit',
    fontSize: 12,
    padding: '2px 8px',
    marginLeft: 4,
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.45)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer'
}

const badge = {
    flexShrink: 0,
    whiteSpace: 'nowrap',
    fontSize: 11,
    fontWeight: 600,
    lineHeight: '18px',
    padding: '0 8px',
    borderRadius: 9,
    background: 'rgba(128,128,128,0.18)'
}

// Warning text dark enough to read on the light panel, and light enough on the dark one.
export function useWarnText() {
    const theme = useTheme()
    return theme?.palette?.mode === 'dark' ? '#ffb74d' : '#8a4b00'
}

const warnBadge = { background: 'rgba(237,108,2,0.14)', cursor: 'help' }

const canUseDom = typeof window !== 'undefined' && typeof document !== 'undefined' && typeof document.createElement === 'function'

// The editor opens as a dialog over the panel. Where there is no DOM (server render, tests) it renders in place.
function EditorShell({ onClose, busy = false, children }) {
    if (!canUseDom) return children
    // While Test & save runs the dialog stays open, so the answer lands in the editor that asked for it.
    return (
        <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth='md' aria-label='Pinned query' scroll='paper'>
            <Box sx={{ p: 3 }}>{children}</Box>
        </Dialog>
    )
}

EditorShell.propTypes = {
    onClose: PropTypes.func,
    busy: PropTypes.bool,
    children: PropTypes.node
}

const inputStyle = {
    display: 'block',
    width: '100%',
    marginTop: 4,
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.45)',
    font: 'inherit',
    background: 'transparent',
    color: 'inherit'
}

function PinEditor({
    editor,
    busy,
    disabled,
    error,
    result,
    onClose,
    onField,
    onParam,
    onSample,
    onRemoveSemicolon,
    onAddLimit,
    onTestSave
}) {
    return (
        <section role={canUseDom ? undefined : 'dialog'} aria-label='Pinned query' data-testid='pinned-query-editor'>
            <Typography variant='h4' sx={{ mb: 1.5 }}>
                {editor.purpose ? editor.purpose : 'New pinned query'}
            </Typography>
            {needsRetestMark(editor) ? <p data-testid='editor-needs-retest'>Needs re-test</p> : null}
            <Stack spacing={1.5}>
                {/* A read-only flow can open a pin to read it; every field is locked. */}
                <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                    <Stack spacing={1.5}>
                        <label>
                            Purpose
                            <input
                                data-testid='purpose'
                                style={inputStyle}
                                value={editor.purpose}
                                onChange={(event) => onField('purpose', event.target.value)}
                            />
                        </label>
                        <label>
                            Tool name
                            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <span data-testid='tool-prefix'>pq_</span>
                                <input
                                    data-testid='tool-slug'
                                    style={inputStyle}
                                    value={editor.slug}
                                    onChange={(event) => onField('slug', event.target.value)}
                                />
                            </span>
                        </label>
                        <label>
                            SQL
                            <textarea
                                data-testid='sql'
                                rows={6}
                                style={{ ...inputStyle, fontFamily: 'monospace' }}
                                value={editor.sql}
                                onChange={(event) => onField('sql', event.target.value)}
                            />
                        </label>
                        <span>
                            <button type='button' style={rowButton} data-testid='remove-semicolon' onClick={onRemoveSemicolon}>
                                Remove trailing semicolon
                            </button>
                            <button type='button' style={rowButton} data-testid='add-limit' onClick={onAddLimit}>
                                Add LIMIT 100
                            </button>
                        </span>
                        <ParamTable editor={editor} onParam={onParam} onSample={onSample} />
                        <details data-testid='advanced'>
                            <summary>Advanced</summary>
                            <label>
                                Description
                                <textarea
                                    data-testid='description'
                                    style={inputStyle}
                                    value={editor.description || ''}
                                    onChange={(event) => onField('description', event.target.value)}
                                />
                            </label>
                            <label>
                                Row cap
                                <input
                                    data-testid='row-cap'
                                    style={inputStyle}
                                    placeholder='Server limit (100 by default)'
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
                                                Array.isArray(param.allowedValues)
                                                    ? param.allowedValues.join(', ')
                                                    : param.allowedValues ?? ''
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
                    </Stack>
                </fieldset>
                {error ? (
                    <p data-testid='pinned-error' role='alert'>
                        {error}
                    </p>
                ) : null}
                <ResultPanel result={result} />
                <span>
                    <button type='button' style={rowButton} data-testid='test-save' disabled={busy || disabled} onClick={onTestSave}>
                        {busy ? 'Testing…' : 'Test & save'}
                    </button>
                    <button type='button' style={rowButton} data-testid='editor-close' onClick={onClose} disabled={busy}>
                        Close
                    </button>
                </span>
            </Stack>
        </section>
    )
}

PinEditor.propTypes = {
    editor: PropTypes.object.isRequired,
    busy: PropTypes.bool,
    disabled: PropTypes.bool,
    error: PropTypes.string,
    result: PropTypes.object,
    onClose: PropTypes.func,
    onField: PropTypes.func,
    onParam: PropTypes.func,
    onSample: PropTypes.func,
    onRemoveSemicolon: PropTypes.func,
    onAddLimit: PropTypes.func,
    onTestSave: PropTypes.func
}

function PinRow({ pin, busy, disabled, onEdit, onRemove }) {
    const title = pinTitle(pin)
    const warnText = useWarnText()
    return (
        <li
            data-testid={`pin-${pin.id}`}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 4px',
                borderBottom: '1px solid rgba(128,128,128,0.18)',
                listStyle: 'none'
            }}
        >
            <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                <span
                    data-testid='pin-title'
                    title={title}
                    style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}
                >
                    {title}
                </span>
                <span
                    data-testid='pin-name'
                    title={pin.name}
                    style={{
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontFamily: 'monospace',
                        fontSize: 11,
                        opacity: 0.7
                    }}
                >
                    {pin.name}
                </span>
            </span>
            {needsRetestMark(pin) ? (
                <span data-testid='needs-retest' style={{ flexShrink: 0, whiteSpace: 'nowrap', fontSize: 11, color: warnText }}>
                    Needs re-test
                </span>
            ) : null}
            <span style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                <button type='button' style={rowButton} aria-label={`Edit ${title}`} onClick={() => onEdit(pin)} disabled={busy}>
                    Edit
                </button>
                <button
                    type='button'
                    style={rowButton}
                    aria-label={`Remove ${title}`}
                    onClick={() => onRemove(pin.id)}
                    disabled={busy || disabled}
                >
                    Remove
                </button>
            </span>
        </li>
    )
}

PinRow.propTypes = {
    pin: PropTypes.object.isRequired,
    busy: PropTypes.bool,
    disabled: PropTypes.bool,
    onEdit: PropTypes.func,
    onRemove: PropTypes.func
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
    const long = pins.length > PIN_COLLAPSE_AT
    const [open, setOpen] = useState(!long)
    const [query, setQuery] = useState('')
    const [onlyRetest, setOnlyRetest] = useState(false)
    const listId = useId()
    const [showWarning, setShowWarning] = useState(false)
    const warnText = useWarnText()
    if (!enabled) return null
    const retestCount = pins.filter(needsRetestMark).length
    // The filter ends when the last pin to re-test is removed or passes, so the other pins come back.
    if (onlyRetest && !retestCount) setOnlyRetest(false)
    const retestOn = onlyRetest && retestCount > 0
    const shown = filterPins(pins, query, retestOn)
    const searching = Boolean(query.trim()) || retestOn
    const listVisible = open || searching
    return (
        <section data-testid='pinned-queries'>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'nowrap', mb: 0.5 }}>
                <button
                    type='button'
                    data-testid='pinned-toggle'
                    aria-expanded={listVisible}
                    aria-controls={listId}
                    onClick={() => setOpen(!open)}
                    style={{ ...rowButton, border: 'none', marginLeft: 0, padding: 0, fontWeight: 600, fontSize: 13 }}
                >
                    <span aria-hidden='true'>{listVisible ? '▾' : '▸'}</span> Pinned queries
                </button>
                <span data-testid='pin-count' style={badge} aria-label={`${pins.length} pinned queries`}>
                    {pins.length}
                </span>
                {warning ? (
                    <button
                        type='button'
                        data-testid='pin-warning'
                        title={warning}
                        aria-label={`Crowded: ${warning}`}
                        aria-expanded={showWarning}
                        onClick={() => setShowWarning(!showWarning)}
                        style={{ ...badge, ...warnBadge, color: warnText, border: 'none', font: 'inherit', fontSize: 11, fontWeight: 600 }}
                    >
                        Crowded
                    </button>
                ) : null}
                <Box sx={{ flexGrow: 1 }} />
                <button type='button' data-testid='pinned-add' onClick={onAdd} style={rowButton} disabled={busy || disabled}>
                    Add
                </button>
            </Box>
            <Typography variant='caption' color='text.secondary' data-testid='pinned-about' sx={{ display: 'block', mb: 0.5 }}>
                Saved SQL the analyst can run by name, with a friendly title.
            </Typography>
            {pins.length ? (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                    <input
                        type='search'
                        data-testid='pinned-search'
                        aria-label='Search pinned queries'
                        placeholder={`Search ${pins.length} pinned queries`}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        style={{ ...inputStyle, marginTop: 0, flex: '1 1 auto', minWidth: 0 }}
                    />
                    {retestCount ? (
                        <button
                            type='button'
                            data-testid='pinned-retest-filter'
                            aria-pressed={retestOn}
                            onClick={() => setOnlyRetest(!retestOn)}
                            style={{ ...rowButton, fontWeight: retestOn ? 700 : 400 }}
                        >
                            To re-test ({retestCount})
                        </button>
                    ) : null}
                </Box>
            ) : null}
            {pins.length && !listVisible ? (
                <Typography variant='caption' data-testid='pinned-collapsed' sx={{ display: 'block' }}>
                    {pins.length} pinned queries are hidden. Search, or open the list to see them.
                </Typography>
            ) : null}
            {listVisible ? (
                <ul id={listId} data-testid='pinned-list' style={{ margin: 0, padding: 0, maxHeight: 360, overflowY: 'auto' }}>
                    {shown.map((pin) => (
                        <PinRow key={pin.id} pin={pin} busy={busy} disabled={disabled} onEdit={onEdit} onRemove={onRemove} />
                    ))}
                </ul>
            ) : null}
            {listVisible && shown.length > 7 ? (
                <Typography variant='caption' color='text.secondary' data-testid='pinned-scroll' sx={{ display: 'block' }}>
                    {searching ? `${shown.length} of ${pins.length} match.` : `${pins.length} queries.`} Scroll the list to see them all.
                </Typography>
            ) : null}
            {warning && showWarning ? (
                <Typography variant='caption' data-testid='pin-warning-text' sx={{ display: 'block', mb: 0.5, color: warnText }}>
                    {warning}
                </Typography>
            ) : null}
            {listVisible && searching && !shown.length ? (
                <Typography variant='caption' data-testid='pinned-no-match' sx={{ display: 'block' }}>
                    No pinned query matches.
                </Typography>
            ) : null}
            <span aria-live='polite' style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                {searching ? `${shown.length} of ${pins.length} pinned queries shown` : ''}
            </span>
            {editor ? (
                <EditorShell onClose={onClose} busy={busy}>
                    <PinEditor
                        editor={editor}
                        busy={busy}
                        disabled={disabled}
                        error={error}
                        result={result}
                        onClose={onClose}
                        onField={onField}
                        onParam={onParam}
                        onSample={onSample}
                        onRemoveSemicolon={onRemoveSemicolon}
                        onAddLimit={onAddLimit}
                        onTestSave={onTestSave}
                    />
                </EditorShell>
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
