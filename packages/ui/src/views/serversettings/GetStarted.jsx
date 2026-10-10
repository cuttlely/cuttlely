// "Set up your server": three optional first steps. Each tile opens the same section of this page. Skip for now
// hides it for good on this browser.
import PropTypes from 'prop-types'
import { alpha, useTheme } from '@mui/material/styles'
import { Box, Button, ButtonBase, Stack, Typography } from '@mui/material'
import { IconChartBar, IconCircleCheckFilled, IconKey, IconSparkles, IconUserShield } from '@tabler/icons-react'
import { getStartedTiles } from './model'

const ICONS = { signin: IconUserShield, analyst: IconChartBar, models: IconKey }

const GetStarted = ({ data, onOpen, onSkip }) => {
    const theme = useTheme()
    const tiles = getStartedTiles(data)
    const doneCount = tiles.filter((tile) => tile.done).length
    return (
        <Box
            data-testid='get-started'
            sx={{
                mb: 3,
                p: { xs: 2, md: 2.5 },
                borderRadius: 4,
                border: `1px solid ${alpha(theme.palette.primary.main, 0.25)}`,
                background: `linear-gradient(135deg, ${alpha(
                    theme.palette.primary.main,
                    theme.palette.mode === 'dark' ? 0.14 : 0.06
                )}, ${alpha(theme.palette.primary.main, 0)} 70%)`
            }}
        >
            <Stack direction='row' alignItems='flex-start' justifyContent='space-between' gap={2} sx={{ mb: 2 }}>
                <Box>
                    <Typography sx={{ fontWeight: 650, fontSize: '1.05rem', display: 'flex', gap: 1, alignItems: 'center' }}>
                        <IconSparkles size={18} color={theme.palette.primary.main} /> Set up your server
                    </Typography>
                    <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
                        Three optional steps. {doneCount} of 3 done. Everything here can wait.
                    </Typography>
                </Box>
                <Button size='small' onClick={onSkip} sx={{ borderRadius: 2, whiteSpace: 'nowrap' }} data-testid='get-started-skip'>
                    Skip for now
                </Button>
            </Stack>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5}>
                {tiles.map((tile) => {
                    const Icon = ICONS[tile.id]
                    return (
                        <ButtonBase
                            key={tile.id}
                            onClick={() => onOpen(tile.id)}
                            data-testid={`get-started-${tile.id}`}
                            sx={{
                                flex: 1,
                                p: 2,
                                gap: 1,
                                borderRadius: 3,
                                textAlign: 'left',
                                flexDirection: 'column',
                                alignItems: 'flex-start',
                                backgroundColor: theme.palette.background.paper,
                                border: `1px solid ${theme.palette.divider}`,
                                transition: 'border-color 140ms ease, box-shadow 140ms ease',
                                '&:hover': {
                                    borderColor: theme.palette.primary.main,
                                    boxShadow: `0 4px 18px ${alpha(theme.palette.primary.main, 0.1)}`
                                }
                            }}
                        >
                            <Stack direction='row' alignItems='center' gap={1.25} sx={{ width: '100%' }}>
                                <Box
                                    sx={{
                                        width: 34,
                                        height: 34,
                                        borderRadius: 2.25,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        color: theme.palette.primary.main,
                                        backgroundColor: alpha(theme.palette.primary.main, 0.12)
                                    }}
                                >
                                    <Icon size={18} stroke={1.8} />
                                </Box>
                                <Typography sx={{ fontWeight: 650, flexGrow: 1 }}>{tile.title}</Typography>
                                {tile.done && <IconCircleCheckFilled size={18} color={theme.palette.success.main} aria-label='Done' />}
                            </Stack>
                            <Typography variant='body2' color='text.secondary'>
                                {tile.body}
                            </Typography>
                            <Typography variant='body2' sx={{ color: 'primary.main', fontWeight: 600, mt: 'auto' }}>
                                {tile.done ? 'Open' : tile.action}
                            </Typography>
                        </ButtonBase>
                    )
                })}
            </Stack>
        </Box>
    )
}

GetStarted.propTypes = { data: PropTypes.object.isRequired, onOpen: PropTypes.func.isRequired, onSkip: PropTypes.func.isRequired }

export default GetStarted
