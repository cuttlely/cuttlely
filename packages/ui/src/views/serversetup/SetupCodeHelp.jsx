import PropTypes from 'prop-types'
import { Box, Typography } from '@mui/material'

import { setupCodeHelp } from './model'

/** Docker command as code, so the help text does not show backtick characters. */
const SetupCodeHelp = ({ serviceName }) => {
    const help = setupCodeHelp(serviceName)
    return (
        <Typography color='text.secondary' sx={{ mt: 0.75 }} data-testid='setup-code-help'>
            {help.before}{' '}
            <Box component='code' sx={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {help.command}
            </Box>{' '}
            {help.after}
        </Typography>
    )
}

SetupCodeHelp.propTypes = { serviceName: PropTypes.string }

export default SetupCodeHelp
