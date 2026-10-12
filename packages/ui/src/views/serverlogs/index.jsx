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

const subtractTime = (months, days, hours) => {
    let checkDate = new Date()

    if (months > 0) {
        checkDate.setMonth(checkDate.getMonth() - months)
    } else {
        checkDate.setMonth(checkDate.getMonth())
    }

    if (days > 0) {
        checkDate.setDate(checkDate.getDate() - days)
    } else {
        checkDate.setDate(checkDate.getDate())
    }

    if (hours > 0) {
        checkDate.setHours(checkDate.getHours() - hours)
    } else {
        checkDate.setHours(checkDate.getHours())
    }

    const year = checkDate.getFullYear()
    const month = (checkDate.getMonth() + 1).toString().padStart(2, '0')
    const day = checkDate.getDate().toString().padStart(2, '0')
    const hour = checkDate.getHours().toString().padStart(2, '0')

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
    const [rangeStart, setRangeStart] = useState('')
    const [rangeEnd, setRangeEnd] = useState('')
    const [selectedTimeSearch, setSelectedTimeSearch] = useState('Last hour')
    const [startDate, setStartDate] = useState(getDateBefore('hours', 1))
    const [endDate, setEndDate] = useState(new Date())

    const loadLogs = (start, end, nextLevel = level) => {
        setRangeStart(start)
        setRangeEnd(end)
        getLogsApi.request(start, end, nextLevel)
    }

    const handleTimeSelectionChange = (event) => {
        setSelectedTimeSearch(event.target.value)
        switch (event.target.value) {
            case 'Last hour':
                loadLogs(subtractTime(0, 0, 1), getDateTimeFormatted())
                break
            case 'Last 4 hours':
                loadLogs(subtractTime(0, 0, 4), getDateTimeFormatted())
                break
            case 'Last 24 hours':
                loadLogs(subtractTime(0, 0, 24), getDateTimeFormatted())
                break
            case 'Last 2 days':
                loadLogs(subtractTime(0, 2, 0), getDateTimeFormatted())
                break
            case 'Last 7 days':
                loadLogs(subtractTime(0, 7, 0), getDateTimeFormatted())
                break
            case 'Last 14 days':
                loadLogs(subtractTime(0, 14, 0), getDateTimeFormatted())
                break
            case 'Last 1 month':
                loadLogs(subtractTime(1, 0, 0), getDateTimeFormatted())
                break
            case 'Last 2 months':
                loadLogs(subtractTime(2, 0, 0), getDateTimeFormatted())
                break
            case 'Last 3 months':
                loadLogs(subtractTime(3, 0, 0), getDateTimeFormatted())
                break
            case 'Custom':
                setStartDate(getDateBefore('hours', 1))
                setEndDate(new Date())
                loadLogs(subtractTime(0, 0, 1), getDateTimeFormatted())
                break
            default:
                break
        }
    }

    const onStartDateSelected = (date) => {
        setStartDate(date)
        loadLogs(getDateTimeFormatted(date), getDateTimeFormatted(endDate))
    }

    const onEndDateSelected = (date) => {
        setEndDate(date)
        loadLogs(getDateTimeFormatted(startDate), getDateTimeFormatted(date))
    }

    const onLevelChange = (event) => {
        const nextLevel = event.target.value
        setLevel(nextLevel)
        if (rangeStart && rangeEnd) loadLogs(rangeStart, rangeEnd, nextLevel)
    }

    useEffect(() => {
        const currentTimeFormatted = getDateTimeFormatted()
        const startTimeFormatted = subtractTime(0, 0, 1)
        loadLogs(startTimeFormatted, currentTimeFormatted)

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
                                    onClick={() => rangeStart && rangeEnd && loadLogs(rangeStart, rangeEnd)}
                                    disabled={isLoading || !rangeStart || !rangeEnd}
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
