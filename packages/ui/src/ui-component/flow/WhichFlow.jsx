import { useState } from 'react'
import PropTypes from 'prop-types'
import { useNavigate } from 'react-router-dom'

import { Box, Button, Collapse, Divider, Link, Stack, Typography } from '@mui/material'

import { PermissionButton } from '@/ui-component/button/RBACButtons'
import AppHero from '@/ui-component/flow/AppHero'
import { BRING_YOUR_FLOWS_URL, BUILD_CHOICES, BUILD_CHOOSER_KEY, GLOSSARY, chooserIsOpen } from '@/ui-component/flow/buildChoices'

const WhichFlow = ({ pinned = false, hero = false }) => {
    const navigate = useNavigate()
    const [dismissed, setDismissed] = useState(() => localStorage.getItem(BUILD_CHOOSER_KEY) === '1')
    const [namesOpen, setNamesOpen] = useState(false)
    const expanded = chooserIsOpen({ dismissed, pinned })

    const hide = () => {
        localStorage.setItem(BUILD_CHOOSER_KEY, '1')
        setDismissed(true)
        setNamesOpen(false)
    }

    if (!expanded) return null

    return (
        <Box id='what-are-you-building' sx={{ border: 1, borderColor: 'divider', borderRadius: 2, px: 2, py: 1.5 }}>
            {hero && (
                <>
                    <Box sx={{ pt: { xs: 1, sm: 1.5 }, pb: { xs: 2, sm: 2.5 } }}>
                        <AppHero />
                    </Box>
                    <Divider sx={{ mb: 1.5 }} />
                </>
            )}
            <Stack direction='row' alignItems='flex-start' justifyContent='space-between' sx={{ gap: 1 }}>
                <Typography variant='subtitle1' sx={{ fontWeight: 600 }}>
                    What are you building?
                </Typography>
                {!pinned && (
                    <Button size='small' onClick={hide} sx={{ textTransform: 'none', flexShrink: 0 }}>
                        Hide
                    </Button>
                )}
            </Stack>
            <Typography variant='body2' sx={{ mt: 0.5, mb: 1.5 }}>
                Pick an outcome. The name under it is what the rest of the app calls that canvas.
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1 }}>
                {BUILD_CHOICES.map((choice) => (
                    <PermissionButton
                        key={choice.id}
                        permissionId={choice.permission}
                        variant='outlined'
                        aria-label={`${choice.outcome}, ${choice.label}`}
                        onClick={() => navigate(choice.createPath)}
                        sx={{
                            textTransform: 'none',
                            justifyContent: 'flex-start',
                            textAlign: 'left',
                            whiteSpace: 'normal',
                            height: 'auto',
                            px: 1.5,
                            py: 1
                        }}
                    >
                        <Box>
                            <Typography variant='body2' sx={{ fontWeight: 600 }}>
                                {choice.outcome}
                            </Typography>
                            <Typography variant='caption' color='text.secondary' display='block'>
                                {choice.label}
                            </Typography>
                        </Box>
                    </PermissionButton>
                ))}
            </Box>
            <Stack direction='row' alignItems='center' sx={{ gap: 1, mt: 1.5, flexWrap: 'wrap' }}>
                <Button size='small' onClick={() => setNamesOpen((open) => !open)} sx={{ textTransform: 'none' }}>
                    {namesOpen ? 'Hide the names' : 'Which should I use?'}
                </Button>
                <Link
                    href={BRING_YOUR_FLOWS_URL}
                    target='_blank'
                    rel='noopener noreferrer'
                    variant='caption'
                    color='text.secondary'
                    underline='hover'
                    sx={{ ml: 'auto' }}
                >
                    Bring flows from another tool
                </Link>
            </Stack>
            <Collapse in={namesOpen}>
                <Box sx={{ mt: 1 }}>
                    {GLOSSARY.map(([name, text]) => (
                        <Typography key={name} variant='body2' sx={{ mt: 0.25 }}>
                            <strong>{name}</strong> — {text}
                        </Typography>
                    ))}
                </Box>
            </Collapse>
        </Box>
    )
}

WhichFlow.propTypes = {
    pinned: PropTypes.bool,
    hero: PropTypes.bool
}

export default WhichFlow
