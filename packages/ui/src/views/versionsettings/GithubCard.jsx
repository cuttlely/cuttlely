// The GitHub card: keep a copy of every version in GitHub, with a live status, and the Dev or Prod label
// for this server. Shown on Version History and as the optional GitHub step of first-run setup.
// For the organization owner only.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { Link as RouterLink } from 'react-router-dom'
import {
    Alert,
    Box,
    Button,
    Card,
    CardContent,
    Chip,
    CircularProgress,
    Collapse,
    Divider,
    InputAdornment,
    Link,
    List,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    MenuItem,
    Radio,
    Stack,
    TextField,
    ToggleButton,
    ToggleButtonGroup,
    Typography
} from '@mui/material'
import { keyframes } from '@mui/system'
import {
    IconAlertTriangle,
    IconBrandGithub,
    IconCheck,
    IconExternalLink,
    IconLock,
    IconPlus,
    IconRefresh,
    IconRocket,
    IconSearch,
    IconWorld
} from '@tabler/icons-react'

import flowVersionsApi from '@/api/flowVersions'
import credentialsApi from '@/api/credentials'
import {
    DEFAULT_REPO_NAME,
    NEW_TOKEN,
    environmentHint,
    environmentSwitchNote,
    listUnreadable,
    repairListBody,
    UNREADABLE_LIST,
    ownCredentials,
    checkRepoName,
    filterRepos,
    pollMs,
    statusChip,
    syncLine,
    timeAgo,
    tokenCreateUrl,
    tokenHint
} from '@/utils/githubSync'
import GithubTokenHelp from './GithubTokenHelp'
import {
    incomingSummary,
    isSavedDevProdPair,
    previousEnvironmentTitle,
    promotePath,
    readIntro,
    readLine,
    sourceTitleOf
} from '@/utils/promote'

const pop = keyframes`
  0% { transform: scale(0.4); opacity: 0; }
  60% { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
`
const draw = keyframes`
  from { stroke-dashoffset: 24; }
  to { stroke-dashoffset: 0; }
`

const messageOf = (error) => error?.response?.data?.message || error?.message || 'Something went wrong. Try again.'

// The round green check that pops in when everything is synced.
const SyncedCheck = ({ play }) => (
    <Box
        aria-hidden
        sx={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            bgcolor: 'success.main',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            animation: play ? `${pop} 420ms ease-out` : 'none',
            '& path': { strokeDasharray: 24, animation: play ? `${draw} 420ms 160ms ease-out both` : 'none' }
        }}
    >
        <IconCheck size={18} stroke={3} />
    </Box>
)

const StatusIcon = ({ status, play }) => {
    const tone = statusChip(status).tone
    if (tone === 'ok') return <SyncedCheck play={play} />
    if (tone === 'busy') return <CircularProgress size={24} thickness={5} />
    if (tone === 'warn' || tone === 'error')
        return (
            <Box sx={{ color: tone === 'warn' ? 'warning.main' : 'error.main', display: 'grid', placeItems: 'center' }}>
                <IconAlertTriangle size={26} />
            </Box>
        )
    return null
}

const RepoRow = ({ item, selected, onSelect }) => (
    <ListItemButton selected={selected} onClick={onSelect} sx={{ borderRadius: 2, py: 0.75 }}>
        <ListItemIcon sx={{ minWidth: 36 }}>
            <Radio edge='start' size='small' checked={selected} tabIndex={-1} disableRipple />
        </ListItemIcon>
        <ListItemText
            primary={
                <Stack direction='row' spacing={1} alignItems='center'>
                    {item.private ? <IconLock size={14} /> : <IconWorld size={14} />}
                    <span>{item.repo}</span>
                    {item.empty && <Chip label='Empty' size='small' color='success' variant='outlined' sx={{ height: 20 }} />}
                </Stack>
            }
        />
    </ListItemButton>
)

SyncedCheck.propTypes = { play: PropTypes.bool }
StatusIcon.propTypes = { status: PropTypes.object, play: PropTypes.bool }
RepoRow.propTypes = {
    item: PropTypes.shape({ repo: PropTypes.string, private: PropTypes.bool, empty: PropTypes.bool }).isRequired,
    selected: PropTypes.bool,
    onSelect: PropTypes.func
}

// The "make a new repository" row in the picker.
const NEW_REPO = '__new_repo__'

