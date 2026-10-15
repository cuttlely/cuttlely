import { useEffect, useRef, useState } from 'react'
import {
    Button,
    MenuItem,
    Skeleton,
    Stack,
    Table,
    TableBody,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Typography
} from '@mui/material'
import { formatListDateTime } from '@/utils/formatDate'
import MainCard from '@/ui-component/cards/MainCard'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import ErrorBoundary from '@/ErrorBoundary'
import { StyledTableCell, StyledTableRow } from '@/ui-component/table/TableStyles'
import useApi from '@/hooks/useApi'
import auditApi from '@/api/audit'
import { AUDIT_TYPES, auditParams } from './query'
import LogsEmptySVG from '@/assets/images/logs_empty.svg'

const AuditLog = () => {
    const [type, setType] = useState('')
    const [user, setUser] = useState('')
    const [events, setEvents] = useState([])
    const [cursor, setCursor] = useState(null)
    const appendRef = useRef(false)
    const getAudit = useApi(auditApi.getAudit)

    const load = (nextCursor, append) => {
        appendRef.current = Boolean(append)
        getAudit.request(auditParams({ type, user, cursor: nextCursor || undefined }))
    }

    useEffect(() => {
        setEvents([])
        setCursor(null)
        appendRef.current = false
        getAudit.request(auditParams({ type, user }))
        // The user id is applied with the button so typing does not fetch every character.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [type])

    useEffect(() => {
        if (!getAudit.data) return
        const page = getAudit.data.events || []
        setEvents((current) => (appendRef.current ? current.concat(page) : page))
        setCursor(getAudit.data.nextCursor || null)
        appendRef.current = false
    }, [getAudit.data])

    const applyUser = () => {
        setEvents([])
        setCursor(null)
        load()
    }

    return (
        <MainCard>
            <Stack spacing={2}>
                <ViewHeader
                    title='Audit log'
                    description='Sign-in, invites, role changes, and settings changes. Passwords and tokens are not stored.'
                />
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                    <TextField
                        select
                        size='small'
                        label='Type'
                        value={type}
                        onChange={(event) => setType(event.target.value)}
                        sx={{ minWidth: 220 }}
                    >
                        {AUDIT_TYPES.map((item) => (
                            <MenuItem key={item.value || 'all'} value={item.value}>
                                {item.label}
                            </MenuItem>
                        ))}
                    </TextField>
                    <TextField
                        size='small'
                        label='User id'
                        value={user}
                        onChange={(event) => setUser(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') applyUser()
                        }}
                        sx={{ minWidth: 280 }}
                    />
                    <Button variant='outlined' onClick={applyUser}>
                        Apply
                    </Button>
                </Stack>
                {getAudit.loading && !events.length ? (
                    <Skeleton height={240} />
                ) : events.length ? (
                    <TableContainer>
                        <Table size='small'>
                            <TableHead>
                                <TableRow>
                                    <StyledTableCell>When</StyledTableCell>
                                    <StyledTableCell>Type</StyledTableCell>
                                    <StyledTableCell>User</StyledTableCell>
                                    <StyledTableCell>Summary</StyledTableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {events.map((event) => (
                                    <StyledTableRow key={event.id}>
                                        <StyledTableCell>{formatListDateTime(event.at)}</StyledTableCell>
                                        <StyledTableCell>{event.type}</StyledTableCell>
                                        <StyledTableCell>{event.userId || ''}</StyledTableCell>
                                        <StyledTableCell>{event.summary}</StyledTableCell>
                                    </StyledTableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                ) : (
                    <Stack alignItems='center' spacing={1}>
                        <img src={LogsEmptySVG} alt='' width={160} />
                        <Typography>No audit events match.</Typography>
                    </Stack>
                )}
                {cursor ? (
                    <Button variant='text' disabled={getAudit.loading} onClick={() => load(cursor, true)}>
                        Load more
                    </Button>
                ) : null}
                {getAudit.error ? <Typography color='error'>The audit log could not be loaded.</Typography> : null}
            </Stack>
        </MainCard>
    )
}

const AuditLogPage = () => (
    <ErrorBoundary>
        <AuditLog />
    </ErrorBoundary>
)

export default AuditLogPage
