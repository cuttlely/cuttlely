// What the promote pages show, from plain props, so they render in tests without a server.
// No Git words on screen: versions arrive from Dev and are promoted.
import PropTypes from 'prop-types'
import { Link as RouterLink } from 'react-router-dom'
import { Alert, Avatar, Box, Button, Card, CardActionArea, CardContent, Chip, CircularProgress, Stack, Typography } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { keyframes } from '@mui/system'
import {
    IconArrowBackUp,
    IconArrowLeft,
    IconArrowRight,
    IconCheck,
    IconKey,
    IconPencil,
    IconRefresh,
    IconRocket,
    IconSparkles
} from '@tabler/icons-react'

import { CHANGE_COLORS, describeDiff, relativeTime } from '@/utils/versionHistory'
import {
    CREDENTIALS_PATH,
    DRAFT_NOTE,
    MISSING_TITLE,
    NEW_FLOW_NOTE,
    changesLine,
    credentialText,
    historyNote,
    howItWorks,
    incomingLabel,
    incomingSummary,
    missingIntro,
    promotePath,
    promotedMessage,
    previousEnvironmentTitle,
    showEnvironmentChain,
    sourceTitleOf
} from '@/utils/promote'

const LINE_COLORS = { added: CHANGE_COLORS.added, changed: CHANGE_COLORS.changed, removed: '#c62828', moved: '#757575' }

const pop = keyframes`
  0% { transform: scale(0.4); opacity: 0; }
  60% { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
`

const Dot = ({ color }) => <Box sx={{ mt: '7px', width: 9, height: 9, borderRadius: '50%', flexShrink: 0, bgcolor: color }} />
Dot.propTypes = { color: PropTypes.string }

const Section = ({ title, children, testId }) => (
    <Box data-testid={testId}>
        <Typography variant='overline' color='text.secondary' sx={{ letterSpacing: 1, fontWeight: 700 }}>
            {title}
        </Typography>
        <Box sx={{ mt: 0.5 }}>{children}</Box>
    </Box>
)
Section.propTypes = { title: PropTypes.string, children: PropTypes.node, testId: PropTypes.string }

const byLine = (version, now) =>
    [version?.author ? `by ${version.author}` : '', version?.date ? relativeTime(version.date, now) : ''].filter(Boolean).join(' · ')

// One flow with a new version from Dev, as a card on the list.
export const IncomingCard = ({ flow, now, sourceTitle = 'Dev' }) => {
    const theme = useTheme()
    const isNew = flow.status === 'new'
    return (
        <Card
            variant='outlined'
            data-testid='incoming-flow'
            sx={{ borderRadius: 2, transition: 'box-shadow .2s', '&:hover': { boxShadow: 3 } }}
        >
            <CardActionArea component={RouterLink} to={promotePath(flow.flowId)} aria-label={`Review ${flow.name}`}>
                <CardContent>
                    <Stack direction='row' spacing={2} alignItems='center'>
                        <Avatar
                            sx={{
                                bgcolor: alpha(theme.palette.primary.main, 0.12),
                                color: theme.palette.primary.main,
                                width: 44,
                                height: 44
                            }}
                        >
                            {isNew ? <IconSparkles size={22} /> : <IconRocket size={22} />}
                        </Avatar>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
                                <Typography variant='h5' noWrap>
                                    {flow.name}
                                </Typography>
                                <Chip size='small' color={isNew ? 'secondary' : 'primary'} label={incomingLabel(flow, sourceTitle)} />
                                {flow.hasDraft && (
                                    <Chip
                                        size='small'
                                        variant='outlined'
                                        icon={<IconPencil size={14} />}
                                        label='Unpublished changes here'
                                    />
                                )}
                            </Stack>
                            <Typography variant='body2' sx={{ mt: 0.5 }} noWrap>
                                {flow.version?.title}
                            </Typography>
                            <Typography variant='caption' color='text.secondary'>
                                {[byLine(flow.version, now), changesLine(flow, sourceTitle)].filter(Boolean).join(' · ')}
                            </Typography>
                        </Box>
                        <IconArrowRight size={20} color={theme.palette.text.secondary} />
                    </Stack>
                </CardContent>
            </CardActionArea>
        </Card>
    )
}
IncomingCard.propTypes = { flow: PropTypes.object.isRequired, now: PropTypes.number, sourceTitle: PropTypes.string }

