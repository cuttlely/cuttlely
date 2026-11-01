import { useState } from 'react'
import { friendlyChipLabel, friendlyToolName, tableCsv, tableText } from '@/utils/traceChips'
import PropTypes from 'prop-types'
import { useSelector } from 'react-redux'
import { alpha, useTheme } from '@mui/material/styles'
import { Box, Chip, Collapse, Stack, Tooltip, Typography } from '@mui/material'
import { IconCheck, IconChevronDown, IconChevronRight, IconX } from '@tabler/icons-react'
import {
    analystPreviewCaption,
    analystStepView,
    formatDuration,
    formatTokens,
    routeSummary,
    traceQuestionForCaption
} from '../../../../../packages/harness/trace.mjs'

const FILL_NOTE = {
    none: 'The tool took the question as its input.',
    valid: 'The question already matched the tool input.',
    model: 'A model call filled the tool input.',
    'model-empty': 'The model did not return a tool input.'
}

function statusWord(status) {
    if (status === 'running') return 'Running'
    if (status === 'failed') return 'Stopped'
    if (status === 'partial') return 'Finished with a failed specialist'
    return 'Finished'
}

function specialistWord(status) {
    if (status === 'running') return 'running'
    if (status === 'failed') return 'failed'
    return 'done'
}

function routeLine(trace) {
    return routeSummary(trace)
}

function handoffLine(trace, specialist) {
    if (trace.handoff?.status === 'skipped' && trace.handoff.reason === 'pinFirst' && trace.handoff.rule?.pin)
        return `Pinned query ${trace.handoff.rule?.pin} ran first (${trace.handoff.rule?.id}). This result is the answer.`
    if (trace.direct || trace.handoff?.status === 'skipped') return 'This result is the answer.'
    if (specialist.status === 'failed') return 'Harness Prime was told this specialist failed.'
    if (trace.handoff?.status === 'running') return 'Harness Prime is combining this result.'
    if (trace.handoff?.status === 'done') return 'Harness Prime combined this result into the answer.'
    return ''
}

function StatusMark({ status }) {
    const theme = useTheme()
    if (status === 'running') {
        return (
            <Box
                component='span'
                role='img'
                aria-label='running'
                sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: theme.palette.warning.main,
                    display: 'inline-block'
                }}
            />
        )
    }
    if (status === 'failed') {
        return <IconX size={16} color={theme.palette.error.main} role='img' aria-label='failed' />
    }
    return <IconCheck size={16} color={theme.palette.success.main} role='img' aria-label='done' />
}

StatusMark.propTypes = {
    status: PropTypes.string
}

function Meta({ children }) {
    if (!children) return null
    return (
        <Typography variant='caption' color='text.secondary' sx={{ whiteSpace: 'nowrap' }}>
            {children}
        </Typography>
    )
}

Meta.propTypes = {
    children: PropTypes.node
}

// The preview starts closed. The chip shows the row count; opening it shows the short table.
// The caption stays in this chat. It does not link away to the harness page.
const smallButton = {
    border: '1px solid',
    borderColor: 'divider',
    borderRadius: 1,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 12,
    px: 1,
    py: 0.25,
    whiteSpace: 'nowrap'
}

