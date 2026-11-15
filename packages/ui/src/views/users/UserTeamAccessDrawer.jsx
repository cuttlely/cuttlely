import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import {
    Alert,
    Box,
    Button,
    Chip,
    Drawer,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Typography
} from '@mui/material'
import { formatListDateTime } from '@/utils/formatDate'
import { roleLabel } from '@/utils/roleLabel'

export default function UserTeamAccessDrawer({
    userId,
    userName,
    organizationId,
    currentTeamId,
    allTeams,
    loadAccess,
    refreshKey,
    renderRoleAction,
    onClose
}) {
    const [rows, setRows] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [retry, setRetry] = useState(0)

    useEffect(() => {
        let cancelled = false
        setRows([])
        setError('')
        setLoading(true)
        Promise.resolve()
            .then(() => loadAccess(organizationId, userId))
            .then((response) => {
                if (!Array.isArray(response.data)) throw new Error('Invalid team access response')
                if (!cancelled) setRows(response.data)
            })
            .catch((error) => {
                if (!cancelled) setError(error.response?.data?.message || 'Could not load team access. Try again.')
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [userId, organizationId, currentTeamId, loadAccess, refreshKey, retry])

    return (
        <Drawer anchor='right' open onClose={onClose}>
            <Box sx={{ p: { xs: 2, sm: 3 }, width: 'min(850px, 100vw)' }}>
                <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ mb: 1 }}>
                    <Typography variant='h2'>Team access</Typography>
                    <Button onClick={onClose}>Close</Button>
                </Stack>
                <Typography sx={{ mb: 1, wordBreak: 'break-word' }}>{userName}</Typography>
                <Typography variant='body2' sx={{ mb: 2 }}>
                    {allTeams
                        ? 'All of this person’s teams in this organization.'
                        : 'Current team only. An organization owner can view all teams.'}{' '}
                    Role changes apply to the selected team.
                </Typography>
                {!loading && !error && allTeams && rows.length > 0 && !rows.some((row) => row.workspaceId === currentTeamId) && (
                    <Alert severity='info' sx={{ mb: 2 }}>
                        To manage sign-in, passwords or sessions for this account, switch to one of their teams using the team selector.
                    </Alert>
                )}
                {loading ? (
                    <Typography role='status'>Loading team access…</Typography>
                ) : error ? (
                    <Alert severity='error' action={<Button onClick={() => setRetry((value) => value + 1)}>Retry</Button>}>
                        {error}
                    </Alert>
                ) : rows.length === 0 ? (
                    <Typography>No team assignments in this view.</Typography>
                ) : (
                    <TableContainer>
                        <Table aria-label='team access'>
                            <TableHead>
                                <TableRow>
                                    <TableCell>Team</TableCell>
                                    <TableCell>Role</TableCell>
                                    <TableCell>Status</TableCell>
                                    <TableCell>Last login</TableCell>
                                    {renderRoleAction && <TableCell>Actions</TableCell>}
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {[...rows]
                                    .sort((a, b) => (a.workspace?.name || '').localeCompare(b.workspace?.name || ''))
                                    .map((row) => (
                                        <TableRow key={row.workspaceId}>
                                            <TableCell>
                                                {row.workspace?.name}
                                                {row.workspaceId === currentTeamId && (
                                                    <Chip size='small' label='Current team' sx={{ ml: 1 }} />
                                                )}
                                            </TableCell>
                                            <TableCell>{row.isOrgOwner ? 'Super User (read-only)' : roleLabel(row.role)}</TableCell>
                                            <TableCell>
                                                <Chip
                                                    size='small'
                                                    label={
                                                        row.status === 'active'
                                                            ? 'ACTIVE'
                                                            : row.status === 'invited'
                                                            ? 'INVITED'
                                                            : 'DISABLED'
                                                    }
                                                    color={
                                                        row.status === 'active' ? 'success' : row.status === 'invited' ? 'warning' : 'error'
                                                    }
                                                />
                                            </TableCell>
                                            <TableCell>{row.lastLogin ? formatListDateTime(row.lastLogin) : 'Never'}</TableCell>
                                            {renderRoleAction && <TableCell>{!row.isOrgOwner && renderRoleAction(row)}</TableCell>}
                                        </TableRow>
                                    ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                )}
            </Box>
        </Drawer>
    )
}

UserTeamAccessDrawer.propTypes = {
    userId: PropTypes.string.isRequired,
    userName: PropTypes.string.isRequired,
    organizationId: PropTypes.string.isRequired,
    currentTeamId: PropTypes.string,
    allTeams: PropTypes.bool,
    loadAccess: PropTypes.func.isRequired,
    refreshKey: PropTypes.number,
    renderRoleAction: PropTypes.func,
    onClose: PropTypes.func.isRequired
}
