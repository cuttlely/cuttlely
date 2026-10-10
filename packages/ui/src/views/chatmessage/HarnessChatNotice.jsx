import PropTypes from 'prop-types'
import { Link as RouterLink } from 'react-router-dom'

import { Box, Button, Typography } from '@mui/material'

const HarnessChatNotice = ({ message }) => (
    <Box
        sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            p: 3,
            textAlign: 'center',
            backgroundColor: 'background.paper'
        }}
    >
        <Box sx={{ maxWidth: 360 }}>
            <Typography sx={{ fontWeight: 600, mb: 1 }}>This harness cannot chat yet</Typography>
            <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
                {message}
            </Typography>
            <Button component={RouterLink} to='/credentials' variant='contained' sx={{ textTransform: 'none', borderRadius: 2 }}>
                Credentials
            </Button>
        </Box>
    </Box>
)

HarnessChatNotice.propTypes = {
    message: PropTypes.string
}

export default HarnessChatNotice