// What loadRepos selects. A server with a previous environment starts with nothing picked.
export const repoPickAfterLoad = (repos, joinsExisting) => {
    if (joinsExisting) return ''
    const list = repos || []
    const firstEmpty = list.find((item) => item.empty)
    if (firstEmpty) return firstEmpty.repo
    return list.length ? '' : NEW_REPO
}

// onStatus hears every status the card loads or gets back, so a page around it can follow along.
const GithubCard = ({ onStatus, initialStatus = null, initialStep = 'idle' }) => {
    const [status, setStatus] = useState(initialStatus)
    const [loadError, setLoadError] = useState('')
    const [busy, setBusy] = useState('')
    const [error, setError] = useState('')
    const [step, setStep] = useState(initialStep) // idle, token, repo
    const [savedTokens, setSavedTokens] = useState([])
    const [tokenChoice, setTokenChoice] = useState(NEW_TOKEN)
    const [token, setToken] = useState('')
    const [account, setAccount] = useState('')
    const [repos, setRepos] = useState([])
    const [query, setQuery] = useState('')
    const [picked, setPicked] = useState('')
    const [newName, setNewName] = useState(DEFAULT_REPO_NAME)
    const [play, setPlay] = useState(false)
    const lastState = useRef(null)

    const load = useCallback(async () => {
        try {
            const res = await flowVersionsApi.getGithub()
            setStatus(res.data)
            setLoadError('')
        } catch (err) {
            setLoadError(messageOf(err))
        }
    }, [])

    useEffect(() => {
        load()
    }, [load])

    useEffect(() => {
        if (status && onStatus) onStatus(status)
    }, [status, onStatus])

    // Poll while the page is open, faster while syncing.
    useEffect(() => {
        if (!status) return undefined
        const timer = setTimeout(load, pollMs(status))
        return () => clearTimeout(timer)
    }, [status, load])

    // Play the check when the status turns up to date.
    useEffect(() => {
        const state = status?.state
        if (state === 'up-to-date' && lastState.current && lastState.current !== 'up-to-date') {
            setPlay(false)
            requestAnimationFrame(() => setPlay(true))
        }
        if (state === 'up-to-date' && lastState.current === null) setPlay(true)
        lastState.current = state || null
    }, [status?.state])

    const chip = statusChip(status)
    const connected = Boolean(status?.connected)
    // Prod only reads the repository: new versions from Dev arrive there to promote.
    const reading = status?.role === 'read'
    const reviews = reading || Boolean(status?.promotes)
    const [incoming, setIncoming] = useState(null)
    useEffect(() => {
        if (!reviews || !connected) {
            setIncoming(null)
            return undefined
        }
        let cancelled = false
        flowVersionsApi
            .listIncoming()
            .then((res) => !cancelled && setIncoming(res.data || null))
            .catch(() => !cancelled && setIncoming(null))
        return () => {
            cancelled = true
        }
    }, [reviews, connected, status?.incomingVersion, status?.lastCheckedAt])
    const incomingFlows = incoming?.flows || []
    const sourceTitle = sourceTitleOf(incoming)
    const readsFrom = previousEnvironmentTitle(status)
    // Any server with a previous environment reads that repository, including one that also copies.
    const joinsExisting = Boolean(status?.promotes)
    const tokenBody = tokenChoice === NEW_TOKEN ? { token } : { credentialId: tokenChoice }
    const shown = useMemo(() => filterRepos(repos, query), [repos, query])

    const startConnect = async () => {
        setError('')
        setStep('token')
        try {
            const res = await credentialsApi.getCredentialsByName('githubApi')
            // Only this workspace's own GitHub credentials: the copy reads the credential from this workspace.
            const list = ownCredentials(res.data)
            setSavedTokens(list)
            setTokenChoice(list.length ? list[0].id : NEW_TOKEN)
        } catch {
            setSavedTokens([])
            setTokenChoice(NEW_TOKEN)
        }
    }

    const cancel = () => {
        setStep('idle')
        setToken('')
        setRepos([])
        setPicked('')
        setError('')
    }

    const loadRepos = async () => {
        setBusy('repos')
        setError('')
        try {
            const res = await flowVersionsApi.listGithubRepos(tokenBody)
            setAccount(res.data.account)
            setRepos(res.data.repos || [])
            // A server with a previous environment uses that repository. Nothing is preselected, and a new one is never offered.
            setPicked(repoPickAfterLoad(res.data.repos, joinsExisting))
            setStep('repo')
        } catch (err) {
            setError(messageOf(err))
        } finally {
            setBusy('')
        }
    }

    const connect = async () => {
        setBusy('connect')
        setError('')
        try {
            let repo = picked
            if (joinsExisting && picked === NEW_REPO) {
                setError(`Pick the repository your ${readsFrom} server copies to.`)
                return
            }
            if (picked === NEW_REPO) {
                const checked = checkRepoName(newName)
                if (checked.error) {
                    setError(checked.error)
                    return
                }
                const made = await flowVersionsApi.createGithubRepo({ ...tokenBody, name: checked.name })
                repo = made.data.repo
                // It exists now: if connecting fails, Connect again retries the connection, not the create.
                const created = { repo, private: true, empty: true, pushedAt: null }
                setRepos((list) => [created, ...list.filter((r) => r.repo !== repo)])
                setPicked(repo)
            }
            const res = await flowVersionsApi.connectGithub({ ...tokenBody, repo })
            setStatus(res.data)
            setStep('idle')
            setToken('')
        } catch (err) {
            setError(messageOf(err))
        } finally {
            setBusy('')
        }
    }

    const syncNow = async () => {
        setBusy('sync')
        setError('')
        try {
            setStatus({ ...status, state: 'copying' })
            const res = await flowVersionsApi.syncGithub()
            setStatus(res.data)
        } catch (err) {
            setError(messageOf(err))
            load()
        } finally {
            setBusy('')
        }
    }

    const disconnect = async () => {
        setBusy('disconnect')
        setError('')
        try {
            const res = await flowVersionsApi.disconnectGithub()
            setStatus(res.data)
        } catch (err) {
            setError(messageOf(err))
        } finally {
            setBusy('')
        }
    }

    const [repairRows, setRepairRows] = useState([
        { name: 'Dev', branch: 'main', server: 'dev' },
        { name: 'Prod', branch: 'main', server: 'prod' }
    ])
    const unreadable = listUnreadable(status)

    const changeEnvironment = async (_event, value) => {
        if (value === null || value === undefined) return
        setError('')
        try {
            const res = await flowVersionsApi.setEnvironment(value || null)
            setStatus(res.data)
        } catch (err) {
            setError(messageOf(err))
        }
    }

    const saveRepair = async () => {
        setError('')
        try {
            const body = repairListBody(repairRows, null)
            const res = await flowVersionsApi.setEnvironment(body.environment, body.environments)
            setStatus(res.data)
        } catch (err) {
            setError(messageOf(err))
        }
    }

    const editRepair = (index, field) => (event) => {
        const value = event.target.value
        setRepairRows((rows) => rows.map((row, at) => (at === index ? { ...row, [field]: value } : row)))
    }

    return (
        <>
            {loadError && <Alert severity='error'>{loadError}</Alert>}
            {status && (
                <Card variant='outlined' sx={{ borderRadius: 3, maxWidth: 760 }}>
                    <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
                        <Stack direction='row' spacing={2} alignItems='center'>
                            <Box
                                sx={{
                                    width: 44,
                                    height: 44,
                                    borderRadius: 2,
                                    bgcolor: 'text.primary',
                                    color: 'background.paper',
                                    display: 'grid',
                                    placeItems: 'center'
                                }}
                            >
                                <IconBrandGithub size={26} />
                            </Box>
                            <Box sx={{ flex: 1 }}>
                                <Typography variant='h4'>GitHub</Typography>
                                <Typography variant='body2' color='text.secondary'>
                                    {reading ? readIntro(status) : 'Keep a copy of every version in your own GitHub repository.'}
                                </Typography>
                            </Box>
                            <Chip label={chip.label} color={chip.color} variant={connected ? 'filled' : 'outlined'} />
                        </Stack>

                        <Divider sx={{ my: 2.5 }} />

                        {status.state === 'off' && (
                            <Typography color='text.secondary'>
                                Version history is off on this server, so there is nothing to keep in GitHub.
                            </Typography>
                        )}

                        {status.state !== 'off' && connected && (
                            <Stack spacing={2}>
                                <Stack direction='row' spacing={2} alignItems='center'>
                                    <StatusIcon status={status} play={play} />
                                    <Box sx={{ flex: 1 }}>
                                        <Typography variant='h5'>
                                            {'Connected to '}
                                            {status.url ? (
                                                <Link href={status.url} target='_blank' rel='noopener' underline='hover'>
                                                    {status.repo} <IconExternalLink size={14} style={{ verticalAlign: 'middle' }} />
                                                </Link>
                                            ) : (
                                                status.repo
                                            )}
                                        </Typography>
                                        <Typography variant='body2' color='text.secondary'>
                                            {(reading ? readLine(status, (iso) => timeAgo(iso)) : syncLine(status)) || status.message}
                                        </Typography>
                                    </Box>
                                </Stack>
                                {(status.state === 'retrying' || status.state === 'stopped') && (
                                    <Alert severity={status.state === 'retrying' ? 'warning' : 'error'}>{status.message}</Alert>
                                )}
                                <Typography variant='caption' color='text.secondary'>
                                    Signed in with the credential{' '}
                                    <Link component={RouterLink} to='/credentials'>
                                        {status.credential?.name || 'GitHub'}
                                    </Link>
                                    .{' '}
                                    {reading
                                        ? 'This server only reads the repository. Live flows never wait for GitHub.'
                                        : 'Publishing never waits for GitHub.'}
                                </Typography>
                                {reviews && incoming && (
                                    <Box
                                        data-testid='card-incoming'
                                        sx={{
                                            p: 1.5,
                                            borderRadius: 2,
                                            bgcolor: incomingFlows.length ? 'primary.light' : 'action.hover',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 1.5
                                        }}
                                    >
                                        {incomingFlows.length ? <IconRocket size={22} /> : <IconCheck size={22} />}
                                        <Typography variant='body2' sx={{ flex: 1, fontWeight: incomingFlows.length ? 600 : 400 }}>
                                            {incomingFlows.length
                                                ? incomingSummary(incomingFlows, sourceTitle)
                                                : sourceTitle === 'Dev'
                                                ? 'Everything from Dev is Live here.'
                                                : `Everything from ${sourceTitle} is Live here.`}
                                        </Typography>
                                        <Button
                                            size='small'
                                            variant={incomingFlows.length ? 'contained' : 'text'}
                                            component={RouterLink}
                                            to={promotePath()}
                                        >
                                            {incomingFlows.length ? 'Review' : 'Open'}
                                        </Button>
                                    </Box>
                                )}
                                <Stack direction='row' spacing={1}>
                                    <Button
                                        variant='contained'
                                        startIcon={
                                            busy === 'sync' ? <CircularProgress size={16} color='inherit' /> : <IconRefresh size={18} />
                                        }
                                        disabled={Boolean(busy)}
                                        onClick={syncNow}
                                    >
                                        {status.state === 'retrying' || status.state === 'stopped'
                                            ? 'Try again'
                                            : reading
                                            ? 'Look now'
                                            : 'Sync now'}
                                    </Button>
                                    <Button color='inherit' disabled={Boolean(busy)} onClick={disconnect}>
                                        Disconnect
                                    </Button>
                                </Stack>
                            </Stack>
                        )}

                        {status.state !== 'off' && !connected && step === 'idle' && (
                            <Stack spacing={2} alignItems='flex-start'>
                                {status.state === 'stopped' && <Alert severity='error'>{status.message}</Alert>}
                                <Typography color='text.secondary'>
                                    {joinsExisting
                                        ? `Connect the repository your ${readsFrom} server copies to. New versions from ${readsFrom} show up here, and nothing goes Live until you promote it.`
                                        : 'Your history always stays on this server. Connect GitHub to keep a second copy there, updated a few seconds after each change. Keys are never copied: credentials go by name only.'}
                                </Typography>
                                <Button variant='contained' size='large' startIcon={<IconBrandGithub size={20} />} onClick={startConnect}>
                                    Connect GitHub
                                </Button>
                            </Stack>
                        )}

                        {status.state !== 'off' && !connected && step === 'token' && (
                            <Stack spacing={2}>
                                <Typography variant='h5'>1. Sign in to GitHub</Typography>
                                {savedTokens.length > 0 && (
                                    <TextField
                                        select
                                        label='GitHub sign-in'
                                        value={tokenChoice}
                                        onChange={(e) => setTokenChoice(e.target.value)}
                                        size='small'
                                    >
                                        {savedTokens.map((c) => (
                                            <MenuItem key={c.id} value={c.id}>
                                                {c.name}
                                            </MenuItem>
                                        ))}
                                        <MenuItem value={NEW_TOKEN}>Paste a new token</MenuItem>
                                    </TextField>
                                )}
                                <Collapse in={tokenChoice === NEW_TOKEN} unmountOnExit>
                                    <Stack spacing={1}>
                                        <TextField
                                            label='GitHub token'
                                            type='password'
                                            autoComplete='off'
                                            value={token}
                                            onChange={(e) => setToken(e.target.value)}
                                            size='small'
                                            fullWidth
                                            InputProps={{
                                                endAdornment: (
                                                    <InputAdornment position='end'>
                                                        <GithubTokenHelp reading={reading} from={joinsExisting ? readsFrom : ''} />
                                                    </InputAdornment>
                                                )
                                            }}
                                        />
                                        <Typography variant='caption' color='text.secondary' data-testid='github-token-hint'>
                                            {tokenHint(reading)}{' '}
                                            <Link
                                                href={tokenCreateUrl(reading)}
                                                target='_blank'
                                                rel='noopener noreferrer'
                                                sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, whiteSpace: 'nowrap' }}
                                            >
                                                Create a token on GitHub
                                                <IconExternalLink size={12} />
                                            </Link>
                                        </Typography>
                                    </Stack>
                                </Collapse>
                                {error && <Alert severity='error'>{error}</Alert>}
                                <Stack direction='row' spacing={1}>
                                    <Button
                                        variant='contained'
                                        onClick={loadRepos}
                                        disabled={Boolean(busy) || (tokenChoice === NEW_TOKEN && !token.trim())}
                                        startIcon={busy === 'repos' ? <CircularProgress size={16} color='inherit' /> : null}
                                    >
                                        Continue
                                    </Button>
                                    <Button color='inherit' onClick={cancel}>
                                        Cancel
                                    </Button>
                                </Stack>
                            </Stack>
                        )}

                        {status.state !== 'off' && !connected && step === 'repo' && (
                            <Stack spacing={2}>
                                <Typography variant='h5'>2. Pick where to keep it</Typography>
                                <Typography variant='body2' color='text.secondary'>
                                    {joinsExisting
                                        ? `Signed in as ${account}. Pick the repository your ${readsFrom} server copies to.`
                                        : `Signed in as ${account}. Pick an empty repository, or make a new private one.`}
                                </Typography>
                                {repos.length > 6 && (
                                    <TextField
                                        size='small'
                                        placeholder='Search repositories'
                                        value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                        InputProps={{
                                            startAdornment: (
                                                <InputAdornment position='start'>
                                                    <IconSearch size={16} />
                                                </InputAdornment>
                                            )
                                        }}
                                    />
                                )}
                                <List
                                    dense
                                    sx={{
                                        maxHeight: 260,
                                        overflow: 'auto',
                                        border: 1,
                                        borderColor: 'divider',
                                        borderRadius: 2,
                                        p: 0.5
                                    }}
                                >
                                    {shown.map((item) => (
                                        <RepoRow
                                            key={item.repo}
                                            item={item}
                                            selected={picked === item.repo}
                                            onSelect={() => setPicked(item.repo)}
                                        />
                                    ))}
                                    {!joinsExisting && (
                                        <ListItemButton
                                            selected={picked === NEW_REPO}
                                            onClick={() => setPicked(NEW_REPO)}
                                            sx={{ borderRadius: 2, py: 0.75 }}
                                        >
                                            <ListItemIcon sx={{ minWidth: 36 }}>
                                                <Radio
                                                    edge='start'
                                                    size='small'
                                                    checked={picked === NEW_REPO}
                                                    tabIndex={-1}
                                                    disableRipple
                                                />
                                            </ListItemIcon>
                                            <ListItemText
                                                primary={
                                                    <Stack direction='row' spacing={1} alignItems='center'>
                                                        <IconPlus size={14} />
                                                        <span>Make a new private repository</span>
                                                    </Stack>
                                                }
                                            />
                                        </ListItemButton>
                                    )}
                                </List>
                                <Collapse in={picked === NEW_REPO} unmountOnExit>
                                    <TextField
                                        size='small'
                                        label='New repository name'
                                        value={newName}
                                        onChange={(e) => setNewName(e.target.value)}
                                        InputProps={{ startAdornment: <InputAdornment position='start'>{account}/</InputAdornment> }}
                                    />
                                </Collapse>
                                {error && <Alert severity='error'>{error}</Alert>}
                                <Stack direction='row' spacing={1}>
                                    <Button
                                        variant='contained'
                                        onClick={connect}
                                        disabled={Boolean(busy) || !picked}
                                        startIcon={
                                            busy === 'connect' ? (
                                                <CircularProgress size={16} color='inherit' />
                                            ) : (
                                                <IconBrandGithub size={18} />
                                            )
                                        }
                                    >
                                        Connect
                                    </Button>
                                    <Button color='inherit' onClick={() => setStep('token')}>
                                        Back
                                    </Button>
                                </Stack>
                            </Stack>
                        )}

                        {step === 'idle' && error && (
                            <Alert severity='error' sx={{ mt: 2 }}>
                                {error}
                            </Alert>
                        )}

                        {status.state !== 'off' && (
                            <>
                                <Divider sx={{ my: 2.5 }} />
                                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
                                    <Box sx={{ flex: 1 }}>
                                        <Typography variant='h5'>This server is</Typography>
                                        <Typography variant='caption' color='text.secondary'>
                                            {unreadable ? UNREADABLE_LIST : environmentHint(status.environments)}
                                        </Typography>
                                        {connected && !unreadable && (
                                            <Typography variant='caption' color='text.secondary' sx={{ display: 'block' }}>
                                                {environmentSwitchNote(status)}
                                            </Typography>
                                        )}
                                    </Box>
                                    {unreadable ? (
                                        <Stack spacing={1} data-testid='environment-repair' sx={{ minWidth: { sm: 360 } }}>
                                            {repairRows.map((row, index) => (
                                                <Stack key={index} direction='row' spacing={1}>
                                                    <TextField
                                                        size='small'
                                                        label='Name'
                                                        value={row.name}
                                                        onChange={editRepair(index, 'name')}
                                                        inputProps={{ 'data-testid': `repair-name-${index}` }}
                                                    />
                                                    <TextField
                                                        size='small'
                                                        label='Server'
                                                        value={row.server}
                                                        onChange={editRepair(index, 'server')}
                                                        inputProps={{ 'data-testid': `repair-server-${index}` }}
                                                    />
                                                    <TextField
                                                        size='small'
                                                        label='Copies to'
                                                        value={row.branch}
                                                        onChange={editRepair(index, 'branch')}
                                                        inputProps={{ 'data-testid': `repair-copy-${index}` }}
                                                    />
                                                </Stack>
                                            ))}
                                            <Button
                                                size='small'
                                                onClick={() => setRepairRows((rows) => [...rows, { name: '', branch: '', server: '' }])}
                                            >
                                                Add an environment
                                            </Button>
                                            <Button
                                                size='small'
                                                variant='contained'
                                                data-testid='save-environment-list'
                                                onClick={saveRepair}
                                            >
                                                Save the list
                                            </Button>
                                        </Stack>
                                    ) : (
                                        <ToggleButtonGroup
                                            exclusive
                                            size='small'
                                            value={status.environment || ''}
                                            onChange={changeEnvironment}
                                            aria-label={
                                                isSavedDevProdPair(status.environments) ? 'This server is Dev or Prod' : 'This server is'
                                            }
                                        >
                                            {isSavedDevProdPair(status.environments)
                                                ? [
                                                      <ToggleButton key='dev' value='dev' sx={{ px: 2.5 }}>
                                                          Dev
                                                      </ToggleButton>,
                                                      <ToggleButton key='prod' value='prod' sx={{ px: 2.5 }}>
                                                          Prod
                                                      </ToggleButton>
                                                  ]
                                                : (status.environments || []).map((env) => (
                                                      <ToggleButton key={env.server} value={env.server} sx={{ px: 2.5 }}>
                                                          {env.name}
                                                      </ToggleButton>
                                                  ))}
                                            <ToggleButton value='' sx={{ px: 2 }}>
                                                Not set
                                            </ToggleButton>
                                        </ToggleButtonGroup>
                                    )}
                                </Stack>
                            </>
                        )}
                    </CardContent>
                </Card>
            )}
        </>
    )
}

GithubCard.propTypes = { onStatus: PropTypes.func, initialStatus: PropTypes.object, initialStep: PropTypes.string }

export default GithubCard
