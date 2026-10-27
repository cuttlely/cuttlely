import { useEffect, useMemo, useState } from 'react'
import PropTypes from 'prop-types'
import {
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    Radio,
    RadioGroup,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    Typography
} from '@mui/material'
import { StyledButton } from '@/ui-component/button/StyledButton'
import { DRAFT_CONFLICT_RELOAD, DRAFT_CONFLICT_SAVE_ANYWAY, DRAFT_CONFLICT_TITLE, draftConflictMessage } from '@/utils/flowDrafts'
import { applyDraftMerge, conflictKey, conflictSummary, draftMergePlan, mergeLine } from '@/utils/flowDraftsMerge'

export const DRAFT_CONFLICT_APPLY = 'Apply merge'
export const DRAFT_CONFLICT_MERGE_HELP =
    'Their changes that do not touch yours are merged for you. Where you both changed the same card, connection or setting, pick which one to keep. Applying puts the result on your canvas without saving it.'
export const DRAFT_CONFLICT_NO_MERGE = 'Their saved draft could not be read, so it cannot be merged here. Reload to see it, or save anyway.'

const valueSx = { fontFamily: 'monospace', fontSize: '0.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', verticalAlign: 'top' }

const ConflictItem = ({ entry, choice, onChoose }) => (
    <Box data-testid='draft-conflict-item' sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
        <Typography variant='subtitle2'>
            {entry.label}: {conflictSummary(entry)}
        </Typography>
        <RadioGroup row value={choice} onChange={(event) => onChoose(event.target.value)} aria-label={`Keep for ${entry.label}`}>
            <FormControlLabel value='mine' control={<Radio size='small' />} label='Keep mine' />
            <FormControlLabel value='theirs' control={<Radio size='small' />} label='Keep theirs' />
        </RadioGroup>
        {entry.fields?.length ? (
            <Table size='small'>
                <TableHead>
                    <TableRow>
                        <TableCell>Field</TableCell>
                        <TableCell>Mine</TableCell>
                        <TableCell>Theirs</TableCell>
                    </TableRow>
                </TableHead>
                <TableBody>
                    {entry.fields.map((row) => (
                        <TableRow key={row.field}>
                            <TableCell sx={{ verticalAlign: 'top' }}>{row.label}</TableCell>
                            <TableCell sx={valueSx}>{row.mine || '(empty)'}</TableCell>
                            <TableCell sx={valueSx}>{row.theirs || '(empty)'}</TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        ) : null}
    </Box>
)

ConflictItem.propTypes = {
    entry: PropTypes.object.isRequired,
    choice: PropTypes.oneOf(['mine', 'theirs']),
    onChoose: PropTypes.func
}

const LINE_COLORS = { added: 'success.main', removed: 'error.main', changed: 'warning.main' }

// The conflict review screen. On a 409 it compares the draft this canvas started from, the open editor and
// the draft the other person saved. Reload and Save anyway stay as the two ways out. Closing, including
// Escape, does nothing else.
const DraftConflictDialog = ({ open, conflict, onReload, onSaveAnyway, onApply, onClose, normalize }) => {
    const plan = useMemo(
        () => (conflict?.theirs?.flowData ? draftMergePlan(conflict.base, conflict.mine, conflict.theirs.flowData, normalize) : null),
        [conflict, normalize]
    )
    const [choices, setChoices] = useState({})
    useEffect(() => setChoices({}), [conflict])
    const loading = Boolean(conflict?.loading)
    const canMerge = Boolean(plan && onApply)

    const apply = () => {
        if (!plan || !onApply) return
        onApply(applyDraftMerge(plan, choices), conflict.theirs)
    }

    return (
        <Dialog
            fullWidth
            maxWidth={canMerge ? 'md' : 'xs'}
            open={Boolean(open)}
            onClose={onClose}
            aria-labelledby='draft-conflict-title'
            aria-describedby='draft-conflict-description'
        >
            <DialogTitle sx={{ fontSize: '1rem' }} id='draft-conflict-title'>
                {DRAFT_CONFLICT_TITLE}
            </DialogTitle>
            <DialogContent>
                <Stack spacing={1.5}>
                    <span id='draft-conflict-description'>{conflict ? draftConflictMessage(conflict) : ''}</span>
                    {loading ? (
                        <Stack direction='row' spacing={1} alignItems='center'>
                            <CircularProgress size={16} />
                            <Typography variant='body2'>Reading their changes…</Typography>
                        </Stack>
                    ) : null}
                    {!loading && conflict && !canMerge ? (
                        <Typography variant='body2' data-testid='draft-conflict-no-merge'>
                            {DRAFT_CONFLICT_NO_MERGE}
                        </Typography>
                    ) : null}
                    {canMerge ? (
                        <>
                            <Typography variant='body2'>{DRAFT_CONFLICT_MERGE_HELP}</Typography>
                            <Typography variant='subtitle2'>Merged from their draft</Typography>
                            {plan.merged.length ? (
                                <Stack spacing={0.5} data-testid='draft-conflict-merged'>
                                    {plan.merged.map((entry) => (
                                        <Typography key={conflictKey(entry)} variant='body2' sx={{ color: LINE_COLORS[entry.theirChange] }}>
                                            {mergeLine(entry, 'theirs')}
                                        </Typography>
                                    ))}
                                </Stack>
                            ) : (
                                <Typography variant='body2' color='text.secondary'>
                                    Nothing else to merge.
                                </Typography>
                            )}
                            <Typography variant='subtitle2'>Changed on both sides</Typography>
                            {plan.conflicts.length ? (
                                <Stack spacing={1}>
                                    {plan.conflicts.map((entry) => (
                                        <ConflictItem
                                            key={conflictKey(entry)}
                                            entry={entry}
                                            choice={choices[conflictKey(entry)] === 'theirs' ? 'theirs' : 'mine'}
                                            onChoose={(value) => setChoices((current) => ({ ...current, [conflictKey(entry)]: value }))}
                                        />
                                    ))}
                                </Stack>
                            ) : (
                                <Typography variant='body2' color='text.secondary'>
                                    None. Your changes and theirs do not overlap.
                                </Typography>
                            )}
                        </>
                    ) : null}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onReload}>{DRAFT_CONFLICT_RELOAD}</Button>
                <Button onClick={onSaveAnyway}>{DRAFT_CONFLICT_SAVE_ANYWAY}</Button>
                {canMerge ? (
                    <StyledButton variant='contained' onClick={apply}>
                        {DRAFT_CONFLICT_APPLY}
                    </StyledButton>
                ) : null}
            </DialogActions>
        </Dialog>
    )
}

DraftConflictDialog.propTypes = {
    open: PropTypes.bool,
    conflict: PropTypes.shape({
        savedBy: PropTypes.shape({
            id: PropTypes.oneOfType([PropTypes.string, PropTypes.oneOf([null])]),
            name: PropTypes.string
        }),
        savedAt: PropTypes.oneOfType([PropTypes.string, PropTypes.oneOf([null])]),
        base: PropTypes.oneOfType([PropTypes.string, PropTypes.oneOf([null])]),
        mine: PropTypes.oneOfType([PropTypes.string, PropTypes.oneOf([null])]),
        theirs: PropTypes.shape({
            flowData: PropTypes.string,
            hash: PropTypes.oneOfType([PropTypes.string, PropTypes.oneOf([null])]),
            status: PropTypes.object
        }),
        loading: PropTypes.bool
    }),
    onReload: PropTypes.func,
    onSaveAnyway: PropTypes.func,
    onApply: PropTypes.func,
    onClose: PropTypes.func,
    normalize: PropTypes.func
}

export default DraftConflictDialog
