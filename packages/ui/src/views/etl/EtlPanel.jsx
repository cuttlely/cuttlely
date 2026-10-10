import { useCallback, useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'

import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Alert,
    Box,
    Button,
    Chip,
    Divider,
    Drawer,
    FormControlLabel,
    IconButton,
    LinearProgress,
    MenuItem,
    Paper,
    Radio,
    RadioGroup,
    Stack,
    Switch,
    Tab,
    Tabs,
    TextField,
    Tooltip,
    Typography
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import {
    IconAlertCircle,
    IconClock,
    IconChevronDown,
    IconCircleCheck,
    IconCircleDashed,
    IconCopy,
    IconEye,
    IconLoader2,
    IconPlayerPause,
    IconPlayerPlay,
    IconPlayerStop,
    IconRotateClockwise,
    IconSearch,
    IconUpload,
    IconX
} from '@tabler/icons-react'

import etlApi from '@/api/etl'
import {
    ACTIVE,
    FINISHED_OK,
    STATUS_COLORS,
    errorText,
    formatBytes,
    formatDuration,
    formatNumber,
    runDuration,
    runProgress,
    timeAgo
} from './format'

const STEP_LABELS = {
    load: 'Load',
    transform: 'Clean & transform',
    split: 'Split',
    embed: 'Embed',
    store: 'Store',
    sweep: 'Delete removed'
}

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }

const StepIcon = ({ status }) => {
    const theme = useTheme()
    if (status === 'done') return <IconCircleCheck size={18} color={theme.palette.success.main} />
    if (status === 'failed') return <IconAlertCircle size={18} color={theme.palette.error.main} />
    if (status === 'running') return <IconLoader2 size={18} color={theme.palette.primary.main} className='spin' />
    return <IconCircleDashed size={18} color={theme.palette.text.disabled} />
}
StepIcon.propTypes = { status: PropTypes.string }

const Sample = ({ item, chunk }) => (
    <Paper variant='outlined' sx={{ p: 1.5, borderRadius: 1.5 }}>
        <Stack direction='row' sx={{ gap: 0.5, mb: 1 }} flexWrap='wrap' alignItems='center'>
            {chunk && <Chip size='small' color={item.indexed ? 'default' : 'primary'} label={item.indexed ? 'already indexed' : 'new'} />}
            <Chip size='small' variant='outlined' label={`${formatNumber(item.length)} chars`} />
            {Object.entries(item.metadata || {})
                .filter(([, value]) => value !== null && typeof value !== 'object')
                .slice(0, 6)
                .map(([key, value]) => (
                    <Chip key={key} size='small' variant='outlined' label={`${key}: ${String(value).slice(0, 48)}`} />
                ))}
        </Stack>
        <Box component='pre' sx={{ ...mono, m: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflow: 'auto' }}>
            {item.pageContent}
        </Box>
    </Paper>
)
Sample.propTypes = { item: PropTypes.object, chunk: PropTypes.bool }

const StepAccordion = ({ index, title, summary, children, defaultExpanded }) => (
    <Accordion
        disableGutters
        defaultExpanded={defaultExpanded}
        variant='outlined'
        sx={{ borderRadius: 1.5, '&:before': { display: 'none' } }}
    >
        <AccordionSummary expandIcon={<IconChevronDown size={18} />}>
            <Stack direction='row' alignItems='center' sx={{ gap: 1.5, width: '100%' }}>
                <Chip size='small' color='primary' label={index} sx={{ minWidth: 28 }} />
                <Box sx={{ minWidth: 0 }}>
                    <Typography variant='subtitle1'>{title}</Typography>
                    <Typography variant='caption' color='text.secondary'>
                        {summary}
                    </Typography>
                </Box>
            </Stack>
        </AccordionSummary>
        <AccordionDetails>
            <Stack sx={{ gap: 1 }}>{children}</Stack>
        </AccordionDetails>
    </Accordion>
)
StepAccordion.propTypes = {
    index: PropTypes.number,
    title: PropTypes.string,
    summary: PropTypes.node,
    children: PropTypes.node,
    defaultExpanded: PropTypes.bool
}

const Metric = ({ label, value, hint }) => (
    <Paper variant='outlined' sx={{ p: 1.25, borderRadius: 1.5, minWidth: 0 }}>
        <Typography variant='caption' color='text.secondary'>
            {label}
        </Typography>
        <Typography variant='h4' sx={{ mt: 0.25 }}>
            {value}
        </Typography>
        {hint && (
            <Typography variant='caption' color='text.secondary'>
                {hint}
            </Typography>
        )}
    </Paper>
)
Metric.propTypes = { label: PropTypes.string, value: PropTypes.node, hint: PropTypes.node }

