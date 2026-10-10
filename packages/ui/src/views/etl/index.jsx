import { useCallback, useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { useNavigate } from 'react-router-dom'

import {
    Alert,
    Box,
    Button,
    Chip,
    LinearProgress,
    Menu,
    MenuItem,
    OutlinedInput,
    Paper,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Typography,
    useMediaQuery
} from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { IconDatabaseImport, IconFileImport, IconPlus, IconSearch } from '@tabler/icons-react'

import etlApi from '@/api/etl'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import MainCard from '@/ui-component/cards/MainCard'
import { StyledPermissionButton } from '@/ui-component/button/RBACButtons'
import WhichFlow from '@/ui-component/flow/WhichFlow'
import { ACTIVE, STATUS_COLORS, errorText, formatNumber, runProgress, timeAgo } from './format'

const subtitleColor = (theme) => alpha(theme.palette.text.primary, theme.palette.mode === 'dark' ? 0.62 : 0.68)

const PipelineActions = ({ samples, importing, onImportClick, onNew }) => {
    const theme = useTheme()
    return (
        <Stack direction='row' alignItems='center' sx={{ gap: 1, flexShrink: 0, flexWrap: { xs: 'wrap', sm: 'nowrap' } }}>
            {samples.length > 0 && (
                <Button
                    variant='outlined'
                    disabled={importing}
                    onClick={onImportClick}
                    startIcon={<IconFileImport size={18} />}
                    sx={{
                        height: 40,
                        px: 1.75,
                        borderRadius: 2,
                        textTransform: 'none',
                        fontWeight: 600,
                        color: theme.palette.mode === 'dark' ? theme.palette.text.primary : theme.palette.primary.main,
                        borderColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.55 : 0.4),
                        backgroundColor: 'transparent',
                        '&:hover': {
                            borderColor: theme.palette.primary.main,
                            backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.14 : 0.06)
                        }
                    }}
                >
                    Import Sample
                </Button>
            )}
            <StyledPermissionButton
                permissionId={'chatflows:create'}
                variant='contained'
                onClick={onNew}
                startIcon={<IconPlus size={18} />}
                sx={{ borderRadius: 2, height: 40, px: 1.75, textTransform: 'none', fontWeight: 600, boxShadow: 'none' }}
            >
                New Pipeline
            </StyledPermissionButton>
        </Stack>
    )
}

PipelineActions.propTypes = {
    samples: PropTypes.array,
    importing: PropTypes.bool,
    onImportClick: PropTypes.func,
    onNew: PropTypes.func
}

const RunCell = ({ run }) => {
    if (!run) return <Typography color='text.secondary'>Never run</Typography>
    const progress = runProgress(run)
    return (
        <Stack sx={{ gap: 0.5, minWidth: 140 }}>
            <Stack direction='row' alignItems='center' sx={{ gap: 1 }}>
                <Chip size='small' label={run.status} color={STATUS_COLORS[run.status] || 'default'} />
                <Typography variant='caption' color='text.secondary'>
                    {timeAgo(run.updatedAt)}
                </Typography>
            </Stack>
            {ACTIVE.has(run.status) && (
                <LinearProgress
                    variant={progress === null ? 'indeterminate' : 'determinate'}
                    value={progress ?? 0}
                    sx={{ height: 4, borderRadius: 2 }}
                />
            )}
        </Stack>
    )
}

RunCell.propTypes = { run: PropTypes.object }

const ScheduleCell = ({ schedules }) => {
    const active = (schedules || []).filter((schedule) => schedule.status === 'active' && schedule.nextRunAt)
    if (!active.length) {
        const paused = (schedules || []).some((schedule) => schedule.status === 'paused')
        return <Typography color='text.secondary'>{paused ? 'Paused' : '–'}</Typography>
    }
    active.sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)))
    return (
        <Stack sx={{ gap: 0.25 }}>
            <Typography variant='body2'>{new Date(active[0].nextRunAt).toLocaleString()}</Typography>
            <Typography variant='caption' color='text.secondary'>
                {active[0].label}
                {active.length > 1 ? ` · +${active.length - 1}` : ''}
            </Typography>
        </Stack>
    )
}
ScheduleCell.propTypes = { schedules: PropTypes.array }

