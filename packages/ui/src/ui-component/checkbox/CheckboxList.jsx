import { useEffect, useMemo, useState } from 'react'
import PropTypes from 'prop-types'
import { Box, Button, Checkbox, CircularProgress, Stack, TextField, Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'

import { fetchList } from '@/ui-component/dropdown/AsyncDropdown'
import { filterChoices, missingNames, savedValue, selectedNames, selectionSummary, splitOptions, toggleName } from '@/utils/checkboxList'

const FILTER_FROM = 8

// An asyncMultiOptions input with one checkbox per option, for lists that are read rather than searched.
export const CheckboxList = ({ name, nodeData, value, onSelect, disabled = false }) => {
    const theme = useTheme()
    const [options, setOptions] = useState([])
    const [loading, setLoading] = useState(true)
    const [names, setNames] = useState(() => selectedNames(value))
    const [filter, setFilter] = useState('')

    useEffect(() => {
        let cancelled = false
        ;(async () => {
            const response = await fetchList({ name, nodeData })
            if (cancelled) return
            setOptions(Array.isArray(response) ? response : [])
            setLoading(false)
        })()
        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const { choices, messages } = useMemo(() => splitOptions(options), [options])
    const shown = useMemo(() => filterChoices(choices, filter), [choices, filter])
    const missing = useMemo(() => missingNames(names, choices), [names, choices])

    const save = (next) => {
        setNames(next)
        onSelect(savedValue(next))
    }

    const row = (option, checked, gone = false) => (
        <Box
            key={option.name}
            component='label'
            sx={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 0.5,
                py: 0.25,
                cursor: disabled ? 'default' : 'pointer',
                borderBottom: `1px solid ${theme.palette.grey[900]}14`
            }}
        >
            <Checkbox
                size='small'
                sx={{ p: 0.5 }}
                disabled={disabled}
                checked={checked}
                inputProps={{ 'aria-label': option.label || option.name }}
                onChange={() => save(toggleName(names, choices, option.name))}
            />
            <Box sx={{ minWidth: 0, pt: 0.5 }}>
                <Typography variant='body2' sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    {option.label || option.name}
                </Typography>
                <Typography variant='caption' color={gone ? 'error' : 'text.secondary'} sx={{ display: 'block' }}>
                    {gone ? 'Not in this database any more. Untick to remove it.' : option.description}
                </Typography>
            </Box>
        </Box>
    )

    if (loading) {
        return (
            <Stack direction='row' alignItems='center' gap={1} sx={{ mt: 1 }}>
                <CircularProgress size={16} />
                <Typography variant='caption'>Listing tables and views…</Typography>
            </Stack>
        )
    }

    return (
        <Box sx={{ mt: 1, width: '100%' }}>
            {messages.map((message) => (
                <Typography key={message.label} variant='caption' color='text.secondary' sx={{ display: 'block', mb: 0.5 }}>
                    <strong>{message.label}.</strong> {message.description}
                </Typography>
            ))}
            {choices.length > 0 && (
                <>
                    <Stack direction='row' alignItems='center' gap={1} sx={{ mb: 0.5 }}>
                        {choices.length >= FILTER_FROM && (
                            <TextField
                                size='small'
                                placeholder='Filter'
                                value={filter}
                                onChange={(event) => setFilter(event.target.value)}
                                inputProps={{ 'aria-label': 'Filter tables and views' }}
                                sx={{ flex: 1 }}
                            />
                        )}
                        <Button size='small' disabled={disabled} onClick={() => save([])}>
                            Clear
                        </Button>
                        <Button
                            size='small'
                            disabled={disabled}
                            onClick={() => save([...new Set([...names, ...shown.map((option) => option.name)])])}
                        >
                            Tick all{filter ? ' shown' : ''}
                        </Button>
                    </Stack>
                    <Box sx={{ maxHeight: 400, overflowY: 'auto', pr: 0.5 }} role='group' aria-label='Tables and views'>
                        {missing.map((item) => row({ name: item, label: item }, true, true))}
                        {shown.map((option) => row(option, names.includes(option.name)))}
                    </Box>
                    <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 0.75 }}>
                        {selectionSummary(names, choices)}
                    </Typography>
                </>
            )}
        </Box>
    )
}

CheckboxList.propTypes = {
    name: PropTypes.string,
    nodeData: PropTypes.object,
    value: PropTypes.oneOfType([PropTypes.string, PropTypes.array]),
    onSelect: PropTypes.func,
    disabled: PropTypes.bool
}