function stepDetail(name, run) {
    const c = run.counters || {}
    if (name === 'load') {
        const units = c.unitsTotal
            ? `${formatNumber(c.unitsDone)} of ${formatNumber(c.unitsTotal)} sources`
            : `${formatNumber(c.unitsDone)} sources`
        return `${formatNumber(c.docsLoaded)} documents · ${units}${c.unitsSkipped ? ` · ${formatNumber(c.unitsSkipped)} unchanged` : ''}`
    }
    if (name === 'transform') return `${formatNumber(c.docsLoaded - c.docsDropped)} kept · ${formatNumber(c.docsDropped)} dropped`
    if (name === 'split') return `${formatNumber(c.chunks)} chunks`
    if (name === 'embed')
        return `${formatNumber(c.embedded)} embedded · ${formatNumber(c.skipped)} unchanged${
            c.retries ? ` · ${formatNumber(c.retries)} retries` : ''
        }`
    if (name === 'store') return `${formatNumber(c.embedded)} written${c.storeMs ? ` · ${formatDuration(c.storeMs / 1000)} writing` : ''}`
    return `${formatNumber(c.deleted)} deleted`
}

const PreviewTab = ({ chatflowId, getFlowData }) => {
    const [preview, setPreview] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [limit, setLimit] = useState(5)
    const [embed, setEmbed] = useState(false)
    const [upload, setUpload] = useState(null)
    const fileRef = useRef(null)

    const run = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
            const response = await etlApi.previewPipeline(chatflowId || 'draft', { flowData: getFlowData(), limit, embed })
            setPreview(response.data)
        } catch (err) {
            setError(errorText(err))
        } finally {
            setLoading(false)
        }
    }, [chatflowId, getFlowData, limit, embed])

    useEffect(() => {
        run()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const onFile = async (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        if (!chatflowId) {
            setUpload({ name: file.name, error: 'Save the pipeline before uploading a file.' })
            return
        }
        setUpload({ name: file.name, progress: 0 })
        try {
            const response = await etlApi.upload(chatflowId, file, (e) =>
                setUpload({ name: file.name, progress: e.total ? Math.round((100 * e.loaded) / e.total) : 0 })
            )
            setUpload({ name: file.name, progress: 100, path: response.data.path, size: response.data.size })
        } catch (err) {
            setUpload({ name: file.name, error: errorText(err) })
        }
    }

    const steps = preview?.steps
    return (
        <Stack sx={{ gap: 2 }}>
            <Stack direction='row' alignItems='center' sx={{ gap: 1 }} flexWrap='wrap'>
                <TextField
                    select
                    size='small'
                    label='Documents per source'
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value))}
                    sx={{ width: 180 }}
                >
                    {[3, 5, 10, 25].map((n) => (
                        <MenuItem key={n} value={n}>
                            {n}
                        </MenuItem>
                    ))}
                </TextField>
                <Tooltip title='Local Hash Embeddings always run. Turn this on to also call a provider model (billed to your credential).'>
                    <FormControlLabel
                        control={<Switch checked={embed} onChange={(e) => setEmbed(e.target.checked)} />}
                        label='Call embeddings'
                    />
                </Tooltip>
                <Button variant='contained' onClick={run} disabled={loading} startIcon={<IconEye size={18} />}>
                    {loading ? 'Previewing' : 'Refresh preview'}
                </Button>
            </Stack>
            {loading && <LinearProgress />}
            {error && <Alert severity='error'>{error}</Alert>}
            {preview?.problems?.map((problem) => (
                <Alert key={problem} severity='error'>
                    {problem}
                </Alert>
            ))}
            {preview?.warnings?.map((warning) => (
                <Alert key={warning} severity='warning'>
                    {warning}
                </Alert>
            ))}
            {steps && (
                <Stack sx={{ gap: 1 }}>
                    <StepAccordion
                        index={1}
                        title='Load'
                        defaultExpanded
                        summary={
                            <>
                                {formatNumber(steps.load.count)} documents from{' '}
                                {preview.sources
                                    .map(
                                        (source) =>
                                            `${source.label}${
                                                source.units !== undefined
                                                    ? ` (${formatNumber(source.units)} files, ${formatBytes(source.bytes)})`
                                                    : ''
                                            }`
                                    )
                                    .join(', ')}
                            </>
                        }
                    >
                        {steps.load.samples.map((item, i) => (
                            <Sample key={i} item={item} />
                        ))}
                        {steps.load.samples.length === 0 && (
                            <Typography color='text.secondary'>No documents came out of the sources.</Typography>
                        )}
                    </StepAccordion>
                    <StepAccordion
                        index={2}
                        title='Clean & transform'
                        summary={`${formatNumber(steps.transform.count)} kept · ${formatNumber(steps.transform.dropped)} dropped`}
                    >
                        {steps.transform.samples.map((item, i) => (
                            <Sample key={i} item={item} />
                        ))}
                    </StepAccordion>
                    <StepAccordion
                        index={3}
                        title='Split'
                        defaultExpanded
                        summary={
                            steps.split.stats
                                ? `${formatNumber(steps.split.count)} chunks · avg ${formatNumber(
                                      steps.split.stats.avg
                                  )} chars (min ${formatNumber(steps.split.stats.min)}, max ${formatNumber(steps.split.stats.max)})`
                                : `${formatNumber(steps.split.count)} chunks`
                        }
                    >
                        {steps.split.samples.map((item) => (
                            <Sample key={item.id} item={item} chunk />
                        ))}
                    </StepAccordion>
                    <StepAccordion
                        index={4}
                        title='Embed'
                        summary={
                            steps.embed.status === 'done'
                                ? `${steps.embed.model} · ${steps.embed.dimensions} dimensions · ${steps.embed.ms} ms for ${steps.embed.samples.length} chunks`
                                : steps.embed.status === 'failed'
                                ? `${steps.embed.model}: ${steps.embed.error}`
                                : steps.embed.reason || 'Connect an embeddings node.'
                        }
                    >
                        {steps.embed.samples?.map((sample) => (
                            <Box key={sample.id} sx={mono}>
                                [{sample.head.join(', ')}, …] norm {sample.norm}
                            </Box>
                        ))}
                        {steps.embed.status !== 'done' && (
                            <Typography color='text.secondary'>{steps.embed.reason || steps.embed.error || 'Not run.'}</Typography>
                        )}
                    </StepAccordion>
                    <StepAccordion index={5} title='Store' summary='Written by a run. Preview never writes.'>
                        <Typography color='text.secondary'>
                            Chunks marked “already indexed” are skipped on the next incremental run. New and changed chunks are embedded and
                            written; chunks that no longer come out of the sources are deleted after the run completes.
                        </Typography>
                    </StepAccordion>
                </Stack>
            )}
            <Divider />
            <Stack sx={{ gap: 1 }}>
                <Typography variant='subtitle1'>Upload a file to the server</Typography>
                <Typography variant='caption' color='text.secondary'>
                    Large files stream to disk without passing through memory. Paste the path into Streaming Files.
                </Typography>
                <input ref={fileRef} type='file' hidden onChange={onFile} />
                <Box>
                    <Button variant='outlined' startIcon={<IconUpload size={18} />} onClick={() => fileRef.current?.click()}>
                        Choose file
                    </Button>
                </Box>
                {upload && (
                    <Paper variant='outlined' sx={{ p: 1.5, borderRadius: 1.5 }}>
                        <Typography variant='body2'>{upload.name}</Typography>
                        {upload.error ? (
                            <Typography color='error' variant='caption'>
                                {upload.error}
                            </Typography>
                        ) : upload.path ? (
                            <Stack direction='row' alignItems='center' sx={{ gap: 1 }}>
                                <Box sx={{ ...mono, wordBreak: 'break-all' }}>{upload.path}</Box>
                                <IconButton size='small' title='Copy path' onClick={() => navigator.clipboard?.writeText(upload.path)}>
                                    <IconCopy size={16} />
                                </IconButton>
                            </Stack>
                        ) : (
                            <LinearProgress variant='determinate' value={upload.progress} />
                        )}
                    </Paper>
                )}
            </Stack>
        </Stack>
    )
}
PreviewTab.propTypes = { chatflowId: PropTypes.string, getFlowData: PropTypes.func }

