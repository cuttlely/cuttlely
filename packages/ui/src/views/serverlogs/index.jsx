import { useState, useEffect, forwardRef } from 'react'
import PropTypes from 'prop-types'

// project imports
import MainCard from '@/ui-component/cards/MainCard'
import DatePicker from 'react-datepicker'
import { gridSpacing } from '@/store/constant'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { sublime } from '@uiw/codemirror-theme-sublime'

// material-ui
import { Box, Button, Skeleton, Stack, Select, MenuItem, ListItemButton, Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { IconRefresh } from '@tabler/icons-react'

// ui
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import ErrorBoundary from '@/ErrorBoundary'

import useApi from '@/hooks/useApi'
import logsApi from '@/api/log'
import { useError } from '@/store/context/ErrorContext'
import { logsQuery } from './query'

import LogsEmptySVG from '@/assets/images/logs_empty.svg'
import 'react-datepicker/dist/react-datepicker.css'

const DatePickerCustomInput = forwardRef(function DatePickerCustomInput({ value, onClick }, ref) {
    return (
        <ListItemButton style={{ borderRadius: 15, border: '1px solid #e0e0e0' }} onClick={onClick} ref={ref}>
            {value}
        </ListItemButton>
    )
})

DatePickerCustomInput.propTypes = {
    value: PropTypes.string,
    onClick: PropTypes.func
}

const logLevels = [
    { value: 'error', label: 'Errors' },
    { value: 'warn', label: 'Warnings' },
    { value: 'info', label: 'Info' },
    { value: 'debug', label: 'Debug' }
]

const searchTimeRanges = [
    'Last hour',
    'Last 4 hours',
    'Last 24 hours',
    'Last 2 days',
    'Last 7 days',
    'Last 14 days',
    'Last 1 month',
    'Last 2 months',
    'Last 3 months',
    'Custom'
]

const getDateBefore = (unit, value) => {
    const now = new Date()
    if (unit === 'hours') now.setHours(now.getHours() - value)
    if (unit === 'days') now.setDate(now.getDate() - value)
    if (unit === 'months') now.setMonth(now.getMonth() - value)
    return now
}

const getDateTimeFormatted = (date) => {
    const now = date ? date : new Date()
    const year = now.getFullYear()
    const month = (now.getMonth() + 1).toString().padStart(2, '0') // +1 because getMonth() returns 0 for January, 1 for February, etc.
    const day = now.getDate().toString().padStart(2, '0')
    const hour = now.getHours().toString().padStart(2, '0')

    return `${year}-${month}-${day}-${hour}`
}

const Logs = () => {
    const colorTheme = useTheme()

    const customStyle = EditorView.baseTheme({
        '&': {
            color: '#191b1f',
            padding: '10px',
            borderRadius: '15px'
        },
        '.cm-placeholder': {
            color: 'rgba(120, 120, 120, 0.5)'
        },
        '.cm-content': {
            fontFamily: 'Roboto, sans-serif',
            fontSize: '0.95rem',
            letterSpacing: '0em',
            fontWeight: 400,
            lineHeight: '1.5em',
            color: colorTheme.darkTextPrimary
        }
    })

    const getLogsApi = useApi(logsApi.getLogs)
    const { error } = useError()

    const [isLoading, setLoading] = useState(true)
    const [logData, setLogData] = useState('')
    const [configured, setConfigured] = useState(true)
    const [truncated, setTruncated] = useState(false)
    const [level, setLevel] = useState('info')
    const [selectedTimeSearch, setSelectedTimeSearch] = useState('Last hour')
    const [startDate, setStartDate] = useState(getDateBefore('hours', 1))
    const [endDate, setEndDate] = useState(new Date())

    const loadLogs = (selection, nextLevel = level, from = startDate, to = endDate) => {
        getLogsApi.request(
            logsQuery({
                selection,
                level: nextLevel,
                startDate: getDateTimeFormatted(from),
                endDate: getDateTimeFormatted(to)
            })
        )
    }

    const handleTimeSelectionChange = (event) => {
        const selection = event.target.value
        setSelectedTimeSearch(selection)
        if (selection === 'Custom') {
            const from = getDateBefore('hours', 1)
            const to = new Date()
            setStartDate(from)
            setEndDate(to)
            loadLogs(selection, level, from, to)
            return
        }
        loadLogs(selection)
    }

    const onStartDateSelected = (date) => {
        setStartDate(date)
        loadLogs('Custom', level, date, endDate)
    }

    const onEndDateSelected = (date) => {
        setEndDate(date)
        loadLogs('Custom', level, startDate, date)
    }

    const onLevelChange = (event) => {
        const nextLevel = event.target.value
        setLevel(nextLevel)
        loadLogs(selectedTimeSearch, nextLevel)
    }

    useEffect(() => {
        loadLogs('Last hour', 'info')

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        setLoading(getLogsApi.loading)
    }, [getLogsApi.loading])

    useEffect(() => {
        const payload = getLogsApi.data
        if (!payload || Array.isArray(payload)) return
        setConfigured(payload.configured !== false)
        setTruncated(Boolean(payload.truncated))
        const lines = Array.isArray(payload.lines) ? payload.lines : []
        setLogData(lines.join('\n'))
    }, [getLogsApi.data])

    return (
        <MainCard>
            {error ? (
                <ErrorBoundary error={error} />
            ) : (
                <Stack flexDirection='column' sx={{ gap: 2 }}>
                    <ViewHeader title='Logs' />
                    {isLoading ? (
                        <Box display='flex' flexDirection='column' gap={gridSpacing}>
                            <Skeleton width='25%' height={32} />
                            <Box display='flex' flexDirection='column' gap={2}>
                                <Skeleton width='20%' />
                                <Skeleton variant='rounded' height={56} />
                            </Box>
                            <Box display='flex' flexDirection='column' gap={2}>
                                <Skeleton width='20%' />
                                <Skeleton variant='rounded' height={56} />
                            </Box>
                            <Box display='flex' flexDirection='column' gap={2}>
                                <Skeleton width='20%' />
                                <Skeleton variant='rounded' height={56} />
                            </Box>
                        </Box>
                    ) : (
                        <>
                            <Stack sx={{ alignItems: 'center', justifyContent: 'flex-start', gap: 2 }} flexDirection='row' flexWrap='wrap'>
                                <Select
                                    size='small'
                                    sx={{ minWidth: '140px' }}
                                    value={level}
                                    onChange={onLevelChange}
                                    inputProps={{ 'aria-label': 'Log level' }}
                                >
                                    {logLevels.map((item) => (
                                        <MenuItem key={item.value} value={item.value}>
                                            {item.label}
                                        </MenuItem>
                                    ))}
                                </Select>
                                <Select
                                    size='small'
                                    sx={{ minWidth: '200px' }}
                                    value={selectedTimeSearch}
                                    onChange={handleTimeSelectionChange}
                                    inputProps={{ 'aria-label': 'Time range' }}
                                >
                                    {searchTimeRanges.map((range) => (
                                        <MenuItem key={range} value={range}>
                                            {range}
                                        </MenuItem>
                                    ))}
                                </Select>
                                {selectedTimeSearch === 'Custom' && (
                                    <>
                                        <Stack sx={{ alignItems: 'center', justifyContent: 'flex-start', gap: 2 }} flexDirection='row'>
                                            <b>From</b>
                                            <DatePicker
                                                selected={startDate}
                                                onChange={(date) => onStartDateSelected(date)}
                                                selectsStart
                                                startDate={startDate}
                                                endDate={endDate}
                                                maxDate={endDate}
                                                showTimeSelect
                                                timeFormat='HH:mm'
                                                timeIntervals={60}
                                                dateFormat='yyyy MMMM d, h aa'
                                                customInput={<DatePickerCustomInput />}
                                            />
                                        </Stack>
                                        <Stack sx={{ alignItems: 'center', justifyContent: 'flex-start', gap: 2 }} flexDirection='row'>
                                            <b>To</b>
                                            <DatePicker
                                                selected={endDate}
                                                onChange={(date) => onEndDateSelected(date)}
                                                selectsEnd
                                                showTimeSelect
                                                timeFormat='HH:mm'
                                                timeIntervals={60}
                                                startDate={startDate}
                                                endDate={endDate}
                                                minDate={startDate}
                                                maxDate={new Date()}
                                                dateFormat='yyyy MMMM d, h aa'
                                                customInput={<DatePickerCustomInput />}
                                            />
                                        </Stack>
                                    </>
                                )}
                                <Button
                                    size='small'
                                    variant='outlined'
                                    startIcon={<IconRefresh size={16} />}
                                    onClick={() => loadLogs(selectedTimeSearch)}
                                    disabled={isLoading}
                                >
                                    Refresh
                                </Button>
                            </Stack>
                            {truncated && configured && (
                                <Typography variant='body2'>
                                    Showing the most recent lines. Older lines in this range were left out.
                                </Typography>
                            )}
                            {!configured ? (
                                <Stack
                                    sx={{ alignItems: 'flex-start', justifyContent: 'center', gap: 1, maxWidth: 640 }}
                                    flexDirection='column'
                                >
                                    <Typography variant='h4'>No log file is configured</Typography>
                                    <Typography>
                                        Set LOG_PATH to the directory where the server writes logs. Docker Compose and the published image
                                        use /var/cuttlely/logs. A from-source server writes a logs directory when LOG_PATH is unset.
                                    </Typography>
                                </Stack>
                            ) : logData ? (
                                <CodeMirror
                                    value={logData}
                                    height={'calc(100vh - 220px)'}
                                    theme={sublime}
                                    extensions={[markdown(), EditorView.lineWrapping, customStyle]}
                                    readOnly={true}
                                    basicSetup={{
                                        searchKeymap: true,
                                        lineNumbers: false,
                                        foldGutter: false,
                                        autocompletion: false,
                                        highlightActiveLine: false
                                    }}
                                />
                            ) : (
                                <Stack sx={{ alignItems: 'center', justifyContent: 'center' }} flexDirection='column'>
                                    <Box sx={{ p: 2, height: 'auto' }}>
                                        <img
                                            style={{ objectFit: 'cover', height: '20vh', width: 'auto' }}
                                            src={LogsEmptySVG}
                                            alt='LogsEmptySVG'
                                        />
                                    </Box>
                                    <div>No log lines in this range</div>
                                </Stack>
                            )}
                        </>
                    )}
                </Stack>
            )}
        </MainCard>
    )
}

export default Logs
