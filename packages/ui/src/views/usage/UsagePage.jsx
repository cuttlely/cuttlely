import { useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'

import {
    Box,
    Link,
    Skeleton,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    TextField,
    ToggleButton,
    ToggleButtonGroup,
    Typography
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import MainCard from '@/ui-component/cards/MainCard'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import usageApi from '@/api/usage'
import PriceEditor from './PriceEditor'
import {
    PRESET_DAYS,
    apiErrorMessage,
    chartRows,
    choicesFrom,
    costLabel,
    customRangeError,
    formatDay,
    formatTokens,
    joinNames,
    usageIsEmpty,
    usageRequest
} from './query'

const INITIAL = { preset: 7, startDate: '', endDate: '', flowId: '', model: '' }

const UsageChart = ({ rows }) => {
    const theme = useTheme()
    const output = theme.palette.teal?.main || theme.palette.secondary.main
    const tick = { fill: theme.palette.text.secondary, fontSize: 12 }
    return (
        <Box sx={{ width: '100%', height: 280 }} role='img' aria-label='Daily input and output tokens'>
            <ResponsiveContainer width='100%' height='100%'>
                <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray='3 3' stroke={theme.palette.divider} />
                    <XAxis
                        dataKey='day'
                        tickFormatter={(value) => String(value).slice(5)}
                        interval={rows.length > 14 ? Math.ceil(rows.length / 8) : 0}
                        tick={tick}
                    />
                    <YAxis tick={tick} allowDecimals={false} />
                    <Tooltip formatter={(value, name) => [formatTokens(value), name]} labelFormatter={(label) => formatDay(label)} />
                    <Legend />
                    <Bar dataKey='Input' fill={theme.palette.primary.main} radius={[2, 2, 0, 0]} />
                    <Bar dataKey='Output' fill={output} radius={[2, 2, 0, 0]} />
                </BarChart>
            </ResponsiveContainer>
        </Box>
    )
}

UsageChart.propTypes = {
    rows: PropTypes.array
}

const UsagePage = ({ isOwner = false, client = usageApi }) => {
    const [state, setState] = useState(INITIAL)
    const [usage, setUsage] = useState(null)
    const [choices, setChoices] = useState({ flows: [], models: [] })
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const requestId = useRef(0)
    const stateRef = useRef(state)
    stateRef.current = state

    const load = async (next) => {
        const id = ++requestId.current
        setLoading(true)
        setError('')
        try {
            const view = await client.getUsage(usageRequest(next))
            if (id !== requestId.current) return
            setUsage(view.data)
            if (next.flowId || next.model) {
                const catalog = await client.getUsage(usageRequest({ ...next, flowId: '', model: '' }))
                if (id !== requestId.current) return
                setChoices(choicesFrom(catalog.data))
            } else {
                setChoices(choicesFrom(view.data))
            }
        } catch (err) {
            if (id !== requestId.current) return
            setUsage(null)
            setError(apiErrorMessage(err, 'Could not load usage.'))
        } finally {
            if (id === requestId.current) setLoading(false)
        }
    }

    useEffect(() => {
        load(INITIAL)
        // The first window is the last 7 UTC days.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const apply = (patch) => {
        const next = { ...stateRef.current, ...patch }
        stateRef.current = next
        setState(next)
        if (next.preset === 'custom' && customRangeError(next.startDate, next.endDate)) return
        load(next)
    }

    const onPreset = (_, value) => {
        if (value == null) return
        if (value === 'custom') {
            const startDate = usage?.startDate || ''
            const endDate = usage?.endDate || ''
            apply({ preset: 'custom', startDate, endDate })
            return
        }
        apply({ preset: value })
    }

    const rangeError = state.preset === 'custom' ? customRangeError(state.startDate, state.endDate) : ''
    const rows = chartRows(usage?.days)
    const unpriced = usage?.totals?.unpricedModels || []
    const narrowed = Boolean(state.flowId || state.model)
    const empty = usage && usageIsEmpty(usage) && !narrowed
    const noMatch = usage && usageIsEmpty(usage) && narrowed

    return (
        <MainCard contentSX={{ px: 2.5, py: 2 }}>
            <Stack spacing={2}>
                <ViewHeader
                    title='Usage'
                    description='Input and output tokens per day, and an estimated cost for each flow. Costs are estimates from the prices in effect now.'
                />
                <Stack direction='row' spacing={1.5} useFlexGap flexWrap='wrap' sx={{ alignItems: 'center' }}>
                    <ToggleButtonGroup exclusive size='small' value={state.preset} onChange={onPreset} aria-label='Range'>
                        {PRESET_DAYS.map((days) => (
                            <ToggleButton key={days} value={days}>
                                {days} days
                            </ToggleButton>
                        ))}
                        <ToggleButton value='custom'>Custom</ToggleButton>
                    </ToggleButtonGroup>
                    {state.preset === 'custom' && (
                        <>
                            <TextField
                                size='small'
                                type='date'
                                label='Start'
                                value={state.startDate}
                                onChange={(event) => apply({ startDate: event.target.value })}
                                InputLabelProps={{ shrink: true }}
                                inputProps={{ 'aria-label': 'Start date' }}
                            />
                            <TextField
                                size='small'
                                type='date'
                                label='End'
                                value={state.endDate}
                                onChange={(event) => apply({ endDate: event.target.value })}
                                InputLabelProps={{ shrink: true }}
                                inputProps={{ 'aria-label': 'End date' }}
                            />
                        </>
                    )}
                    <TextField
                        select
                        size='small'
                        label='Flow'
                        value={state.flowId}
                        onChange={(event) => apply({ flowId: event.target.value })}
                        SelectProps={{ native: true, inputProps: { 'aria-label': 'Flow' } }}
                        sx={{ minWidth: 180 }}
                    >
                        <option value=''>All flows</option>
                        {choices.flows.map((id) => (
                            <option key={id} value={id}>
                                {id}
                            </option>
                        ))}
                    </TextField>
                    <TextField
                        select
                        size='small'
                        label='Model'
                        value={state.model}
                        onChange={(event) => apply({ model: event.target.value })}
                        SelectProps={{ native: true, inputProps: { 'aria-label': 'Model' } }}
                        sx={{ minWidth: 180 }}
                    >
                        <option value=''>All models</option>
                        {choices.models.map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </TextField>
                </Stack>
                {rangeError && <Typography color='text.secondary'>{rangeError}</Typography>}
                {error && (
                    <Typography role='alert' color='error'>
                        {error}
                    </Typography>
                )}
                {loading && !usage && (
                    <Stack spacing={1}>
                        <Skeleton variant='rounded' height={280} />
                        <Skeleton variant='rounded' height={120} />
                    </Stack>
                )}
                {empty && (
                    <Box data-testid='usage-empty' sx={{ py: 6, textAlign: 'center' }}>
                        <Typography variant='h3' sx={{ mb: 1 }}>
                            No usage yet
                        </Typography>
                        <Typography color='text.secondary'>Usage is recorded from finished runs.</Typography>
                    </Box>
                )}
                {noMatch && <Typography color='text.secondary'>No usage for this filter in the selected range.</Typography>}
                {usage && !empty && (
                    <>
                        <Typography variant='body2' color='text.secondary'>
                            {formatDay(usage.startDate)} to {formatDay(usage.endDate)} UTC. {formatTokens(usage.totals?.inputTokens)} input
                            tokens, {formatTokens(usage.totals?.outputTokens)} output tokens, {costLabel(usage.totals)}.
                        </Typography>
                        <Box>
                            <Typography variant='h4' sx={{ mb: 1 }}>
                                Daily tokens
                            </Typography>
                            <UsageChart rows={rows} />
                        </Box>
                        {unpriced.length > 0 && (
                            <Typography>
                                No price for {joinNames(unpriced)}. Those tokens are left out of the estimate.
                                {isOwner && (
                                    <>
                                        {' '}
                                        <Link href='#model-prices'>Set a price</Link>
                                    </>
                                )}
                            </Typography>
                        )}
                        <Table size='small' aria-label='Usage by flow'>
                            <TableHead>
                                <TableRow>
                                    <TableCell>Flow</TableCell>
                                    <TableCell align='right'>Input tokens</TableCell>
                                    <TableCell align='right'>Output tokens</TableCell>
                                    <TableCell align='right'>Estimated cost</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {(usage.flows || []).map((row) => (
                                    <TableRow key={row.flowId}>
                                        <TableCell>{row.flowId}</TableCell>
                                        <TableCell align='right'>{formatTokens(row.inputTokens)}</TableCell>
                                        <TableCell align='right'>{formatTokens(row.outputTokens)}</TableCell>
                                        <TableCell align='right'>{costLabel(row)}</TableCell>
                                    </TableRow>
                                ))}
                                <TableRow>
                                    <TableCell>Total</TableCell>
                                    <TableCell align='right'>{formatTokens(usage.totals?.inputTokens)}</TableCell>
                                    <TableCell align='right'>{formatTokens(usage.totals?.outputTokens)}</TableCell>
                                    <TableCell align='right'>{costLabel(usage.totals)}</TableCell>
                                </TableRow>
                            </TableBody>
                        </Table>
                    </>
                )}
                {isOwner && <PriceEditor client={client} unpricedModels={unpriced} onChanged={() => load(stateRef.current)} />}
            </Stack>
        </MainCard>
    )
}

UsagePage.propTypes = {
    isOwner: PropTypes.bool,
    client: PropTypes.object
}

export default UsagePage