// The list: every flow with a new version from Dev.
export const PromoteListView = ({ list, status, loading, error, checking, onCheckNow, now, timeAgo }) => {
    const theme = useTheme()
    const flows = list?.flows || []
    const sourceTitle = list ? sourceTitleOf(list) : previousEnvironmentTitle(status)
    const chain = showEnvironmentChain(list)
    if (loading) {
        return (
            <Stack direction='row' spacing={1} alignItems='center' sx={{ py: 4 }}>
                <CircularProgress size={18} />
                <Typography color='text.secondary'>Looking for new versions from {sourceTitle}…</Typography>
            </Stack>
        )
    }
    if (error) return <Alert severity='error'>{error}</Alert>
    if (list && !list.enabled) {
        const chain = list.environments || []
        const first = chain.length >= 2 && chain[0].server === list.target
        if (first) {
            return (
                <Alert severity='info' data-testid='promote-not-prod'>
                    This server is first in the list, so it does not promote. The next environment promotes what this server publishes.
                </Alert>
            )
        }
        return (
            <Alert severity='info' data-testid='promote-not-prod'>
                Promoting works on a server that has a previous environment. Connect it to the repository the previous environment publishes
                to, on the <RouterLink to='/version-history'>Version History</RouterLink> page.
            </Alert>
        )
    }
    if (list && !list.connected) {
        return (
            <Alert severity='info' data-testid='promote-not-connected'>
                Connect this server to the repository your {sourceTitle} server copies to, on the{' '}
                <RouterLink to='/version-history'>Version History</RouterLink> page. New versions from {sourceTitle} show up here.
            </Alert>
        )
    }
    return (
        <Stack spacing={2}>
            {chain && (
                <Stack spacing={1}>
                    <Stack direction='row' spacing={1} alignItems='center' data-testid='environment-chain' flexWrap='wrap' useFlexGap>
                        {(list.environments || []).map((env, index) => (
                            <Box key={env.server} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                {index > 0 ? <IconArrowRight size={16} /> : null}
                                <Chip
                                    size='small'
                                    label={env.name}
                                    color={env.server === list.target ? 'primary' : 'default'}
                                    variant={env.server === list.target ? 'filled' : 'outlined'}
                                />
                            </Box>
                        ))}
                    </Stack>
                    <Typography variant='body2' data-testid='promote-next'>
                        Promote moves a version to the next environment.
                    </Typography>
                </Stack>
            )}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} justifyContent='space-between'>
                <Typography variant='body2' color='text.secondary' sx={{ maxWidth: 680 }}>
                    {howItWorks(list)}
                </Typography>
                <Stack direction='row' spacing={1} alignItems='center' sx={{ flexShrink: 0 }}>
                    {status?.lastCheckedAt && (
                        <Typography variant='caption' color='text.secondary' data-testid='promote-last-checked'>
                            Looked {timeAgo(status.lastCheckedAt)}
                        </Typography>
                    )}
                    <Button size='small' variant='outlined' startIcon={<IconRefresh size={16} />} onClick={onCheckNow} disabled={checking}>
                        {checking ? 'Looking…' : 'Look now'}
                    </Button>
                </Stack>
            </Stack>
            {status?.state === 'retrying' || status?.state === 'stopped' ? <Alert severity='warning'>{status.message}</Alert> : null}
            {flows.length === 0 ? (
                <Box
                    data-testid='promote-empty'
                    sx={{ textAlign: 'center', py: 6, borderRadius: 2, border: '1px dashed', borderColor: theme.palette.divider }}
                >
                    <Avatar sx={{ mx: 'auto', bgcolor: 'success.main', width: 48, height: 48, animation: `${pop} 420ms ease-out` }}>
                        <IconCheck size={26} />
                    </Avatar>
                    <Typography variant='h4' sx={{ mt: 1.5 }}>
                        {sourceTitle === 'Dev' ? 'Everything from Dev is Live here' : `Everything from ${sourceTitle} is Live here`}
                    </Typography>
                    <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
                        {sourceTitle === 'Dev'
                            ? 'When Dev publishes a new version, it shows up here to review and promote.'
                            : `When ${sourceTitle} publishes a new version, it shows up here to review and promote.`}
                    </Typography>
                </Box>
            ) : (
                <>
                    <Typography variant='h4' data-testid='promote-summary'>
                        {incomingSummary(flows, sourceTitle)}
                    </Typography>
                    <Stack spacing={1.5}>
                        {flows.map((flow) => (
                            <IncomingCard key={flow.flowId} flow={flow} now={now} sourceTitle={sourceTitle} />
                        ))}
                    </Stack>
                </>
            )}
        </Stack>
    )
}
PromoteListView.propTypes = {
    list: PropTypes.object,
    status: PropTypes.object,
    loading: PropTypes.bool,
    error: PropTypes.string,
    checking: PropTypes.bool,
    onCheckNow: PropTypes.func,
    now: PropTypes.number,
    timeAgo: PropTypes.func
}