function downloadCsv(view) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const url = URL.createObjectURL(new Blob([tableCsv(view)], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'query-rows.csv'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
}

// Pages served over plain http have no clipboard API, so copy through a hidden text box there.
function copyWithSelection(text) {
    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
    const box = document.createElement('textarea')
    box.value = text
    box.setAttribute('readonly', '')
    box.style.position = 'fixed'
    box.style.opacity = '0'
    document.body.appendChild(box)
    box.select()
    let done = false
    try {
        done = document.execCommand('copy')
    } catch {
        done = false
    }
    document.body.removeChild(box)
    return done
}

export function QueryRows({ view, question, sql }) {
    const [showSql, setShowSql] = useState(false)
    const [copied, setCopied] = useState('')
    const copy = async () => {
        const text = tableText(view)
        try {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
            else if (!copyWithSelection(text)) throw new Error('copy unavailable')
            setCopied('Rows copied.')
        } catch {
            setCopied(copyWithSelection(text) ? 'Rows copied.' : 'Could not copy. Select the table and copy it instead.')
        }
    }
    return (
        <Box sx={{ pt: 0.5 }}>
            <Typography variant='caption' color='text.secondary' component='p' sx={{ mb: 0.5 }}>
                {analystPreviewCaption(view, question || '')}
            </Typography>
            <Stack direction='row' spacing={0.5} sx={{ mb: 0.5, alignItems: 'center' }}>
                {sql ? (
                    <Box component='button' type='button' sx={smallButton} aria-expanded={showSql} onClick={() => setShowSql(!showSql)}>
                        {showSql ? 'Hide SQL' : 'Show SQL'}
                    </Box>
                ) : null}
                <Box component='button' type='button' sx={smallButton} onClick={copy}>
                    Copy
                </Box>
                <Box component='button' type='button' sx={smallButton} onClick={() => downloadCsv(view)}>
                    CSV
                </Box>
                <Typography variant='caption' color='text.secondary' role='status' aria-live='polite'>
                    {copied}
                </Typography>
            </Stack>
            {sql && showSql ? (
                <Box
                    component='pre'
                    data-testid='trace-sql'
                    sx={{ m: 0, mb: 0.5, p: 1, fontSize: 12, whiteSpace: 'pre-wrap', bgcolor: 'action.hover', borderRadius: 1 }}
                >
                    {sql}
                </Box>
            ) : null}
            <Box sx={{ maxHeight: 320, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                <Box component='table' sx={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                    <thead>
                        <tr>
                            {view.columns.map((column) => (
                                <Box
                                    component='th'
                                    scope='col'
                                    key={column}
                                    sx={{
                                        position: 'sticky',
                                        top: 0,
                                        bgcolor: 'background.paper',
                                        textAlign: 'left',
                                        fontWeight: 600,
                                        px: 1,
                                        py: 0.5,
                                        borderBottom: '1px solid',
                                        borderColor: 'divider',
                                        whiteSpace: 'nowrap'
                                    }}
                                >
                                    {column}
                                </Box>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {view.rows.map((row, rowIndex) => (
                            <tr key={rowIndex}>
                                {row.map((cell, cellIndex) => (
                                    <Box
                                        component='td'
                                        key={cellIndex}
                                        sx={{
                                            px: 1,
                                            py: 0.25,
                                            borderBottom: '1px solid',
                                            borderColor: 'divider',
                                            overflowWrap: 'anywhere'
                                        }}
                                    >
                                        {cell}
                                    </Box>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </Box>
            </Box>
            {view.summary ? (
                <Typography variant='caption' color='text.secondary' component='p' sx={{ mt: 0.5 }}>
                    {view.summary}
                </Typography>
            ) : null}
        </Box>
    )
}

QueryRows.propTypes = {
    view: PropTypes.object,
    question: PropTypes.string,
    sql: PropTypes.string
}

export function previousUserQuestion(messages, index) {
    const list = messages || []
    for (let i = index - 1; i >= 0; i -= 1) {
        const item = list[i]
        if (item?.type !== 'userMessage' && item?.type !== 'usermessagewaiting') continue
        return typeof item.message === 'string' ? item.message : ''
    }
    return ''
}

// The run stores the question it actually used. The prop is only the live card
// before that final event, or a trace saved before questions were stored.
// A chat bubble or a later edit of the Try it box can differ from that question.
export function questionForTrace(trace, question) {
    const stored = traceQuestionForCaption(trace)
    if (stored) return stored
    return typeof question === 'string' ? question : ''
}

// Try it keeps the textarea editable after the run. The card uses the prompt
// that was sent, not whatever is in the box now.
export function tryItTraceQuestion(submittedQuestion) {
    return typeof submittedQuestion === 'string' ? submittedQuestion : ''
}

// history.mjs previewText keeps 240 characters and appends … when it cuts.
// Wording past that cut (a count or a total) must not be treated as present.
const INPUT_PREVIEW_LIMIT = 240

export function questionFromInputPreview(preview) {
    if (typeof preview !== 'string' || !preview) return ''
    if (preview.length > INPUT_PREVIEW_LIMIT && preview.endsWith('…')) return ''
    return preview
}

const HarnessRunTrace = ({ trace, question }) => {
    const asked = questionForTrace(trace, question)
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)
    const [openName, setOpenName] = useState('')
    const [cutsOpen, setCutsOpen] = useState(false)
    const [rowsKey, setRowsKey] = useState('')
    if (!trace) return null

    const dark = Boolean(customization?.isDarkMode)
    const wall = formatDuration(trace.wallMs)
    const tokens = formatTokens(trace.tokens)
    const phases = [
        trace.timings?.routeMs ? `Route ${formatDuration(trace.timings.routeMs)}` : '',
        trace.timings?.specialistsMs ? `Specialists ${formatDuration(trace.timings.specialistsMs)}` : '',
        trace.handoff?.status === 'done' ? `Handoff ${formatDuration(trace.handoff.ms)}` : '',
        trace.timings && trace.timings.profileSkipped === false && trace.timings.profileMs
            ? `Profile ${formatDuration(trace.timings.profileMs)}`
            : ''
    ].filter(Boolean)

    return (
        <Box
            sx={{
                mt: 1,
                mb: 1.5,
                borderRadius: 2,
                border: '1px solid',
                borderColor: alpha(theme.palette.primary.main, dark ? 0.45 : 0.22),
                background: dark ? alpha(theme.palette.primary.main, 0.08) : alpha(theme.palette.primary.main, 0.04),
                overflow: 'hidden'
            }}
        >
            <Stack spacing={0.5} sx={{ px: 1.5, py: 1.25 }}>
                <Stack direction='row' spacing={1} useFlexGap flexWrap='wrap' sx={{ alignItems: 'center' }}>
                    <Chip size='small' label='Run' color='primary' variant='outlined' sx={{ height: 22 }} />
                    <Typography variant='subtitle2'>{trace.harness || 'Harness'}</Typography>
                    <Typography variant='caption' color='text.secondary' role='status' aria-live='polite'>
                        {statusWord(trace.status)}
                    </Typography>
                    {wall ? (
                        <Typography variant='caption' color='text.secondary'>
                            {wall}
                        </Typography>
                    ) : null}
                    {tokens ? (
                        <Typography variant='caption' color='text.secondary'>
                            {tokens}
                        </Typography>
                    ) : null}
                </Stack>
                <Typography variant='body2'>{routeLine(trace)}</Typography>
                {phases.length ? (
                    <Typography variant='caption' color='text.secondary'>
                        {phases.join(' · ')}
                    </Typography>
                ) : null}
            </Stack>
            <Stack sx={{ px: 1, pb: 1 }} spacing={0.5}>
                {(trace.specialists || []).map((specialist) => {
                    const open = openName === specialist.name
                    const toolCount = specialist.tools?.length || 0
                    const rowViews = (specialist.tools || []).map((tool) => analystStepView(tool))
                    const openRows = rowViews.findIndex((view, index) => view && rowsKey === `${specialist.name}:${index}`)
                    return (
                        <Box key={specialist.name}>
                            <Box
                                component='button'
                                type='button'
                                aria-expanded={open}
                                onClick={() => setOpenName(open ? '' : specialist.name)}
                                sx={{
                                    width: '100%',
                                    textAlign: 'left',
                                    border: 0,
                                    cursor: 'pointer',
                                    borderRadius: 1.5,
                                    px: 1,
                                    py: 0.75,
                                    color: 'inherit',
                                    background: open ? alpha(theme.palette.primary.main, dark ? 0.18 : 0.08) : 'transparent',
                                    '&:hover': { background: alpha(theme.palette.primary.main, dark ? 0.22 : 0.1) }
                                }}
                            >
                                <Stack direction='row' spacing={1} useFlexGap flexWrap='wrap' sx={{ alignItems: 'center' }}>
                                    {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
                                    <StatusMark status={specialist.status} />
                                    <Typography variant='body2' sx={{ fontWeight: 600 }}>
                                        {specialist.name}
                                    </Typography>
                                    <Typography variant='caption' color='text.secondary'>
                                        {specialistWord(specialist.status)}
                                    </Typography>
                                    <Meta>{specialist.model}</Meta>
                                    <Meta>{formatDuration(specialist.ms)}</Meta>
                                    <Meta>{formatTokens(specialist.tokens)}</Meta>
                                    {specialist.fallback ? <Meta>{`Fell back to ${specialist.fallback}`}</Meta> : null}
                                    {toolCount ? <Meta>{`${toolCount} tool${toolCount === 1 ? '' : 's'}`}</Meta> : null}
                                </Stack>
                            </Box>
                            <Collapse in={open}>
                                <Stack spacing={0.75} sx={{ px: 1.5, pt: 0.5, pb: 1 }}>
                                    {specialist.task ? (
                                        <Typography variant='body2' sx={{ whiteSpace: 'pre-wrap' }}>
                                            {specialist.task}
                                        </Typography>
                                    ) : null}
                                    {specialist.fallback ? (
                                        <Typography variant='caption' color='text.secondary'>
                                            {`Answered by the fallback model ${specialist.fallback}.`}
                                        </Typography>
                                    ) : null}
                                    {specialist.tools?.length ? (
                                        <Stack direction='row' spacing={0.5} useFlexGap flexWrap='wrap'>
                                            {specialist.tools.map((tool, index) => {
                                                const view = rowViews[index]
                                                const key = `${specialist.name}:${index}`
                                                const expandable = Boolean(view?.rows?.length)
                                                const countLabel = friendlyChipLabel(tool, view)
                                                const chip = expandable ? (
                                                    <Chip
                                                        size='small'
                                                        variant={openRows === index ? 'filled' : 'outlined'}
                                                        color={tool.status === 'failed' ? 'error' : 'default'}
                                                        label={countLabel}
                                                        aria-expanded={openRows === index}
                                                        onClick={() => setRowsKey(rowsKey === key ? '' : key)}
                                                    />
                                                ) : view ? (
                                                    <Chip
                                                        size='small'
                                                        variant='outlined'
                                                        color={tool.status === 'failed' ? 'error' : 'default'}
                                                        label={countLabel}
                                                    />
                                                ) : (
                                                    <Chip
                                                        size='small'
                                                        variant='outlined'
                                                        color={tool.status === 'failed' ? 'error' : 'default'}
                                                        label={countLabel}
                                                    />
                                                )
                                                if (tool.status !== 'retried' || !tool.detail) {
                                                    return (
                                                        <span key={`${tool.name}-${index}`} title={tool.name}>
                                                            {chip}
                                                        </span>
                                                    )
                                                }
                                                return (
                                                    <Tooltip key={`${tool.name}-${index}`} title={tool.detail} placement='top'>
                                                        <span>{chip}</span>
                                                    </Tooltip>
                                                )
                                            })}
                                        </Stack>
                                    ) : (
                                        <Typography variant='caption' color='text.secondary'>
                                            No tool calls recorded
                                        </Typography>
                                    )}
                                    {openRows >= 0 ? (
                                        <QueryRows
                                            view={rowViews[openRows]}
                                            question={asked}
                                            sql={typeof specialist.tools[openRows]?.sql === 'string' ? specialist.tools[openRows].sql : ''}
                                        />
                                    ) : null}
                                    {(specialist.tools || [])
                                        .filter((tool) => tool.status === 'retried' && tool.detail)
                                        .map((tool, index) => (
                                            <Typography key={`retried-${index}`} variant='caption' color='text.secondary'>
                                                {`${friendlyToolName(tool.name)} was retried: ${tool.detail}`}
                                            </Typography>
                                        ))}
                                    {specialist.sources?.length ? (
                                        <Typography variant='caption' color='text.secondary'>
                                            {`Sources: ${specialist.sources.map((source) => source.name).join(', ')}`}
                                        </Typography>
                                    ) : null}
                                    {specialist.error ? (
                                        <Typography variant='caption' color='error'>
                                            {specialist.error}
                                        </Typography>
                                    ) : null}
                                    {trace.directDetail && trace.specialists?.length === 1 ? (
                                        <Typography variant='caption' color='text.secondary'>
                                            {[
                                                FILL_NOTE[trace.directDetail.fill] || '',
                                                formatDuration(trace.directDetail.fillMs)
                                                    ? `Fill ${formatDuration(trace.directDetail.fillMs)}`
                                                    : '',
                                                formatDuration(trace.directDetail.toolMs)
                                                    ? `Tool ${formatDuration(trace.directDetail.toolMs)}`
                                                    : '',
                                                trace.directDetail.input ? `Input ${trace.directDetail.input}` : ''
                                            ]
                                                .filter(Boolean)
                                                .join(' · ')}
                                        </Typography>
                                    ) : null}
                                    <Typography variant='caption' color='text.secondary'>
                                        {handoffLine(trace, specialist)}
                                    </Typography>
                                </Stack>
                            </Collapse>
                        </Box>
                    )
                })}
                {trace.handoff?.status === 'done' ? (
                    <Typography variant='caption' color='text.secondary' sx={{ px: 1 }}>
                        {[
                            'Handoff',
                            trace.handoff.model,
                            formatDuration(trace.handoff.ms),
                            formatTokens(trace.handoff.tokens),
                            trace.handoff.fallback ? `Fell back to ${trace.handoff.fallback}` : ''
                        ]
                            .filter(Boolean)
                            .join(' · ')}
                    </Typography>
                ) : null}
                <Box sx={{ px: 1 }}>
                    <Box
                        component='button'
                        type='button'
                        aria-expanded={cutsOpen}
                        onClick={() => setCutsOpen((value) => !value)}
                        sx={{
                            border: 0,
                            background: 'transparent',
                            color: 'inherit',
                            cursor: 'pointer',
                            p: 0,
                            textAlign: 'left'
                        }}
                    >
                        <Typography variant='caption' color='text.secondary'>
                            {trace.truncated?.length
                                ? `Context cut in ${trace.truncated.length} place${trace.truncated.length === 1 ? '' : 's'}`
                                : 'Context kept'}
                        </Typography>
                    </Box>
                    <Collapse in={cutsOpen && Boolean(trace.truncated?.length)}>
                        <Stack spacing={0.25} sx={{ pt: 0.5 }}>
                            {(trace.truncated || []).map((item) => (
                                <Typography key={item.field} variant='caption' color='text.secondary'>
                                    {item.reason || item.field}
                                </Typography>
                            ))}
                        </Stack>
                    </Collapse>
                </Box>
                {trace.error ? (
                    <Typography variant='caption' color='error' sx={{ px: 1 }}>
                        {trace.error}
                    </Typography>
                ) : null}
            </Stack>
        </Box>
    )
}

HarnessRunTrace.propTypes = {
    trace: PropTypes.object,
    question: PropTypes.string
}

export default HarnessRunTrace
