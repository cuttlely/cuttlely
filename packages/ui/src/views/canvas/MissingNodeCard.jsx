import PropTypes from 'prop-types'

import { Box, Typography } from '@mui/material'

// A saved node whose class is not loaded. The card names the pack so the flow can still open.
const MissingNodeCard = ({ data, message }) => {
    const label = (data && (data.label || data.name)) || 'Node'
    return (
        <Box
            data-testid='missing-node-card'
            sx={{
                width: 300,
                p: 2,
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: '8px',
                bgcolor: 'background.paper'
            }}
        >
            <Typography sx={{ fontSize: '1rem', fontWeight: 500 }}>{label}</Typography>
            <Typography variant='body2' color='text.secondary' sx={{ mt: 1 }}>
                {message}
            </Typography>
        </Box>
    )
}

MissingNodeCard.propTypes = {
    data: PropTypes.object,
    message: PropTypes.string
}

export default MissingNodeCard
