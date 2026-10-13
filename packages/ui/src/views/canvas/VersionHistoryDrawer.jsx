import PropTypes from 'prop-types'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

// material-ui
import {
    Alert,
    Box,
    Button,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Divider,
    Drawer,
    IconButton,
    List,
    ListItemButton,
    ListItemText,
    MenuItem,
    Stack,
    TextField,
    Typography,
    useMediaQuery
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { IconX } from '@tabler/icons-react'

// project imports
import flowDraftsApi from '@/api/flowDrafts'
import flowVersionsApi from '@/api/flowVersions'
import { apiErrorMessage, rollbackLabel } from '@/utils/flowDrafts'
import {
    authorKey,
    authorLabel,
    authorOptions,
    exactTime,
    filterByAuthor,
    hiddenNote,
    kindLabel,
    relativeTime,
    versionMarkers
} from '@/utils/versionHistory'

// ==============================|| VERSION HISTORY ||============================== //

const VersionHistoryDrawer = ({ open, chatflow, isDirty, draftMode, onClose, onRolledBack }) => {
    const theme = useTheme()
    const navigate = useNavigate()
    const compact = useMediaQuery(theme.breakpoints.down('sm'))
    const [state, setState] = useState({ loading: false, versions: [], liveSha: null, lastError: null, error: null })
    const [person, setPerson] = useState('all')
    const [rollbackTarget, setRollbackTarget] = useState(null)
    const [rollingBack, setRollingBack] = useState(false)
    const [rollbackError, setRollbackError] = useState('')
    const people = useMemo(() => authorOptions(state.versions), [state.versions])
    // A filter for someone no longer in the list falls back to everyone.
    const activePerson = person === 'all' || people.some((option) => option.key === person) ? person : 'all'
    const shown = useMemo(() => filterByAuthor(state.versions, activePerson), [state.versions, activePerson])
    const currentSha = state.versions[0]?.sha

    useEffect(() => {
        if (!open || !chatflow?.id) return
        let cancelled = false
        setState((prev) => ({ ...prev, loading: true, error: null }))
        flowVersionsApi
            .listVersions(chatflow.id)
            .then((res) => {
                if (cancelled) return
                setState({
                    loading: false,
                    versions: res.data?.versions || [],
                    liveSha: res.data?.liveSha || null,
                    lastError: res.data?.lastError || null,
                    error: null
                })
            })
            .catch((error) => {
                if (cancelled) return
                const message = error?.response?.data?.message || 'Version history could not be loaded.'
                setState({ loading: false, versions: [], liveSha: null, lastError: null, error: message })
            })
        return () => {
            cancelled = true
        }
    }, [open, chatflow?.id, chatflow?.updatedDate])

    const openVersion = (sha) => {
        onClose()
        // The flow type rides along so the viewer's back button knows its canvas before the version loads.
        navigate(`/versions/${encodeURIComponent(chatflow.id)}/${encodeURIComponent(sha)}`, {
            state: { type: chatflow.type, draftMode: Boolean(draftMode) }
        })
    }

    const confirmRollback = async () => {
        if (!rollbackTarget || !chatflow?.id || rollingBack) return
        setRollingBack(true)
        setRollbackError('')
        try {
            const res = await flowDraftsApi.rollback(chatflow.id, rollbackTarget.sha)
            setRollbackTarget(null)
            onRolledBack?.(res.data)
            setState((prev) => ({ ...prev, loading: true }))
            const list = await flowVersionsApi.listVersions(chatflow.id)
            setState({
                loading: false,
                versions: list.data?.versions || [],
                liveSha: list.data?.liveSha || null,
                lastError: list.data?.lastError || null,
                error: null
            })
        } catch (error) {
            setRollbackError(apiErrorMessage(error, 'Live could not be rolled back.'))
        } finally {
            setRollingBack(false)
        }
    }

    return (
        <Drawer
            anchor='right'
            open={open}
            onClose={onClose}
            PaperProps={{ sx: { width: { xs: '100%', sm: 380 } }, 'data-testid': 'version-history' }}
        >
            <Stack direction='row' alignItems='center' sx={{ px: 2, py: 1.5 }}>
                <Typography variant='h4' sx={{ flexGrow: 1 }}>
                    Version history
                </Typography>
                <IconButton aria-label='Close version history' onClick={onClose} size='small'>
                    <IconX size='1.1rem' />
                </IconButton>
            </Stack>
            <Divider />
            <Box sx={{ px: 2, py: 1.5 }}>
                <Typography variant='body2' color='text.secondary'>
                    {draftMode
                        ? 'Publishing and rolling back are kept here. Open a version to see what changed. Roll back changes what is live right away. Credentials are kept by name only.'
                        : 'Every save is kept. Open a version to see what changed. Credentials are kept by name only.'}
                </Typography>
            </Box>
            {isDirty && (
                <Alert severity='info' sx={{ mx: 2, mb: 1 }}>
                    You have unsaved changes. They show up here after you save.
                </Alert>
            )}
            {state.lastError && (
                <Alert severity='warning' sx={{ mx: 2, mb: 1 }}>
                    {state.lastError}
                </Alert>
            )}
            {state.error && (
                <Alert severity='error' sx={{ mx: 2, mb: 1 }}>
                    {state.error}
                </Alert>
            )}
            {state.loading && state.versions.length === 0 && (
                <Typography variant='body2' color='text.secondary' sx={{ px: 2 }}>
                    Loading versions…
                </Typography>
            )}
            {!state.loading && !state.error && state.versions.length === 0 && (
                <Typography variant='body2' color='text.secondary' sx={{ px: 2 }}>
                    No versions yet. Save the flow and it shows up here.
                </Typography>
            )}
            {people.length > 1 && (
                <Box sx={{ px: 2, pb: 1 }}>
                    <TextField
                        select
                        fullWidth
                        size='small'
                        label='Edited by'
                        value={activePerson}
                        onChange={(event) => setPerson(event.target.value)}
                        inputProps={{ 'aria-label': 'Filter versions by person' }}
                    >
                        <MenuItem value='all'>Everyone</MenuItem>
                        {people.map((option) => (
                            <MenuItem key={option.key} value={option.key}>
                                {option.label}
                            </MenuItem>
                        ))}
                    </TextField>
                </Box>
            )}
            {activePerson !== 'all' && shown.length === 0 && (
                <Typography variant='body2' color='text.secondary' sx={{ px: 2 }}>
                    No versions by this person.
                </Typography>
            )}
            <List dense sx={{ px: 1 }}>
                {shown.map((version) => (
                    <Box key={version.sha}>
                        <ListItemButton
                            key={version.sha}
                            onClick={() => openVersion(version.sha)}
                            sx={{ borderRadius: 1, alignItems: 'flex-start', mb: 0.5 }}
                            title={exactTime(version.date)}
                        >
                            <ListItemText
                                primary={
                                    <Stack direction='row' spacing={0.75} alignItems='center' flexWrap='wrap' useFlexGap>
                                        <Typography variant='subtitle1' component='span' sx={{ flexGrow: 1, wordBreak: 'break-word' }}>
                                            {version.title}
                                        </Typography>
                                        {versionMarkers(version, { liveSha: state.liveSha, currentSha, draftMode }).map((marker) =>
                                            marker === 'Current' ? (
                                                <Typography
                                                    key={marker}
                                                    variant='caption'
                                                    component='span'
                                                    sx={{ color: theme.palette.success.dark, fontWeight: 600, whiteSpace: 'nowrap' }}
                                                >
                                                    Current
                                                </Typography>
                                            ) : (
                                                <Chip
                                                    key={marker}
                                                    size='small'
                                                    label={marker}
                                                    color={marker === 'Live' ? 'success' : 'default'}
                                                    data-testid={marker === 'Live' ? 'version-live' : 'version-published'}
                                                />
                                            )
                                        )}
                                    </Stack>
                                }
                                secondary={
                                    <>
                                        <Box component='span' sx={{ display: 'block' }} data-author={authorKey(version)}>
                                            Edited by {authorLabel(version)}
                                        </Box>
                                        <Box component='span' sx={{ display: 'block' }}>
                                            {`${kindLabel(version.kind, version.title)} ${relativeTime(version.date)} · ${
                                                version.shortSha
                                            }`}
                                        </Box>
                                        {hiddenNote(version) && (
                                            <Box component='span' sx={{ display: 'block', color: theme.palette.warning.dark }}>
                                                {hiddenNote(version)}
                                            </Box>
                                        )}
                                    </>
                                }
                            />
                        </ListItemButton>
                        {draftMode && (
                            <Box sx={{ px: 2, pb: 1 }}>
                                <Button
                                    size='small'
                                    variant='text'
                                    data-testid='rollback-live'
                                    onClick={() => {
                                        setRollbackError('')
                                        setRollbackTarget(version)
                                    }}
                                >
                                    {rollbackLabel(compact)}
                                </Button>
                            </Box>
                        )}
                    </Box>
                ))}
            </List>
            <Dialog open={Boolean(rollbackTarget)} onClose={() => !rollingBack && setRollbackTarget(null)} maxWidth='xs' fullWidth>
                <DialogTitle sx={{ fontSize: '1.1rem' }}>Roll back Live?</DialogTitle>
                <DialogContent>
                    <Typography variant='body2'>
                        People using this flow will see &quot;{rollbackTarget?.title}&quot; right away. Your draft stays.
                    </Typography>
                    {rollbackError && (
                        <Alert severity='error' sx={{ mt: 1.5 }}>
                            {rollbackError}
                        </Alert>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setRollbackTarget(null)} disabled={rollingBack}>
                        Cancel
                    </Button>
                    <Button variant='contained' onClick={confirmRollback} disabled={rollingBack}>
                        {rollingBack ? 'Rolling back…' : 'Roll back Live'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Drawer>
    )
}

VersionHistoryDrawer.propTypes = {
    open: PropTypes.bool,
    chatflow: PropTypes.object,
    isDirty: PropTypes.bool,
    draftMode: PropTypes.bool,
    onClose: PropTypes.func,
    onRolledBack: PropTypes.func
}

export default VersionHistoryDrawer
