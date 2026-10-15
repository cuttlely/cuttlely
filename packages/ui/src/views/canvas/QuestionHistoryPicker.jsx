import { useEffect, useRef } from 'react'
import PropTypes from 'prop-types'

import { Box, Button, Checkbox, CircularProgress, FormControlLabel, Stack, TextField, Typography } from '@mui/material'

import { QUESTION_SOURCE_OPTIONS, chooseRoom, chosenLabel, hiddenChosenCount, historyReasonText } from '@/utils/publishCheck'

// The list of stored questions a publish check can run. The count picker stays the default beside this.
const QuestionHistoryPicker = ({
    items = [],
    loading = false,
    error = '',
    query = { q: '', source: '', from: '', to: '' },
    hasMore = false,
    selected = [],
    cap = 100,
    typedPicked = 0,
    disabled = false,
    onSearch,
    onSource,
    onFrom,
    onTo,
    onToggle,
    onSelectShown,
    onLoadMore
}) => {
    const sentinel = useRef(null)
    const chosen = selected.length + typedPicked
    const room = chooseRoom({ cap, selectedCount: selected.length, typedPicked })
    const hidden = hiddenChosenCount(selected, items)
    const selectedIds = new Set(selected.map((entry) => entry.id))
    const canSelectShown = !disabled && room > 0 && items.some((item) => item.replayable !== false && !selectedIds.has(item.id))

    useEffect(() => {
        const node = sentinel.current
        if (!node || !hasMore || loading || disabled) return undefined
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) onLoadMore()
            },
            { rootMargin: '120px' }
        )
        observer.observe(node)
        return () => observer.disconnect()
    }, [hasMore, loading, disabled, onLoadMore, items.length])

    return (
        <Stack spacing={1} sx={{ mt: 1 }} data-testid='question-history'>
            <Typography variant='body2' data-testid='question-history-count' aria-live='polite'>
                {chosenLabel(chosen, cap)}
            </Typography>
            <Stack direction='row' spacing={1} useFlexGap flexWrap='wrap'>
                <TextField
                    size='small'
                    label='Search'
                    value={query.q || ''}
                    disabled={disabled}
                    onChange={(event) => onSearch(event.target.value)}
                    inputProps={{ 'aria-label': 'Search questions', maxLength: 200, 'data-testid': 'question-history-search' }}
                    sx={{ minWidth: 180, flex: 1 }}
                />
                <TextField
                    select
                    size='small'
                    label='Source'
                    value={query.source || ''}
                    disabled={disabled}
                    onChange={(event) => onSource(event.target.value)}
                    SelectProps={{ native: true }}
                    inputProps={{ 'aria-label': 'Question source', 'data-testid': 'question-history-source' }}
                    sx={{ minWidth: 160 }}
                >
                    {QUESTION_SOURCE_OPTIONS.map((option) => (
                        <option key={option.value || 'all'} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </TextField>
                <TextField
                    size='small'
                    label='From (UTC)'
                    type='date'
                    value={query.from || ''}
                    disabled={disabled}
                    onChange={(event) => onFrom(event.target.value)}
                    InputLabelProps={{ shrink: true }}
                    inputProps={{ 'aria-label': 'From date (UTC)', 'data-testid': 'question-history-from' }}
                    sx={{ width: 160 }}
                />
                <TextField
                    size='small'
                    label='To (UTC)'
                    type='date'
                    value={query.to || ''}
                    disabled={disabled}
                    onChange={(event) => onTo(event.target.value)}
                    InputLabelProps={{ shrink: true }}
                    inputProps={{ 'aria-label': 'To date (UTC)', 'data-testid': 'question-history-to' }}
                    sx={{ width: 160 }}
                />
            </Stack>
            <Button variant='text' onClick={onSelectShown} disabled={!canSelectShown} data-testid='question-history-select-shown'>
                Select all shown
            </Button>
            {hidden > 0 && (
                <Typography variant='caption' color='text.secondary' data-testid='question-history-hidden'>
                    {hidden === 1 ? '1 chosen question is hidden by this filter.' : `${hidden} chosen questions are hidden by this filter.`}
                </Typography>
            )}
            {error && (
                <Typography variant='body2' color='error' data-testid='question-history-error'>
                    {error}
                </Typography>
            )}
            <Stack aria-label='Stored questions' data-testid='question-history-list'>
                {items.map((item) => {
                    const replayable = item.replayable !== false
                    const checked = selectedIds.has(item.id)
                    const reason = replayable ? '' : historyReasonText(item.reason)
                    return (
                        <FormControlLabel
                            key={item.id}
                            data-testid='question-history-row'
                            sx={{ alignItems: 'flex-start', mr: 0, opacity: replayable ? 1 : 0.55 }}
                            control={
                                <Checkbox
                                    size='small'
                                    checked={checked}
                                    disabled={disabled || !replayable || (!checked && room < 1)}
                                    onChange={() => onToggle(item)}
                                    inputProps={{ 'aria-label': reason ? `${item.text}. ${reason}` : item.text }}
                                />
                            }
                            label={
                                <Box sx={{ pt: '9px' }}>
                                    <Typography
                                        variant='body2'
                                        color={replayable ? 'text.primary' : 'text.disabled'}
                                        sx={{ wordBreak: 'break-word' }}
                                    >
                                        {item.text}
                                    </Typography>
                                    <Typography variant='caption' color='text.secondary'>
                                        {sourceLabel(item.source)}
                                        {item.date ? ` · ${item.date.slice(0, 10)}` : ''}
                                        {reason ? ` · ${reason}` : ''}
                                    </Typography>
                                </Box>
                            }
                        />
                    )
                })}
                {!loading && items.length === 0 && !error && (
                    <Typography variant='body2' color='text.secondary' data-testid='question-history-empty'>
                        No questions match.
                    </Typography>
                )}
            </Stack>
            {loading && (
                <Stack direction='row' spacing={1} alignItems='center'>
                    <CircularProgress size={16} />
                    <Typography variant='body2' color='text.secondary'>
                        Loading questions…
                    </Typography>
                </Stack>
            )}
            {hasMore && (
                <Button variant='text' onClick={onLoadMore} disabled={disabled || loading} data-testid='question-history-more'>
                    Load more questions
                </Button>
            )}
            <Box ref={sentinel} data-testid='question-history-sentinel' sx={{ height: 1 }} />
        </Stack>
    )
}

const sourceLabel = (source) => QUESTION_SOURCE_OPTIONS.find((option) => option.value === source)?.label || 'Question'

QuestionHistoryPicker.propTypes = {
    items: PropTypes.array,
    loading: PropTypes.bool,
    error: PropTypes.string,
    query: PropTypes.object,
    hasMore: PropTypes.bool,
    selected: PropTypes.array,
    cap: PropTypes.number,
    typedPicked: PropTypes.number,
    disabled: PropTypes.bool,
    onSearch: PropTypes.func,
    onSource: PropTypes.func,
    onFrom: PropTypes.func,
    onTo: PropTypes.func,
    onToggle: PropTypes.func,
    onSelectShown: PropTypes.func,
    onLoadMore: PropTypes.func
}

export default QuestionHistoryPicker
