import PropTypes from 'prop-types'

import { Box, Typography } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'

import Mascot from '@/ui-component/extended/Mascot'
import { t } from '@/i18n'

// ==============================|| APP HERO ||============================== //
// The headline, the tagline and the neutral mascot, shown once per screen on first-run and empty
// states. The mascot is decorative (empty alt, aria-hidden) and never smaller than 96px.

const AppHero = ({ align = 'start', component = 'h2' }) => {
    const theme = useTheme()
    const centered = align === 'center'

    return (
        <Box
            data-testid='app-hero'
            sx={{
                display: 'flex',
                flexDirection: centered ? 'column' : { xs: 'column', sm: 'row' },
                alignItems: centered ? 'center' : { xs: 'flex-start', sm: 'center' },
                textAlign: centered ? 'center' : 'left',
                gap: { xs: 1.5, sm: centered ? 1.5 : 2.5 }
            }}
        >
            <Box sx={{ flexShrink: 0 }}>
                <Mascot pose='neutral' size={104} />
            </Box>
            <Box sx={{ minWidth: 0 }}>
                <Typography
                    component={component}
                    sx={{
                        m: 0,
                        fontSize: { xs: '1.375rem', sm: '1.625rem' },
                        fontWeight: 700,
                        lineHeight: 1.2,
                        letterSpacing: '-0.01em',
                        color: theme.palette.text.primary
                    }}
                >
                    {t('hero.headline')}
                </Typography>
                <Typography
                    sx={{
                        mt: 0.75,
                        fontSize: { xs: '0.95rem', sm: '1rem' },
                        lineHeight: 1.45,
                        color: alpha(theme.palette.text.primary, theme.palette.mode === 'dark' ? 0.66 : 0.7)
                    }}
                >
                    {t('hero.tagline')}
                </Typography>
            </Box>
        </Box>
    )
}

AppHero.propTypes = {
    align: PropTypes.oneOf(['start', 'center']),
    component: PropTypes.string
}

export default AppHero
