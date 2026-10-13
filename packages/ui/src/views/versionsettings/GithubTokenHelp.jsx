// The "which token" help next to the GitHub token box: an i button that opens a short card, in the words GitHub's
// own token page uses, with a link that opens that page already filled in and a link to the guide.
import { useState } from 'react'
import PropTypes from 'prop-types'
import { Box, Button, IconButton, Popover, Stack, Tooltip, Typography } from '@mui/material'
import { IconBook2, IconExternalLink, IconInfoCircle } from '@tabler/icons-react'

import { TOKEN_GUIDE_URL, tokenCreateUrl, tokenHelp } from '@/utils/githubSync'

export const TokenHelpCard = ({ reading, from = '' }) => {
    const help = tokenHelp(reading, from)
    return (
        <Box data-testid='github-token-help' sx={{ width: 380, maxWidth: 'calc(100vw - 32px)', p: 2.25 }}>
            <Stack direction='row' spacing={1} alignItems='center' sx={{ mb: 1.75 }}>
                <Box sx={{ color: 'primary.main', display: 'grid', placeItems: 'center' }}>
                    <IconInfoCircle size={20} />
                </Box>
                <Typography variant='h5'>{help.title}</Typography>
            </Stack>
            <Box
                component='dl'
                sx={{
                    m: 0,
                    display: 'grid',
                    gridTemplateColumns: 'max-content 1fr',
                    columnGap: 2,
                    rowGap: 1.25,
                    alignItems: 'baseline'
                }}
            >
                {help.rows.map((row) => (
                    <Box key={row.label} sx={{ display: 'contents' }}>
                        <Typography component='dt' variant='caption' color='text.secondary' sx={{ whiteSpace: 'nowrap' }}>
                            {row.label}
                        </Typography>
                        <Box component='dd' sx={{ m: 0 }}>
                            <Typography variant='body2' sx={{ fontWeight: 600 }}>
                                {row.value}
                            </Typography>
                            {row.hint && (
                                <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 0.25 }}>
                                    {row.hint}
                                </Typography>
                            )}
                        </Box>
                    </Box>
                ))}
            </Box>
            <Typography
                variant='caption'
                color='text.secondary'
                sx={{ display: 'block', mt: 1.75, p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}
            >
                {help.note}
            </Typography>
            <Stack direction='row' spacing={1} sx={{ mt: 1.75 }} flexWrap='wrap' useFlexGap>
                <Button
                    variant='contained'
                    size='small'
                    href={tokenCreateUrl(reading)}
                    target='_blank'
                    rel='noopener noreferrer'
                    endIcon={<IconExternalLink size={16} />}
                    data-testid='github-token-create'
                >
                    Create a token on GitHub
                </Button>
                <Button
                    size='small'
                    color='inherit'
                    href={TOKEN_GUIDE_URL}
                    target='_blank'
                    rel='noopener noreferrer'
                    startIcon={<IconBook2 size={16} />}
                >
                    Read the guide
                </Button>
            </Stack>
        </Box>
    )
}

TokenHelpCard.propTypes = { reading: PropTypes.bool, from: PropTypes.string }

const GithubTokenHelp = ({ reading, from = '' }) => {
    const [anchor, setAnchor] = useState(null)
    const open = Boolean(anchor)
    return (
        <>
            <Tooltip title={open ? '' : 'Which token to use'}>
                <IconButton
                    size='small'
                    edge='end'
                    aria-label='Which token to use'
                    aria-haspopup='dialog'
                    aria-expanded={open}
                    color={open ? 'primary' : 'default'}
                    onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
                    data-testid='github-token-help-button'
                >
                    <IconInfoCircle size={18} />
                </IconButton>
            </Tooltip>
            <Popover
                open={open}
                anchorEl={anchor}
                onClose={() => setAnchor(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                PaperProps={{ sx: { mt: 1, borderRadius: 2.5, boxShadow: 8 }, role: 'dialog', 'aria-label': 'Which token to use' }}
            >
                <TokenHelpCard reading={reading} from={from} />
            </Popover>
        </>
    )
}

GithubTokenHelp.propTypes = { reading: PropTypes.bool, from: PropTypes.string }

export default GithubTokenHelp