const RunTab = ({ chatflowId, isDirty, detail, runId, onRunChange, onFinished, starters = [] }) => {
    const [run, setRun] = useState(null)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [settings, setSettings] = useState({ mode: 'incremental', batchSize: 64, concurrency: 4, maxRetries: 6 })
    const [query, setQuery] = useState('')
    const [results, setResults] = useState(null)
    const timer = useRef(null)

    const poll = useCallback(
        async (id) => {
            clearTimeout(timer.current)
            if (!id) return
            try {
                const response = await etlApi.getRun(id)
                setRun(response.data)
                if (ACTIVE.has(response.data.status)) timer.current = setTimeout(() => poll(id), 1000)
                else onFinished?.()
            } catch (err) {
                setError(errorText(err))
            }
        },
        [onFinished]
    )

    useEffect(() => {
        poll(runId)
        return () => clearTimeout(timer.current)
    }, [runId, poll])

    const start = async () => {
        setBusy(true)
        setError('')
        try {
            const response = await etlApi.startRun(chatflowId, {
                mode: settings.mode,
                settings: { batchSize: settings.batchSize, concurrency: settings.concurrency, maxRetries: settings.maxRetries }
            })
            onRunChange(response.data.id)
        } catch (err) {
            setError(errorText(err))
        } finally {
            setBusy(false)
        }
    }

    const control = async (action) => {
        setBusy(true)
        setError('')
        try {
            const fn = { pause: etlApi.pauseRun, resume: etlApi.resumeRun, cancel: etlApi.cancelRun }[action]
            const response = await fn(run.id)
            setRun((current) => ({ ...current, ...response.data }))
            poll(run.id)
        } catch (err) {
            setError(errorText(err))
        } finally {
            setBusy(false)
        }
    }

    const searchNow = async (text = query) => {
        setError('')
        try {
            const response = await etlApi.search(chatflowId, { query: text, k: 4 })
            setResults(response.data)
        } catch (err) {
            setResults(null)
            setError(errorText(err))
        }
    }

    const canStart = Boolean(chatflowId) && !isDirty && !(detail?.problems?.length > 0) && !(run && ACTIVE.has(run.status))
    const progress = run ? runProgress(run) : null
    const live = run?.counters?.live || {}
    const c = run?.counters || {}

    return (
        <Stack sx={{ gap: 2 }}>
            {!chatflowId && <Alert severity='info'>Save the pipeline to create its first version, then run it.</Alert>}
            {chatflowId && isDirty && (
                <Alert severity='info'>Save your changes first. Each save that changes the pipeline creates a new version.</Alert>
            )}
            {detail?.problems?.map((problem) => (
                <Alert key={problem} severity='error'>
                    {problem}
                </Alert>
            ))}
            {error && (
                <Alert severity='error' onClose={() => setError('')}>
                    {error}
                </Alert>
            )}
            <Accordion disableGutters variant='outlined' defaultExpanded={!run} sx={{ borderRadius: 1.5, '&:before': { display: 'none' } }}>
                <AccordionSummary expandIcon={<IconChevronDown size={18} />}>
                    <Typography variant='subtitle1'>New run</Typography>
                </AccordionSummary>
                <AccordionDetails>
                    <Stack sx={{ gap: 1.5 }}>
                        <RadioGroup row value={settings.mode} onChange={(e) => setSettings({ ...settings, mode: e.target.value })}>
                            <FormControlLabel value='incremental' control={<Radio />} label='Incremental' />
                            <FormControlLabel value='full' control={<Radio />} label='Full rebuild' />
                        </RadioGroup>
                        <Typography variant='caption' color='text.secondary'>
                            {settings.mode === 'incremental'
                                ? 'Skips unchanged sources and chunks, embeds what changed, and deletes what disappeared.'
                                : 'Re-embeds every chunk, then deletes what disappeared. Use after changing the embeddings provider settings.'}
                        </Typography>
                        <Stack direction='row' sx={{ gap: 1 }} flexWrap='wrap'>
                            {[
                                ['batchSize', 'Batch size'],
                                ['concurrency', 'Parallel batches'],
                                ['maxRetries', 'Retries per batch']
                            ].map(([key, label]) => (
                                <TextField
                                    key={key}
                                    size='small'
                                    type='number'
                                    label={label}
                                    value={settings[key]}
                                    onChange={(e) => setSettings({ ...settings, [key]: Number(e.target.value) })}
                                    sx={{ width: 140 }}
                                />
                            ))}
                        </Stack>
                        <Box>
                            <Button
                                variant='contained'
                                color='success'
                                startIcon={<IconPlayerPlay size={18} />}
                                disabled={!canStart || busy}
                                onClick={start}
                            >
                                Start run
                            </Button>
                        </Box>
                    </Stack>
                </AccordionDetails>
            </Accordion>
            {run && (
                <Paper variant='outlined' sx={{ p: 2, borderRadius: 2 }}>
                    <Stack sx={{ gap: 1.5 }}>
                        <Stack direction='row' alignItems='center' justifyContent='space-between' flexWrap='wrap' sx={{ gap: 1 }}>
                            <Box>
                                <Typography variant='h4'>Run {run.id.slice(0, 8)}</Typography>
                                <Typography variant='caption' color='text.secondary'>
                                    v{run.version} · {run.mode} · attempt {run.attempt} · started {timeAgo(run.startedAt || run.createdAt)}
                                </Typography>
                            </Box>
                            <Chip label={run.status} color={STATUS_COLORS[run.status] || 'default'} />
                        </Stack>
                        <Box>
                            <LinearProgress
                                variant={progress === null && ACTIVE.has(run.status) ? 'indeterminate' : 'determinate'}
                                value={progress ?? 0}
                                sx={{ height: 8, borderRadius: 4 }}
                            />
                            <Stack direction='row' justifyContent='space-between' sx={{ mt: 0.5 }}>
                                <Typography variant='caption' color='text.secondary'>
                                    {c.bytesTotal
                                        ? `${formatBytes(c.bytesRead)} of ${formatBytes(c.bytesTotal)}`
                                        : `${formatNumber(c.unitsDone)} sources done`}
                                </Typography>
                                <Typography variant='caption' color='text.secondary'>
                                    {progress !== null ? `${progress.toFixed(1)}%` : ''}
                                </Typography>
                            </Stack>
                        </Box>
                        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 1 }}>
                            <Metric label='Embedded' value={formatNumber(c.embedded)} />
                            <Metric
                                label='Unchanged'
                                value={formatNumber(c.skipped)}
                                hint={c.unitsSkipped ? `${formatNumber(c.unitsSkipped)} sources skipped` : null}
                            />
                            <Metric label='Deleted' value={formatNumber(c.deleted)} />
                            <Metric
                                label='Rejected'
                                value={formatNumber(c.rejected || 0)}
                                hint={c.filtered ? `${formatNumber(c.filtered)} filtered` : null}
                            />
                            <Metric
                                label='Errors'
                                value={formatNumber(c.errors)}
                                hint={c.retries ? `${formatNumber(c.retries)} retries` : null}
                            />
                        </Box>
                        <Stack direction='row' sx={{ gap: 2 }} flexWrap='wrap'>
                            <Typography variant='body2'>
                                <strong>{formatNumber(live.chunksPerSecond || 0)}</strong> chunks/s
                            </Typography>
                            <Typography variant='body2'>
                                <strong>{formatBytes(live.bytesPerSecond || 0)}</strong>/s
                            </Typography>
                            <Typography variant='body2'>
                                ETA <strong>{ACTIVE.has(run.status) ? formatDuration(live.etaSeconds) : '–'}</strong>
                            </Typography>
                            <Typography variant='body2'>
                                Elapsed <strong>{formatDuration(runDuration(run))}</strong>
                            </Typography>
                        </Stack>
                        <Stack divider={<Divider flexItem />}>
                            {Object.keys(STEP_LABELS).map((name) => (
                                <Stack key={name} direction='row' alignItems='center' sx={{ gap: 1.5, py: 0.75 }}>
                                    <StepIcon status={FINISHED_OK.has(run.status) ? 'done' : run.steps?.[name]?.status} />
                                    <Typography variant='subtitle2' sx={{ width: 130, flexShrink: 0 }}>
                                        {STEP_LABELS[name]}
                                    </Typography>
                                    <Typography variant='body2' color='text.secondary'>
                                        {stepDetail(name, run)}
                                    </Typography>
                                </Stack>
                            ))}
                        </Stack>
                        {run.error && <Alert severity='error'>{run.error}</Alert>}
                        <Stack direction='row' sx={{ gap: 1 }} flexWrap='wrap'>
                            {run.status === 'running' && (
                                <Button
                                    variant='outlined'
                                    startIcon={<IconPlayerPause size={18} />}
                                    disabled={busy}
                                    onClick={() => control('pause')}
                                >
                                    Pause
                                </Button>
                            )}
                            {run.status === 'paused' && (
                                <Button
                                    variant='contained'
                                    startIcon={<IconPlayerPlay size={18} />}
                                    disabled={busy}
                                    onClick={() => control('resume')}
                                >
                                    Resume
                                </Button>
                            )}
                            {run.status === 'failed' && (
                                <Button
                                    variant='contained'
                                    startIcon={<IconRotateClockwise size={18} />}
                                    disabled={busy}
                                    onClick={() => control('resume')}
                                >
                                    Retry from checkpoint
                                </Button>
                            )}
                            {['queued', 'running', 'paused', 'failed', 'pausing'].includes(run.status) && (
                                <Button
                                    variant='outlined'
                                    color='error'
                                    startIcon={<IconPlayerStop size={18} />}
                                    disabled={busy}
                                    onClick={() => control('cancel')}
                                >
                                    Cancel
                                </Button>
                            )}
                        </Stack>
                        {run.events?.length > 0 && (
                            <Box sx={{ ...mono, maxHeight: 180, overflow: 'auto', bgcolor: 'action.hover', borderRadius: 1, p: 1 }}>
                                {run.events.slice(-60).map((event) => (
                                    <Box
                                        key={event.id}
                                        sx={{
                                            color:
                                                event.level === 'error'
                                                    ? 'error.main'
                                                    : event.level === 'warn'
                                                    ? 'warning.main'
                                                    : 'text.primary'
                                        }}
                                    >
                                        {new Date(event.ts).toLocaleTimeString()} {event.step ? `[${event.step}] ` : ''}
                                        {event.message}
                                    </Box>
                                ))}
                            </Box>
                        )}
                    </Stack>
                </Paper>
            )}
            {detail?.servedVersion && (
                <Paper variant='outlined' sx={{ p: 2, borderRadius: 2 }}>
                    <Stack sx={{ gap: 1 }}>
                        <Typography variant='subtitle1'>Try retrieval</Typography>
                        <Typography variant='caption' color='text.secondary'>
                            Searches version {detail.servedVersion}, the same way the ETL Retriever does in a chat flow or harness.
                        </Typography>
                        <Stack direction='row' sx={{ gap: 1 }}>
                            <TextField
                                size='small'
                                fullWidth
                                placeholder='Ask something the data should answer'
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && query.trim() && searchNow()}
                            />
                            <Button
                                variant='contained'
                                disabled={!query.trim()}
                                onClick={() => searchNow()}
                                startIcon={<IconSearch size={18} />}
                            >
                                Search
                            </Button>
                        </Stack>
                        {starters.length > 0 && (
                            <Stack direction='row' sx={{ gap: 1 }} flexWrap='wrap' data-testid='etl-starter-searches'>
                                {starters.map((starter) => (
                                    <Chip
                                        key={starter}
                                        size='small'
                                        variant='outlined'
                                        label={starter}
                                        onClick={() => {
                                            setQuery(starter)
                                            searchNow(starter)
                                        }}
                                    />
                                ))}
                            </Stack>
                        )}
                        {results?.results?.map((hit, i) => (
                            <Paper key={hit.id || i} variant='outlined' sx={{ p: 1.5, borderRadius: 1.5 }}>
                                <Stack direction='row' sx={{ gap: 0.5, mb: 0.5 }} flexWrap='wrap'>
                                    <Chip size='small' color='primary' label={`score ${hit.score.toFixed(3)}`} />
                                    {hit.metadata?.source && (
                                        <Chip
                                            size='small'
                                            variant='outlined'
                                            label={String(hit.metadata.source).split('/').slice(-2).join('/')}
                                        />
                                    )}
                                </Stack>
                                <Box component='pre' sx={{ ...mono, m: 0, whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' }}>
                                    {hit.pageContent}
                                </Box>
                            </Paper>
                        ))}
                        {results && results.results.length === 0 && <Typography color='text.secondary'>No matches.</Typography>}
                    </Stack>
                </Paper>
            )}
        </Stack>
    )
}
RunTab.propTypes = {
    chatflowId: PropTypes.string,
    isDirty: PropTypes.bool,
    detail: PropTypes.object,
    runId: PropTypes.string,
    onRunChange: PropTypes.func,
    onFinished: PropTypes.func,
    starters: PropTypes.array
}

