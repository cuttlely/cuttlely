import PropTypes from 'prop-types'
import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material'
import { StyledButton } from '@/ui-component/button/StyledButton'
import { DRAFT_CONFLICT_RELOAD, DRAFT_CONFLICT_SAVE_ANYWAY, DRAFT_CONFLICT_TITLE, draftConflictMessage } from '@/utils/flowDrafts'

// Asks before a save replaces a shared draft someone else saved. Closing, including Escape, does nothing else.
const DraftConflictDialog = ({ open, conflict, onReload, onSaveAnyway, onClose }) => {
    return (
        <Dialog
            fullWidth
            maxWidth='xs'
            open={Boolean(open)}
            onClose={onClose}
            aria-labelledby='draft-conflict-title'
            aria-describedby='draft-conflict-description'
        >
            <DialogTitle sx={{ fontSize: '1rem' }} id='draft-conflict-title'>
                {DRAFT_CONFLICT_TITLE}
            </DialogTitle>
            <DialogContent>
                <span id='draft-conflict-description'>{conflict ? draftConflictMessage(conflict) : ''}</span>
            </DialogContent>
            <DialogActions>
                <Button onClick={onReload}>{DRAFT_CONFLICT_RELOAD}</Button>
                <StyledButton variant='contained' onClick={onSaveAnyway}>
                    {DRAFT_CONFLICT_SAVE_ANYWAY}
                </StyledButton>
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
        savedAt: PropTypes.oneOfType([PropTypes.string, PropTypes.oneOf([null])])
    }),
    onReload: PropTypes.func,
    onSaveAnyway: PropTypes.func,
    onClose: PropTypes.func
}

export default DraftConflictDialog
