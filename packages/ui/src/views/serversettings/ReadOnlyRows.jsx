import PropTypes from 'prop-types'

import { alpha, useTheme } from '@mui/material/styles'
import { Box, Chip, Paper, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material'

const SOURCE_LABELS = {
    env: 'Environment',
    file: 'Secret file',
    default: 'Built-in',
    unset: 'Not configured'
}

// Host-only values. The row is the name, whether it is set, and where that answer came from.
// The value, its length, and any hash are not rendered, even if a response included them.
const ReadOnlyRows = ({ rows }) => {
    const theme = useTheme()
    return (
        <Box data-testid='read-only-rows'>
            <Typography
                sx={{
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    letterSpacing: 0.8,
                    textTransform: 'uppercase',
                    color: 'text.secondary',
                    mb: 1,
                    ml: 0.5
                }}
            >
                Set by the host
            </Typography>
            <Typography variant='body2' color='text.secondary' sx={{ mb: 1.5, maxWidth: 720 }}>
                These stay on the host. This list says whether each one is set. It does not show the value.
            </Typography>
            <Paper variant='outlined' sx={{ borderRadius: 3, overflow: 'hidden' }}>
                <Table size='small' aria-label='Host-only settings'>
                    <TableHead>
                        <TableRow sx={{ '& th': { fontWeight: 600, backgroundColor: alpha(theme.palette.text.primary, 0.03) } }}>
                            <TableCell>Setting</TableCell>
                            <TableCell>Status</TableCell>
                            <TableCell>From</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow key={row.key} data-testid={`readonly-${row.key}`} sx={{ '&:last-child td': { borderBottom: 0 } }}>
                                <TableCell
                                    sx={{
                                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                        fontSize: '0.8rem'
                                    }}
                                >
                                    {row.key}
                                </TableCell>
                                <TableCell>
                                    <Chip
                                        size='small'
                                        label={row.set ? 'Set' : 'Not set'}
                                        variant='outlined'
                                        color={row.set ? 'primary' : 'default'}
                                        sx={{ height: 22, fontSize: '0.72rem', borderRadius: 1.5 }}
                                    />
                                </TableCell>
                                <TableCell>
                                    <Typography variant='body2' color='text.secondary'>
                                        {SOURCE_LABELS[row.source] ?? 'Not configured'}
                                    </Typography>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </Paper>
        </Box>
    )
}

ReadOnlyRows.propTypes = {
    rows: PropTypes.arrayOf(
        PropTypes.shape({
            key: PropTypes.string.isRequired,
            set: PropTypes.bool,
            source: PropTypes.string,
            readOnly: PropTypes.bool
        })
    ).isRequired
}

export default ReadOnlyRows