const HistoryTab = ({ detail, onSelect }) => {
    if (!detail?.runs?.length) return <Typography color='text.secondary'>No runs yet. Start one from the Run tab.</Typography>
    return (
        <Stack sx={{ gap: 1 }}>
            {detail.runs.map((run) => (
                <Paper
                    key={run.id}
                    variant='outlined'
                    onClick={() => onSelect(run.id)}
                    sx={{ p: 1.5, borderRadius: 1.5, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
                >
                    <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ gap: 1 }}>
                        <Box>
                            <Typography variant='subtitle2'>
                                {run.id.slice(0, 8)} · v{run.version} · {run.mode}
                            </Typography>
                            <Typography variant='caption' color='text.secondary'>
                                {new Date(run.createdAt).toLocaleString()} · {formatDuration(runDuration(run))} ·{' '}
                                {formatNumber(run.counters.embedded)} embedded · {formatNumber(run.counters.skipped)} unchanged ·{' '}
                                {formatNumber(run.counters.deleted)} deleted
                            </Typography>
                        </Box>
                        <Chip size='small' label={run.status} color={STATUS_COLORS[run.status] || 'default'} />
                    </Stack>
                </Paper>
            ))}
        </Stack>
    )
}
HistoryTab.propTypes = { detail: PropTypes.object, onSelect: PropTypes.func }

