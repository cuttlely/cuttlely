import { useEffect, useMemo, useState } from 'react'
import PropTypes from 'prop-types'
import { useNavigate } from 'react-router-dom'

import { Alert, Box, Button, CircularProgress, MenuItem, Stack, TextField, Tooltip, Typography } from '@mui/material'
import { IconSparkles } from '@tabler/icons-react'

import credentialsApi from '@/api/credentials'
import demoApi from '@/api/demo'
import { StyledPermissionButton } from '@/ui-component/button/RBACButtons'
import { t } from '@/i18n'
import CredentialListDialog from '@/views/credentials/CredentialListDialog'
import AddEditCredentialDialog from '@/views/credentials/AddEditCredentialDialog'
import { useError } from '@/store/context/ErrorContext'
import { defaultKey, keyTypesForDemo, usableKeys } from '@/utils/tryTheDemo'

export const TRY_DEMO_KEY = 'cuttlely.dismissed.tryDemo'

const errorText = (error) => error?.response?.data?.message || error?.message || 'Something went wrong.'

// Opens the demo team with its chat open, so the starter questions are the first thing on screen.
export const openDemo = (navigate, id) => navigate(`/harnesscanvas/${id}`, { state: { openChat: true } })

const TryTheDemo = ({ show }) => {
    const navigate = useNavigate()
    const { setError } = useError()
    const [dismissed, setDismissed] = useState(() => localStorage.getItem(TRY_DEMO_KEY) === '1')
    const [status, setStatus] = useState(null)
    const [keys, setKeys] = useState([])
    const [types, setTypes] = useState([])
    const [picked, setPicked] = useState('')
    const [busy, setBusy] = useState(false)
    const [problem, setProblem] = useState('')
    const [listOpen, setListOpen] = useState(false)
    const [addProps, setAddProps] = useState(null)

    const load = async (added) => {
        try {
            const [demo, credentials, components] = await Promise.all([
                demoApi.getDemo(),
                credentialsApi.getAllCredentials(),
                credentialsApi.getAllComponentsCredentials()
            ])
            const names = demo.data?.credentialNames || []
            const usable = usableKeys(credentials.data || [], names)
            setStatus(demo.data)
            setKeys(usable)
            setTypes(keyTypesForDemo(components.data || [], names))
            setPicked((current) => (current && usable.some((key) => key.id === current) ? current : defaultKey(usable, added)))
        } catch (error) {
            setProblem(errorText(error))
        }
    }

    useEffect(() => {
        if (show && !dismissed) load()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [show, dismissed])

    const labels = useMemo(() => Object.fromEntries(types.map((type) => [type.name, type.label])), [types])

    if (!show || dismissed || !status) return null

    const hide = () => {
        localStorage.setItem(TRY_DEMO_KEY, '1')
        setDismissed(true)
    }

    const needsKey = !busy && !status.demo && !picked

    const start = async () => {
        if (status.demo) return openDemo(navigate, status.demo.id)
        setBusy(true)
        setProblem('')
        try {
            const made = await demoApi.createDemo(picked)
            openDemo(navigate, made.data.id)
        } catch (error) {
            setProblem(errorText(error))
            setBusy(false)
        }
    }

    return (
        <Box
            id='try-the-demo'
            sx={{ border: 1, borderColor: 'primary.main', borderRadius: 2, px: 2, py: 1.75, backgroundColor: 'action.hover' }}
        >
            <Stack direction='row' alignItems='flex-start' justifyContent='space-between' sx={{ gap: 1 }}>
                <Stack direction='row' alignItems='center' sx={{ gap: 1 }}>
                    <IconSparkles size={20} />
                    <Typography variant='subtitle1' sx={{ fontWeight: 600 }}>
                        Try the demo
                    </Typography>
                </Stack>
                <Button size='small' onClick={hide} sx={{ textTransform: 'none', flexShrink: 0 }}>
                    Hide
                </Button>
            </Stack>
            <Typography variant='body2' sx={{ mt: 0.5, mb: 1.5, maxWidth: 760 }}>
                {status.demo
                    ? 'Your bakery demo team is ready. Open it and pick a starter question.'
                    : 'See an agent team at work on a made-up bakery: a sales analyst that queries a small database and draws charts, and a librarian that searches the shop handbook. Bring one model key. Everything else is included.'}
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'center' }} sx={{ gap: 1, flexWrap: 'wrap' }}>
                {!status.demo && keys.length > 0 && (
                    <TextField
                        select
                        size='small'
                        label='Model key'
                        value={picked}
                        onChange={(event) => setPicked(event.target.value)}
                        sx={{ minWidth: 260 }}
                        disabled={busy}
                    >
                        {keys.map((key) => (
                            <MenuItem key={key.id} value={key.id}>
                                {key.name} ({labels[key.credentialName] || key.credentialName})
                            </MenuItem>
                        ))}
                    </TextField>
                )}
                {!status.demo && (
                    <Button
                        variant={keys.length ? 'text' : 'outlined'}
                        onClick={() => setListOpen(true)}
                        disabled={busy}
                        sx={{ textTransform: 'none' }}
                    >
                        {keys.length ? 'Add another key' : 'Add a model key'}
                    </Button>
                )}
                <Tooltip title={needsKey ? t('demo.needsKey') : ''} placement='top'>
                    <Box component='span' tabIndex={needsKey ? 0 : undefined} sx={{ display: 'inline-flex', borderRadius: 1 }}>
                        <StyledPermissionButton
                            permissionId={'chatflows:create'}
                            variant='contained'
                            onClick={start}
                            disabled={busy || needsKey}
                            startIcon={busy ? <CircularProgress size={16} color='inherit' /> : null}
                            sx={{ textTransform: 'none', fontWeight: 600, boxShadow: 'none' }}
                        >
                            {status.demo ? 'Open the demo' : busy ? 'Setting up the bakery team' : 'Try the demo'}
                        </StyledPermissionButton>
                    </Box>
                </Tooltip>
            </Stack>
            {problem && (
                <Alert severity='warning' sx={{ mt: 1.5 }}>
                    {problem}
                </Alert>
            )}
            <CredentialListDialog
                show={listOpen}
                dialogProps={{ title: 'Add a model key', componentsCredentials: types }}
                onCancel={() => setListOpen(false)}
                onCredentialSelected={(credentialComponent) => {
                    setListOpen(false)
                    setAddProps({ type: 'ADD', cancelButtonName: 'Cancel', confirmButtonName: 'Add', credentialComponent })
                }}
            />
            {addProps && (
                <AddEditCredentialDialog
                    show={Boolean(addProps)}
                    dialogProps={addProps}
                    onCancel={() => setAddProps(null)}
                    onConfirm={(id) => {
                        setAddProps(null)
                        load(id)
                    }}
                    setError={setError}
                />
            )}
        </Box>
    )
}

TryTheDemo.propTypes = {
    show: PropTypes.bool
}

export default TryTheDemo
