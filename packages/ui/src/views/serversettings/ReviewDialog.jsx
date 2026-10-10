import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'

import { alpha, useTheme } from '@mui/material/styles'
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material'
import { IconAlertTriangle, IconArrowRight, IconKey } from '@tabler/icons-react'

import { CONFIRM_WORD, SECRET_ACTIONS, needsTypedConfirm } from './model'
import { SENTENCE_CASE_BUTTONS } from './layout'

// The review step before saving: each change, old to new. Secrets say what happens, never the value.
const ReviewDialog = ({ open, rows, sections, saving, onClose, onSave }) => {
    const theme = useTheme()
    const sectionLabel = (id) => sections.find((section) => section.id === id)?.label ?? id
    const typed = needsTypedConfirm(rows)
    const [word, setWord] = useState('')
    useEffect(() => {
        if (open) setWord('')
    }, [open])
    const confirmed = !typed || word.trim() === CONFIRM_WORD
    return (
        <Dialog
            open={open}
            onClose={saving ? undefined : onClose}
            maxWidth='sm'
            fullWidth
            PaperProps={{ sx: { borderRadius: 3, ...SENTENCE_CASE_BUTTONS } }}
        >
            <DialogTitle sx={{ fontSize: '1.15rem', fontWeight: 600, pb: 0.5 }}>
                Review {rows.length === 1 ? 'one change' : `${rows.length} changes`}
            </DialogTitle>
            <DialogContent>
                <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
                    Saving keeps them for the next start. The server keeps running with its current settings until it restarts.
                </Typography>
                <Stack sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: 2, overflow: 'hidden' }}>
                    {rows.map((row, index) => (
                        <Box
                            key={row.key}
                            sx={{ px: 2, py: 1.5, borderTop: index ? `1px solid ${theme.palette.divider}` : 'none' }}
                            data-testid={`review-${row.key}`}
                        >
                            <Stack direction='row' alignItems='baseline' justifyContent='space-between' gap={2}>
                                <Stack direction='row' alignItems='center' gap={1}>
                                    <Typography sx={{ fontWeight: 600 }}>{row.label}</Typography>
                                    {row.risk === 'high' && (
                                        <Chip
                                            size='small'
                                            color='warning'
                                            variant='outlined'
                                            icon={<IconAlertTriangle size={13} />}
                                            label='High risk'
                                            sx={{ height: 20, fontSize: '0.7rem' }}
                                        />
                                    )}
                                </Stack>
                                <Typography variant='caption' color='text.secondary'>
                                    {sectionLabel(row.section)}
                                </Typography>
                            </Stack>
                            {row.secret ? (
                                <Stack direction='row' alignItems='center' gap={1} sx={{ mt: 0.5 }}>
                                    <IconKey size={15} />
                                    <Typography variant='body2'>{SECRET_ACTIONS[row.secret]} (hidden)</Typography>
                                </Stack>
                            ) : (
                                <Stack direction='row' alignItems='center' gap={1} sx={{ mt: 0.5, flexWrap: 'wrap' }}>
                                    <Typography
                                        variant='body2'
                                        color='text.secondary'
                                        sx={{ textDecoration: 'line-through', wordBreak: 'break-word' }}
                                    >
                                        {row.from}
                                    </Typography>
                                    <IconArrowRight size={14} />
                                    <Typography
                                        variant='body2'
                                        sx={{
                                            fontWeight: 500,
                                            px: 0.75,
                                            borderRadius: 1,
                                            backgroundColor: alpha(theme.palette.primary.main, 0.08),
                                            wordBreak: 'break-word'
                                        }}
                                    >
                                        {row.to}
                                    </Typography>
                                </Stack>
                            )}
                        </Box>
                    ))}
                </Stack>
                {typed && (
                    <Stack gap={1.5} sx={{ mt: 2.5 }}>
                        <Alert severity='warning' sx={{ borderRadius: 2.5 }}>
                            A high-risk change can stop Cuttlely from starting or keep people from signing in. If the next start fails
                            twice, safe boot puts back the last settings that worked.
                        </Alert>
                        <TextField
                            size='small'
                            label={`Type ${CONFIRM_WORD} to save`}
                            value={word}
                            onChange={(event) => setWord(event.target.value)}
                            inputProps={{ 'data-testid': 'review-confirm', spellCheck: false, autoComplete: 'off' }}
                        />
                    </Stack>
                )}
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2.5 }}>
                <Button onClick={onClose} disabled={saving}>
                    Back
                </Button>
                <Button
                    variant='contained'
                    onClick={onSave}
                    disabled={saving || !confirmed}
                    sx={{ borderRadius: 2, px: 2.5 }}
                    data-testid='review-save'
                >
                    {saving ? 'Saving...' : 'Save changes'}
                </Button>
            </DialogActions>
        </Dialog>
    )
}

ReviewDialog.propTypes = {
    open: PropTypes.bool,
    rows: PropTypes.array.isRequired,
    sections: PropTypes.array.isRequired,
    saving: PropTypes.bool,
    onClose: PropTypes.func.isRequired,
    onSave: PropTypes.func.isRequired
}

export default ReviewDialog