const VersionsTab = ({ chatflowId, detail, onRestore }) => {
    const [error, setError] = useState('')
    if (!detail?.versions?.length) return <Typography color='text.secondary'>Save the pipeline to create version 1.</Typography>
    const restore = async (version) => {
        try {
            const response = await etlApi.getVersion(chatflowId, version)
            onRestore(response.data.flowData, version)
        } catch (err) {
            setError(errorText(err))
        }
    }
    return (
        <Stack sx={{ gap: 1 }}>
            {error && <Alert severity='error'>{error}</Alert>}
            <Typography variant='caption' color='text.secondary'>
                Each save that changes nodes, inputs, credentials or connections creates a version. Moving nodes does not. Runs pin the
                version they started on, and the ETL Retriever serves the version of the last succeeded or partial run.
            </Typography>
            {detail.versions.map((version) => (
                <Paper key={version.version} variant='outlined' sx={{ p: 1.5, borderRadius: 1.5 }}>
                    <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ gap: 1 }}>
                        <Box>
                            <Stack direction='row' sx={{ gap: 0.5 }} alignItems='center'>
                                <Typography variant='subtitle2'>Version {version.version}</Typography>
                                {version.version === detail.latestVersion && <Chip size='small' label='latest' />}
                                {version.version === detail.servedVersion && <Chip size='small' color='success' label='serving' />}
                                {version.problems?.problems?.length > 0 && (
                                    <Chip size='small' color='error' variant='outlined' label='incomplete' />
                                )}
                            </Stack>
                            <Typography variant='caption' color='text.secondary'>
                                {new Date(version.createdAt).toLocaleString()} ·{' '}
                                {(version.spec?.sources || []).map((source) => source.label).join(', ') || 'no sources'} →{' '}
                                {version.spec?.store?.label || 'no store'}
                            </Typography>
                        </Box>
                        {version.version !== detail.latestVersion && (
                            <Button size='small' variant='outlined' onClick={() => restore(version.version)}>
                                Restore
                            </Button>
                        )}
                    </Stack>
                </Paper>
            ))}
        </Stack>
    )
}
VersionsTab.propTypes = { chatflowId: PropTypes.string, detail: PropTypes.object, onRestore: PropTypes.func }