const Etl = () => {
    const navigate = useNavigate()
    const theme = useTheme()
    const compact = useMediaQuery(theme.breakpoints.down('md'))
    const narrow = useMediaQuery(theme.breakpoints.down('sm'))
    const [pipelines, setPipelines] = useState(null)
    const [error, setError] = useState('')
    const [search, setSearch] = useState('')
    const [samples, setSamples] = useState([])
    const [sampleAnchor, setSampleAnchor] = useState(null)
    const [importing, setImporting] = useState(false)
    const timer = useRef(null)

    const load = useCallback(async () => {
        try {
            const response = await etlApi.listPipelines()
            setPipelines(response.data)
            setError('')
            const active = response.data.some((pipeline) => pipeline.lastRun && ACTIVE.has(pipeline.lastRun.status))
            const scheduled = response.data.some((pipeline) => (pipeline.schedules || []).some((schedule) => schedule.status === 'active'))
            clearTimeout(timer.current)
            if (active) timer.current = setTimeout(load, 2000)
            else if (scheduled) timer.current = setTimeout(load, 15000)
        } catch (err) {
            setError(errorText(err))
            setPipelines((current) => current || [])
        }
    }, [])

    useEffect(() => {
        load()
        etlApi
            .listSamples()
            .then((response) => setSamples(response.data))
            .catch(() => setSamples([]))
        return () => clearTimeout(timer.current)
    }, [load])

    const importSample = async (sample) => {
        setSampleAnchor(null)
        setImporting(true)
        try {
            const response = await etlApi.importSample(sample.id)
            navigate(`/etlcanvas/${response.data.id}`)
        } catch (err) {
            setError(errorText(err))
        } finally {
            setImporting(false)
        }
    }

    const filtered = (pipelines || []).filter((pipeline) => !search || pipeline.name.toLowerCase().includes(search.toLowerCase()))
    const upcoming = []
    for (const pipeline of filtered) {
        for (const schedule of pipeline.schedules || []) {
            if (schedule.status === 'active' && schedule.nextRunAt) upcoming.push({ ...schedule, pipelineName: pipeline.name })
        }
    }
    upcoming.sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)))

    const actions = (
        <PipelineActions
            samples={samples}
            importing={importing}
            onImportClick={(event) => setSampleAnchor(event.currentTarget)}
            onNew={() => navigate('/etlcanvas')}
        />
    )

    return (
        <MainCard>
            <Stack flexDirection='column' sx={{ gap: 3 }}>
                <Box>
                    <ViewHeader title='ETL' description='Load, clean, split, embed, and store data for retrieval.'>
                        {actions}
                    </ViewHeader>
                    {Boolean(pipelines?.length) && (
                        <OutlinedInput
                            size='small'
                            value={search}
                            placeholder='Search pipelines'
                            onChange={(event) => setSearch(event.target.value)}
                            startAdornment={
                                <Box sx={{ display: 'flex', color: subtitleColor(theme), mr: 0.5 }}>
                                    <IconSearch size={18} />
                                </Box>
                            }
                            sx={{ mt: 2, width: '100%', maxWidth: 360 }}
                        />
                    )}
                </Box>
                <Menu anchorEl={sampleAnchor} open={Boolean(sampleAnchor)} onClose={() => setSampleAnchor(null)}>
                    {samples.map((sample) => (
                        <MenuItem
                            key={sample.id}
                            onClick={() => importSample(sample)}
                            sx={{ display: 'block', maxWidth: 360, whiteSpace: 'normal' }}
                        >
                            <Typography variant='subtitle1'>{sample.name}</Typography>
                            <Typography variant='caption' color='text.secondary'>
                                {sample.description}
                            </Typography>
                        </MenuItem>
                    ))}
                </Menu>
                <WhichFlow pinned={pipelines !== null && pipelines.length === 0} />
                {error && <Alert severity='error'>{error}</Alert>}
                {upcoming.length > 0 && (
                    <Paper variant='outlined' sx={{ p: 1.5, borderRadius: 2 }}>
                        <Typography variant='subtitle2' sx={{ mb: 1 }}>
                            Upcoming runs
                        </Typography>
                        <Stack sx={{ gap: 0.75 }}>
                            {upcoming.slice(0, 6).map((schedule) => (
                                <Stack key={schedule.id} direction='row' alignItems='center' sx={{ gap: 1 }} flexWrap='wrap'>
                                    <Typography variant='body2'>{schedule.pipelineName}</Typography>
                                    <Chip size='small' variant='outlined' label={schedule.label} />
                                    <Chip size='small' variant='outlined' label={schedule.mode} />
                                    <Typography variant='caption' color='text.secondary'>
                                        {new Date(schedule.nextRunAt).toLocaleString()}
                                    </Typography>
                                </Stack>
                            ))}
                        </Stack>
                    </Paper>
                )}
                {pipelines === null ? (
                    <Stack sx={{ gap: 1, px: 1 }}>
                        <Typography color='text.secondary'>Loading pipelines.</Typography>
                        <LinearProgress />
                    </Stack>
                ) : pipelines.length === 0 ? (
                    <Box
                        sx={{
                            px: 3,
                            py: { xs: 6, md: 8 },
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            textAlign: 'center',
                            borderRadius: 3,
                            border: '1px dashed',
                            borderColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.4 : 0.28),
                            backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.08 : 0.04)
                        }}
                    >
                        <Box
                            sx={{
                                width: 48,
                                height: 48,
                                mb: 2,
                                borderRadius: '50%',
                                display: 'grid',
                                placeItems: 'center',
                                color: theme.palette.primary.main,
                                backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.1)
                            }}
                        >
                            <IconDatabaseImport size={24} />
                        </Box>
                        <Typography sx={{ fontSize: '1.125rem', fontWeight: 600, lineHeight: 1.3 }}>No pipelines yet</Typography>
                        <Typography sx={{ mt: 0.75, mb: 2.5, maxWidth: 420, fontSize: '0.95rem', color: subtitleColor(theme) }}>
                            Import a sample, or start a blank pipeline.
                        </Typography>
                        {actions}
                    </Box>
                ) : narrow ? (
                    <Stack sx={{ gap: 1.5 }}>
                        {filtered.map((pipeline) => (
                            <Paper
                                key={pipeline.id}
                                variant='outlined'
                                sx={{ p: 1.5, borderRadius: 2, cursor: 'pointer' }}
                                onClick={() => navigate(`/etlcanvas/${pipeline.id}`)}
                            >
                                <Typography variant='subtitle1' sx={{ wordBreak: 'break-word' }}>
                                    {pipeline.name}
                                </Typography>
                                {pipeline.problems.length > 0 && (
                                    <Typography variant='caption' color='error'>
                                        {pipeline.problems[0]}
                                    </Typography>
                                )}
                                <Stack direction='row' alignItems='center' flexWrap='wrap' sx={{ gap: 1, mt: 1 }}>
                                    <Typography variant='body2'>Chunks {formatNumber(pipeline.stats.chunks)}</Typography>
                                    <Chip size='small' variant='outlined' label={`v${pipeline.latestVersion ?? '–'}`} />
                                    {pipeline.servedVersion && (
                                        <Chip
                                            size='small'
                                            color='success'
                                            variant='outlined'
                                            label={`serving v${pipeline.servedVersion}`}
                                        />
                                    )}
                                </Stack>
                                <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 1 }}>
                                    Last run
                                </Typography>
                                <RunCell run={pipeline.lastRun} />
                            </Paper>
                        ))}
                        {filtered.length === 0 && <Typography color='text.secondary'>No pipeline matches “{search}”.</Typography>}
                    </Stack>
                ) : (
                    <TableContainer component={Paper} variant='outlined' sx={{ borderRadius: 2 }}>
                        <Table size={compact ? 'small' : 'medium'}>
                            <TableHead>
                                <TableRow>
                                    <TableCell>Pipeline</TableCell>
                                    {!compact && <TableCell>Sources</TableCell>}
                                    {!compact && <TableCell>Target</TableCell>}
                                    <TableCell align='right'>Chunks</TableCell>
                                    <TableCell>Version</TableCell>
                                    <TableCell>Last run</TableCell>
                                    {!compact && <TableCell>Next run</TableCell>}
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {filtered.map((pipeline) => (
                                    <TableRow
                                        key={pipeline.id}
                                        hover
                                        sx={{ cursor: 'pointer' }}
                                        onClick={() => navigate(`/etlcanvas/${pipeline.id}`)}
                                    >
                                        <TableCell>
                                            <Typography variant='subtitle1'>{pipeline.name}</Typography>
                                            {pipeline.problems.length > 0 && (
                                                <Typography variant='caption' color='error'>
                                                    {pipeline.problems[0]}
                                                </Typography>
                                            )}
                                        </TableCell>
                                        {!compact && <TableCell>{pipeline.sources.join(', ') || '–'}</TableCell>}
                                        {!compact && (
                                            <TableCell>
                                                <Typography variant='body2'>{pipeline.store || '–'}</Typography>
                                                <Typography variant='caption' color='text.secondary'>
                                                    {pipeline.embeddings || ''}
                                                </Typography>
                                            </TableCell>
                                        )}
                                        <TableCell align='right'>{formatNumber(pipeline.stats.chunks)}</TableCell>
                                        <TableCell>
                                            <Stack direction='row' sx={{ gap: 0.5 }} flexWrap='wrap'>
                                                <Chip size='small' variant='outlined' label={`v${pipeline.latestVersion ?? '–'}`} />
                                                {pipeline.servedVersion && (
                                                    <Chip
                                                        size='small'
                                                        color='success'
                                                        variant='outlined'
                                                        label={`serving v${pipeline.servedVersion}`}
                                                    />
                                                )}
                                            </Stack>
                                        </TableCell>
                                        <TableCell>
                                            <RunCell run={pipeline.lastRun} />
                                        </TableCell>
                                        {!compact && (
                                            <TableCell>
                                                <ScheduleCell schedules={pipeline.schedules} />
                                            </TableCell>
                                        )}
                                    </TableRow>
                                ))}
                                {filtered.length === 0 && (
                                    <TableRow>
                                        <TableCell colSpan={compact ? 5 : 7}>
                                            <Box sx={{ py: 2 }}>
                                                <Typography color='text.secondary'>No pipeline matches “{search}”.</Typography>
                                            </Box>
                                        </TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </TableContainer>
                )}
            </Stack>
        </MainCard>
    )
}

export default Etl