// One flow: what Promote changes here, the credentials it needs, the check, and the Promote button.
export const PromoteDetailView = ({
    detail,
    loading,
    error,
    promoting,
    promoteError,
    result,
    rollingBack,
    rolledBack,
    canRollBack,
    onPromote,
    onRollBack,
    openPath,
    check,
    now,
    sourceTitle = 'Dev'
}) => {
    const theme = useTheme()
    if (loading) {
        return (
            <Stack direction='row' spacing={1} alignItems='center' sx={{ py: 4 }}>
                <CircularProgress size={18} />
                <Typography color='text.secondary'>Loading the new version…</Typography>
            </Stack>
        )
    }
    if (error && !result) {
        return (
            <Stack spacing={2}>
                <Alert severity='info'>{error}</Alert>
                <Box>
                    <Button component={RouterLink} to={promotePath()} startIcon={<IconArrowLeft size={16} />}>
                        {sourceTitle === 'Dev' ? 'All new versions from Dev' : `All new versions from ${sourceTitle}`}
                    </Button>
                </Box>
            </Stack>
        )
    }
    if (!detail) return null
    const isNew = detail.status === 'new'
    const missing = detail.missingCredentials || []
    const lines = describeDiff(detail.diff, 'previous')
    const done = Boolean(result)

    if (done) {
        return (
            <Box data-testid='promote-done' sx={{ textAlign: 'center', py: 6, px: 2 }}>
                <Avatar
                    sx={{
                        mx: 'auto',
                        bgcolor: rolledBack ? 'grey.600' : 'success.main',
                        width: 64,
                        height: 64,
                        animation: `${pop} 480ms ease-out`
                    }}
                >
                    {rolledBack ? <IconArrowBackUp size={34} /> : <IconCheck size={36} />}
                </Avatar>
                <Typography variant='h3' sx={{ mt: 2 }}>
                    {rolledBack ? 'Rolled back. The previous version is Live again.' : promotedMessage(result)}
                </Typography>
                {!rolledBack && !result.unchanged && (
                    <Typography variant='body2' color='text.secondary' sx={{ mt: 1 }}>
                        {historyNote(result, sourceTitle)}
                    </Typography>
                )}
                {result.hasDraft && !rolledBack && (
                    <Alert severity='info' sx={{ mt: 2, maxWidth: 560, mx: 'auto', textAlign: 'left' }}>
                        {DRAFT_NOTE}
                    </Alert>
                )}
                {promoteError && (
                    <Alert severity='error' sx={{ mt: 2, maxWidth: 560, mx: 'auto' }}>
                        {promoteError}
                    </Alert>
                )}
                <Stack direction='row' spacing={1} justifyContent='center' sx={{ mt: 3 }} flexWrap='wrap' useFlexGap>
                    {openPath && (
                        <Button variant='contained' component={RouterLink} to={openPath} endIcon={<IconArrowRight size={16} />}>
                            Open the flow
                        </Button>
                    )}
                    {canRollBack && !rolledBack && (
                        <Button
                            variant='outlined'
                            color='inherit'
                            startIcon={<IconArrowBackUp size={16} />}
                            onClick={onRollBack}
                            disabled={rollingBack}
                            data-testid='promote-rollback'
                        >
                            {rollingBack ? 'Rolling back…' : 'Roll back'}
                        </Button>
                    )}
                    <Button component={RouterLink} to={promotePath()}>
                        {sourceTitle === 'Dev' ? 'All new versions from Dev' : `All new versions from ${sourceTitle}`}
                    </Button>
                </Stack>
            </Box>
        )
    }

    return (
        <Stack spacing={3} sx={{ pb: 10 }}>
            <Box>
                <Button component={RouterLink} to={promotePath()} size='small' startIcon={<IconArrowLeft size={16} />} sx={{ mb: 1 }}>
                    {sourceTitle === 'Dev' ? 'All new versions from Dev' : `All new versions from ${sourceTitle}`}
                </Button>
                <Box
                    sx={{
                        p: 2.5,
                        borderRadius: 2,
                        background: `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.12)}, ${alpha(
                            theme.palette.secondary.main,
                            0.08
                        )})`
                    }}
                >
                    <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
                        <Chip size='small' color={isNew ? 'secondary' : 'primary'} label={incomingLabel(detail, sourceTitle)} />
                        {detail.version?.shortSha && (
                            <Typography variant='caption' color='text.secondary'>
                                Version {detail.version.shortSha}
                            </Typography>
                        )}
                    </Stack>
                    <Typography variant='h2' sx={{ mt: 1 }} data-testid='promote-name'>
                        {detail.name}
                    </Typography>
                    <Typography variant='body1' sx={{ mt: 0.5 }}>
                        {detail.version?.title}
                    </Typography>
                    <Typography variant='caption' color='text.secondary'>
                        {sourceTitle === 'Dev'
                            ? `Published on Dev ${byLine(detail.version, now)}`
                            : `Published on ${sourceTitle} ${byLine(detail.version, now)}`}
                    </Typography>
                </Box>
            </Box>

            {isNew && <Alert severity='info'>{NEW_FLOW_NOTE}</Alert>}
            {detail.hasDraft && (
                <Alert severity='warning' icon={<IconPencil size={20} />} data-testid='promote-draft'>
                    {DRAFT_NOTE}
                </Alert>
            )}

            <Stack direction={{ xs: 'column', md: 'row' }} spacing={3}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Section title={isNew ? 'What it adds here' : 'What changes on this server'} testId='promote-changes'>
                        {lines.length === 0 ? (
                            <Typography variant='body2' color='text.secondary'>
                                Only settings outside the canvas differ.
                            </Typography>
                        ) : (
                            <Stack spacing={0.75}>
                                {lines.map((line, index) => (
                                    <Stack key={index} direction='row' spacing={1} alignItems='flex-start'>
                                        <Dot color={LINE_COLORS[line.status]} />
                                        <Typography variant='body2' sx={{ wordBreak: 'break-word' }}>
                                            {line.text}
                                        </Typography>
                                    </Stack>
                                ))}
                            </Stack>
                        )}
                    </Section>
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Section
                        title={
                            isNew
                                ? sourceTitle === 'Dev'
                                    ? 'Published on Dev'
                                    : `Published on ${sourceTitle}`
                                : sourceTitle === 'Dev'
                                ? 'What changed on Dev'
                                : `What changed on ${sourceTitle}`
                        }
                        testId='promote-dev-changes'
                    >
                        <Stack spacing={1}>
                            {(detail.changes || []).map((change) => (
                                <Box key={change.sha} sx={{ pl: 1.5, borderLeft: '2px solid', borderColor: theme.palette.divider }}>
                                    <Typography variant='body2'>{change.title}</Typography>
                                    <Typography variant='caption' color='text.secondary'>
                                        {byLine(change, now)}
                                    </Typography>
                                </Box>
                            ))}
                            {detail.moreChanges && (
                                <Typography variant='caption' color='text.secondary'>
                                    And earlier changes.
                                </Typography>
                            )}
                        </Stack>
                    </Section>
                </Box>
            </Stack>

            <Section title='Credentials' testId='promote-credentials'>
                {missing.length ? (
                    <Alert
                        severity='error'
                        icon={<IconKey size={20} />}
                        data-testid='promote-missing'
                        action={
                            <Button color='inherit' size='small' component={RouterLink} to={CREDENTIALS_PATH} sx={{ whiteSpace: 'nowrap' }}>
                                Open Credentials
                            </Button>
                        }
                    >
                        <Typography variant='body2' sx={{ fontWeight: 700 }}>
                            {MISSING_TITLE}
                        </Typography>
                        <Typography variant='body2'>{missingIntro(missing)}</Typography>
                        <Stack direction='row' spacing={0.75} sx={{ mt: 1 }} flexWrap='wrap' useFlexGap>
                            {missing.map((ref) => (
                                <Chip
                                    key={`${ref.credentialName}:${ref.name}`}
                                    size='small'
                                    label={credentialText(ref)}
                                    data-testid='promote-missing-item'
                                />
                            ))}
                        </Stack>
                    </Alert>
                ) : (
                    <Stack direction='row' spacing={1} alignItems='center' data-testid='promote-credentials-ok'>
                        <IconCheck size={18} color={theme.palette.success.main} />
                        <Typography variant='body2'>
                            Every credential it uses is on this server. Values never leave a server; only names travel.
                        </Typography>
                    </Stack>
                )}
                {(detail.ambiguousCredentials || []).length > 0 && (
                    <Alert severity='info' sx={{ mt: 1 }}>
                        More than one credential here is named {detail.ambiguousCredentials.map((ref) => `"${ref.name}"`).join(', ')}.
                        Promote uses{' '}
                        {detail.ambiguousCredentials.every((ref) => ref.using === 'current')
                            ? 'the one this flow uses now'
                            : 'the oldest one'}
                        .
                    </Alert>
                )}
            </Section>

            {detail.checkUnavailable ? (
                <Section title='Behavior check' testId='promote-check-unavailable'>
                    <Typography variant='body2' color='text.secondary'>
                        {detail.checkUnavailable.message}
                    </Typography>
                </Section>
            ) : (
                check
            )}

            <Box
                data-testid='promote-bar'
                sx={{
                    position: 'sticky',
                    bottom: 0,
                    zIndex: 2,
                    p: 2,
                    borderRadius: 2,
                    bgcolor: 'background.paper',
                    boxShadow: `0 -6px 24px ${alpha(theme.palette.common.black, 0.08)}`,
                    border: '1px solid',
                    borderColor: theme.palette.divider
                }}
            >
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} justifyContent='space-between'>
                    <Typography variant='body2' color='text.secondary'>
                        {missing.length
                            ? 'Promote is waiting for the credentials above.'
                            : isNew
                            ? 'Adds this flow here and puts it Live. You can roll back from version history.'
                            : 'Puts this version Live on this server. You can roll back any time.'}
                    </Typography>
                    <Button
                        size='large'
                        variant='contained'
                        startIcon={promoting ? <CircularProgress size={18} color='inherit' /> : <IconRocket size={20} />}
                        onClick={onPromote}
                        disabled={promoting || missing.length > 0}
                        data-testid='promote-button'
                        sx={{ px: 4, borderRadius: 2, fontWeight: 700, flexShrink: 0 }}
                    >
                        {promoting ? 'Promoting…' : 'Promote to Live'}
                    </Button>
                </Stack>
                {promoteError && (
                    <Alert severity='error' sx={{ mt: 1.5 }} data-testid='promote-error'>
                        {promoteError}
                    </Alert>
                )}
            </Box>
        </Stack>
    )
}
PromoteDetailView.propTypes = {
    detail: PropTypes.object,
    loading: PropTypes.bool,
    error: PropTypes.string,
    promoting: PropTypes.bool,
    promoteError: PropTypes.string,
    result: PropTypes.object,
    rollingBack: PropTypes.bool,
    rolledBack: PropTypes.bool,
    canRollBack: PropTypes.bool,
    onPromote: PropTypes.func,
    onRollBack: PropTypes.func,
    openPath: PropTypes.string,
    check: PropTypes.node,
    now: PropTypes.number,
    sourceTitle: PropTypes.string
}