const emptySchedule = { kind: 'interval', every: 15, unit: 'minutes', cron: '0 * * * *', mode: 'incremental' }

const SchedulesTab = ({ chatflowId }) => {
    const [schedules, setSchedules] = useState(null)
    const [form, setForm] = useState(emptySchedule)
    const [editing, setEditing] = useState(null)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    const load = useCallback(async () => {
        if (!chatflowId) return
        try {
            const response = await etlApi.listSchedules(chatflowId)
            setSchedules(response.data)
            setError('')
        } catch (err) {
            setError(errorText(err))
            setSchedules((current) => current || [])
        }
    }, [chatflowId])

    useEffect(() => {
        load()
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
    }, [load])

    const save = async () => {
        setBusy(true)
        setError('')
        try {
            if (editing) await etlApi.updateSchedule(editing, form)
            else await etlApi.createSchedule(chatflowId, form)
            setEditing(null)
            setForm(emptySchedule)
            await load()
        } catch (err) {
            setError(errorText(err))
        } finally {
            setBusy(false)
        }
    }

    const act = async (fn) => {
        setError('')
        try {
            await fn()
            await load()
        } catch (err) {
            setError(errorText(err))
        }
    }

    return (
        <Stack sx={{ gap: 1.5 }}>
            <Typography variant='caption' color='text.secondary'>
                Incremental is the default. A tick that finds a run still going is skipped, and the reason is kept on the schedule.
                Schedules live in this server process and fire again after a restart.
            </Typography>
            {error && <Alert severity='error'>{error}</Alert>}
            <Paper variant='outlined' sx={{ p: 1.5, borderRadius: 1.5 }}>
                <Stack sx={{ gap: 1.25 }}>
                    <Typography variant='subtitle2'>{editing ? 'Edit schedule' : 'New schedule'}</Typography>
                    <TextField
                        select
                        size='small'
                        label='Kind'
                        value={form.kind}
                        onChange={(event) => setForm({ ...form, kind: event.target.value })}
                    >
                        <MenuItem value='interval'>Interval</MenuItem>
                        <MenuItem value='cron'>Cron</MenuItem>
                    </TextField>
                    {form.kind === 'interval' ? (
                        <Stack direction='row' sx={{ gap: 1 }}>
                            <TextField
                                size='small'
                                type='number'
                                label='Every'
                                value={form.every}
                                onChange={(event) => setForm({ ...form, every: Number(event.target.value) })}
                                sx={{ width: 120 }}
                            />
                            <TextField
                                select
                                size='small'
                                label='Unit'
                                value={form.unit}
                                onChange={(event) => setForm({ ...form, unit: event.target.value })}
                                sx={{ flex: 1 }}
                            >
                                <MenuItem value='minutes'>minutes</MenuItem>
                                <MenuItem value='hours'>hours</MenuItem>
                            </TextField>
                        </Stack>
                    ) : (
                        <TextField
                            size='small'
                            label='Cron'
                            value={form.cron}
                            helperText='minute hour day month weekday, UTC. Example: 0 2 * * *'
                            onChange={(event) => setForm({ ...form, cron: event.target.value })}
                        />
                    )}
                    <TextField
                        select
                        size='small'
                        label='Run'
                        value={form.mode}
                        onChange={(event) => setForm({ ...form, mode: event.target.value })}
                    >
                        <MenuItem value='incremental'>Incremental</MenuItem>
                        <MenuItem value='full'>Full rebuild</MenuItem>
                    </TextField>
                    <Stack direction='row' sx={{ gap: 1 }}>
                        <Button variant='contained' disabled={busy} onClick={save}>
                            {editing ? 'Save' : 'Add schedule'}
                        </Button>
                        {editing && (
                            <Button
                                onClick={() => {
                                    setEditing(null)
                                    setForm(emptySchedule)
                                }}
                            >
                                Cancel
                            </Button>
                        )}
                    </Stack>
                </Stack>
            </Paper>
            {schedules === null && <Typography color='text.secondary'>Loading schedules.</Typography>}
            {schedules?.length === 0 && <Typography color='text.secondary'>No schedule yet.</Typography>}
            {schedules?.map((schedule) => (
                <Paper key={schedule.id} variant='outlined' sx={{ p: 1.5, borderRadius: 1.5 }}>
                    <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ gap: 1 }}>
                        <Typography variant='subtitle2'>{schedule.label}</Typography>
                        <Stack direction='row' sx={{ gap: 0.5 }}>
                            <Chip size='small' variant='outlined' label={schedule.mode} />
                            <Chip size='small' label={schedule.status} color={schedule.status === 'active' ? 'success' : 'warning'} />
                        </Stack>
                    </Stack>
                    <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 0.5 }}>
                        Next run {schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : '–'}
                    </Typography>
                    <Typography variant='caption' color='text.secondary' sx={{ display: 'block' }}>
                        Last run {schedule.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString() : 'never'}
                        {schedule.lastRunId ? ` · ${schedule.lastRunId.slice(0, 8)}` : ''}
                    </Typography>
                    <Typography variant='caption' color='text.secondary' sx={{ display: 'block' }}>
                        Last result {schedule.lastResult || '–'}
                        {schedule.lastReason ? ` · ${schedule.lastReason}` : ''}
                    </Typography>
                    <Stack direction='row' sx={{ gap: 1, mt: 1 }} flexWrap='wrap'>
                        <Button
                            size='small'
                            variant='outlined'
                            onClick={() => {
                                setEditing(schedule.id)
                                setForm({
                                    kind: schedule.kind,
                                    every: schedule.every || 15,
                                    unit: schedule.unit || 'minutes',
                                    cron: schedule.cron || '0 * * * *',
                                    mode: schedule.mode
                                })
                            }}
                        >
                            Edit
                        </Button>
                        {schedule.status === 'active' ? (
                            <Button size='small' variant='outlined' onClick={() => act(() => etlApi.pauseSchedule(schedule.id))}>
                                Pause
                            </Button>
                        ) : (
                            <Button size='small' variant='outlined' onClick={() => act(() => etlApi.resumeSchedule(schedule.id))}>
                                Resume
                            </Button>
                        )}
                        <Button size='small' color='error' onClick={() => act(() => etlApi.deleteSchedule(schedule.id))}>
                            Delete
                        </Button>
                    </Stack>
                </Paper>
            ))}
        </Stack>
    )
}
SchedulesTab.propTypes = { chatflowId: PropTypes.string }

