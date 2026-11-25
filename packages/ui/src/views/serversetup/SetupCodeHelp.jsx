import PropTypes from 'prop-types'
import { Box, Typography } from '@mui/material'

import { setupCodeHelp } from './model'

/** Setup log commands rendered as code. */
const SetupCodeHelp = ({ serviceName }) => {
    const help = setupCodeHelp(serviceName)
    return (
        <Typography color='text.secondary' sx={{ mt: 0.75 }} data-testid='setup-code-help'>
            {help.before}{' '}
            <Box component='code' sx={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {help.command}
            </Box>{' '}
            ·{' '}
            <Box component='code' sx={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                npx cuttlely logs
            </Box>{' '}
            {help.after}
        </Typography>
    )
}

SetupCodeHelp.propTypes = { serviceName: PropTypes.string }

export default SetupCodeHelp