const EtlPanel = ({ chatflowId, getFlowData, isDirty, onRestore, savedAt, starters }) => {
    const [open, setOpen] = useState(false)
    const [tab, setTab] = useState('preview')
    const [detail, setDetail] = useState(null)
    const [runId, setRunId] = useState(null)
    const [previewKey, setPreviewKey] = useState(0)

    const loadDetail = useCallback(async () => {
        if (!chatflowId) return setDetail(null)
        try {
            const response = await etlApi.getPipeline(chatflowId)
            setDetail(response.data)
            setRunId((current) => current || response.data.runs?.[0]?.id || null)
        } catch {
            setDetail(null)
        }
    }, [chatflowId])

    useEffect(() => {
        loadDetail()
    }, [loadDetail, savedAt])

    const openTab = (name) => {
        if (open && tab === name) {
            setOpen(false)
            return
        }
        setOpen(true)
        setTab(name)
        if (name === 'preview') setPreviewKey((n) => n + 1)
    }

    useEffect(() => {
        if (!open) return
        const onKey = (event) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return
            if (document.querySelector('.MuiDialog-root, .MuiMenu-root, .MuiPopover-root')) return
            setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open])

    return (
        <>
            <Stack
                direction='row'
                sx={{ position: 'absolute', top: 20, right: open ? { xs: 20, sm: 540 } : 20, zIndex: 5, gap: 1, transition: 'right .2s' }}
            >
                <Button variant='contained' startIcon={<IconEye size={18} />} onClick={() => openTab('preview')} sx={{ borderRadius: 2 }}>
                    Preview
                </Button>
                <Button
                    variant='contained'
                    color='success'
                    startIcon={<IconPlayerPlay size={18} />}
                    onClick={() => openTab('run')}
                    sx={{ borderRadius: 2 }}
                >
                    Run
                </Button>
                <Button
                    variant='outlined'
                    startIcon={<IconClock size={18} />}
                    onClick={() => openTab('schedules')}
                    sx={{ borderRadius: 2 }}
                >
                    Schedule
                </Button>
            </Stack>
            <Drawer
                anchor='right'
                variant='persistent'
                open={open}
                PaperProps={{
                    sx: {
                        top: 70,
                        height: 'calc(100% - 70px)',
                        width: { xs: '100%', sm: 520 },
                        p: 2,
                        boxSizing: 'border-box',
                        overflow: 'hidden',
                        display: 'flex',
                        flexDirection: 'column'
                    }
                }}
            >
                <Stack direction='row' alignItems='flex-start' justifyContent='space-between' sx={{ mb: 1, flexShrink: 0, gap: 1 }}>
                    <Box sx={{ minWidth: 0 }}>
                        <Typography variant='h4'>Pipeline</Typography>
                        <Typography variant='caption' color='text.secondary' sx={{ display: 'block' }}>
                            {detail
                                ? `v${detail.latestVersion ?? '–'}${
                                      detail.servedVersion ? ` · serving v${detail.servedVersion}` : ''
                                  } · ${formatNumber(detail.stats?.chunks)} chunks indexed`
                                : 'Not saved yet'}
                        </Typography>
                    </Box>
                    <Button
                        size='small'
                        color='inherit'
                        onClick={() => setOpen(false)}
                        startIcon={<IconX size={16} />}
                        aria-label='Close'
                        sx={{ flexShrink: 0 }}
                    >
                        Close
                    </Button>
                </Stack>
                <Tabs
                    value={tab}
                    onChange={(_, value) => setTab(value)}
                    variant='scrollable'
                    scrollButtons='auto'
                    sx={{ mb: 2, minHeight: 40, flexShrink: 0 }}
                >
                    <Tab value='preview' label='Preview' sx={{ minHeight: 40 }} />
                    <Tab value='run' label='Run' sx={{ minHeight: 40 }} />
                    <Tab value='schedules' label='Schedules' sx={{ minHeight: 40 }} />
                    <Tab value='history' label='History' sx={{ minHeight: 40 }} />
                    <Tab value='versions' label='Versions' sx={{ minHeight: 40 }} />
                </Tabs>
                <Box sx={{ overflow: 'auto', flex: '1 1 auto', minHeight: 0, pb: 4 }}>
                    {tab === 'preview' && <PreviewTab key={previewKey} chatflowId={chatflowId} getFlowData={getFlowData} />}
                    {tab === 'run' && (
                        <RunTab
                            chatflowId={chatflowId}
                            isDirty={isDirty}
                            detail={detail}
                            runId={runId}
                            onRunChange={setRunId}
                            onFinished={loadDetail}
                            starters={starters}
                        />
                    )}
                    {tab === 'schedules' && <SchedulesTab chatflowId={chatflowId} />}
                    {tab === 'history' && (
                        <HistoryTab
                            detail={detail}
                            onSelect={(id) => {
                                setRunId(id)
                                setTab('run')
                            }}
                        />
                    )}
                    {tab === 'versions' && <VersionsTab chatflowId={chatflowId} detail={detail} onRestore={onRestore} />}
                </Box>
            </Drawer>
        </>
    )
}

EtlPanel.propTypes = {
    chatflowId: PropTypes.string,
    getFlowData: PropTypes.func,
    isDirty: PropTypes.bool,
    onRestore: PropTypes.func,
    savedAt: PropTypes.any,
    starters: PropTypes.array
}

export default EtlPanel
