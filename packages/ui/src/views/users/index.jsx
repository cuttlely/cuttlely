import React, { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Link } from 'react-router-dom'
import * as PropTypes from 'prop-types'
import { formatListDateTime } from '@/utils/formatDate'
import { canChangeRole, roleLabel } from '@/utils/roleLabel'

// material-ui
import {
    Button,
    Box,
    Skeleton,
    useMediaQuery,
    Stack,
    Table,
    TableBody,
    TableContainer,
    TableHead,
    TableRow,
    Paper,
    useTheme,
    Chip,
    Drawer,
    Typography,
    CircularProgress
} from '@mui/material'

// project imports
import MainCard from '@/ui-component/cards/MainCard'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import ErrorBoundary from '@/ErrorBoundary'
import EditWorkspaceUserRoleDialog from '@/views/workspace/EditWorkspaceUserRoleDialog'
import UserSessionsDrawer from '@/views/users/UserSessionsDrawer'
import { StyledTableCell, StyledTableRow } from '@/ui-component/table/TableStyles'
import InviteUsersDialog from '@/ui-component/dialog/InviteUsersDialog'
import CreateUserDialog from '@/ui-component/dialog/CreateUserDialog'
import { PermissionButton, PermissionIconButton, StyledPermissionButton } from '@/ui-component/button/RBACButtons'

// API
import userApi from '@/api/user'

// Hooks
import useApi from '@/hooks/useApi'
import useConfirm from '@/hooks/useConfirm'

// utils
import useNotifier from '@/utils/useNotifier'

// Icons
import { IconTrash, IconX, IconPlus, IconUser, IconEyeOff, IconEye, IconUserStar, IconUserCog } from '@tabler/icons-react'
import users_emptySVG from '@/assets/images/users_empty.svg'

// store
import { useError } from '@/store/context/ErrorContext'
import { useConfig } from '@/store/context/ConfigContext'
import { enqueueSnackbar as enqueueSnackbarAction, closeSnackbar as closeSnackbarAction } from '@/store/actions'

function ShowUserRow(props) {
    const customization = useSelector((state) => state.customization)

    const [open, setOpen] = useState(false)
    const [editable, setEditable] = useState(false)
    const [userRoles, setUserRoles] = useState([])
    const [roleDialogProps, setRoleDialogProps] = useState(null)

    const theme = useTheme()
    const { isOpenSource } = useConfig()

    const getWorkspacesByUserId = useApi(userApi.getWorkspacesByOrganizationIdUserId)

    const handleViewUserRoles = (userId, organizationId, edit = false) => {
        setEditable(edit)
        setOpen(edit || !open)
        getWorkspacesByUserId.request(organizationId, userId)
    }

    const openRoleDialog = (membership) => {
        setRoleDialogProps({
            type: 'EDIT',
            cancelButtonName: 'Cancel',
            confirmButtonName: 'Update Role',
            data: membership
        })
    }

    const onRoleChanged = () => {
        setRoleDialogProps(null)
        getWorkspacesByUserId.request(props.row.organizationId, props.row.userId)
    }

    useEffect(() => {
        if (getWorkspacesByUserId.data) {
            setUserRoles(getWorkspacesByUserId.data)
        }
    }, [getWorkspacesByUserId.data])

    useEffect(() => {
        if (!open) {
            setOpen(false)
            setUserRoles([])
        }
    }, [open])

    const currentUser = useSelector((state) => state.auth.user)
    const showChangeRole = canChangeRole(props.row, currentUser.id)

    const assignedRolesDrawer = (
        <Drawer anchor='right' open={open} onClose={() => setOpen(false)}>
            <Box sx={{ p: { xs: 2, sm: 4 }, height: 'auto', width: 'min(650px, 100vw)' }}>
                <Typography sx={{ textAlign: 'left', mb: 2 }} variant='h2'>
                    {editable ? 'Change role' : 'Assigned Roles'}
                </Typography>
                {editable && (
                    <Typography sx={{ textAlign: 'left', mb: 2 }} variant='body2'>
                        Pick a team to give {props.row.user?.name || props.row.user?.email} a different role there.
                    </Typography>
                )}
                <TableContainer
                    sx={{ border: 1, borderColor: theme.palette.grey[900] + 25, borderRadius: 2, overflowX: 'auto' }}
                    component={Paper}
                >
                    <Table aria-label='assigned roles table'>
                        <TableHead
                            sx={{
                                backgroundColor: customization.isDarkMode ? theme.palette.common.black : theme.palette.grey[100],
                                height: 56
                            }}
                        >
                            <TableRow>
                                <StyledTableCell sx={{ width: '50%' }}>Role</StyledTableCell>
                                <StyledTableCell sx={{ width: '50%' }}>Workspace</StyledTableCell>
                                {editable && <StyledTableCell>&nbsp;</StyledTableCell>}
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {userRoles.map((item, index) => (
                                <TableRow key={index}>
                                    <StyledTableCell>
                                        {roleLabel(item.role)}
                                        {String(item.role?.name || '').toLowerCase() === 'owner' ? ' (read-only)' : ''}
                                    </StyledTableCell>
                                    <StyledTableCell>{item.workspace.name}</StyledTableCell>
                                    {editable && (
                                        <StyledTableCell>
                                            {showChangeRole && (
                                                <PermissionButton
                                                    permissionId={'workspace:update'}
                                                    size='small'
                                                    variant='outlined'
                                                    onClick={() => openRoleDialog(item)}
                                                >
                                                    Change
                                                </PermissionButton>
                                            )}
                                        </StyledTableCell>
                                    )}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Box>
            {roleDialogProps && (
                <EditWorkspaceUserRoleDialog
                    show={Boolean(roleDialogProps)}
                    dialogProps={roleDialogProps}
                    onCancel={() => setRoleDialogProps(null)}
                    onConfirm={onRoleChanged}
                />
            )}
        </Drawer>
    )

    const roleToggle = (
        <PermissionIconButton
            permissionId={'users:manage'}
            aria-label='expand row'
            size='small'
            color='inherit'
            onClick={() => handleViewUserRoles(props.row.userId, props.row.organizationId)}
        >
            {props.row.roleCount > 0 && open ? <IconEyeOff /> : <IconEye />}
        </PermissionIconButton>
    )

    const rowActions = (
        <>
            {!props.row.isOrgOwner &&
                props.row.userId !== currentUser.id &&
                (props.deletingUserId === props.row.user.id ? (
                    <CircularProgress size={24} color='error' />
                ) : (
                    <PermissionIconButton
                        permissionId={'workspace:unlink-user,users:manage'}
                        title='Delete'
                        color='error'
                        onClick={() => props.onDeleteClick(props.row.user)}
                    >
                        <IconTrash />
                    </PermissionIconButton>
                ))}
            {showChangeRole && (
                <PermissionIconButton
                    permissionId={'workspace:update'}
                    title='Change role'
                    aria-label='Change role'
                    color='primary'
                    onClick={() => handleViewUserRoles(props.row.userId, props.row.organizationId, true)}
                >
                    <IconUserCog />
                </PermissionIconButton>
            )}
            <PermissionIconButton
                permissionId={'users:manage'}
                title='Sessions'
                color='primary'
                onClick={() => props.onSessionsClick(props.row)}
            >
                <IconUser />
            </PermissionIconButton>
        </>
    )

    if (props.narrow) {
        return (
            <React.Fragment>
                <Paper variant='outlined' sx={{ p: 1.5, borderRadius: 2 }}>
                    <Stack direction='row' alignItems='flex-start' sx={{ gap: 1 }}>
                        <Box sx={{ width: 25, height: 25, flexShrink: 0 }}>
                            {props?.row?.isOrgOwner ? (
                                <IconUserStar style={{ width: '100%', height: '100%' }} />
                            ) : (
                                <IconUser style={{ width: '100%', height: '100%' }} />
                            )}
                        </Box>
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Typography sx={{ fontWeight: 600, wordBreak: 'break-word' }}>{props.row.user.name ?? ''}</Typography>
                            {props.row.user.email && (
                                <Typography variant='body2' sx={{ wordBreak: 'break-all' }}>
                                    {props.row.user.email}
                                </Typography>
                            )}
                            {props.row.isOrgOwner && (
                                <Chip size='small' sx={{ mt: 0.5 }} label={isOpenSource ? 'Super User, read-only' : 'ORGANIZATION OWNER'} />
                            )}
                            <Stack direction='row' alignItems='center' flexWrap='wrap' sx={{ gap: 1, mt: 1 }}>
                                <Typography variant='body2'>Assigned roles: {props.row.roleCount}</Typography>
                                {roleToggle}
                                {'ACTIVE' === props.row.status.toUpperCase() && (
                                    <Chip color={'success'} label={props.row.status.toUpperCase()} />
                                )}
                                {'INVITED' === props.row.status.toUpperCase() && (
                                    <Chip color={'warning'} label={props.row.status.toUpperCase()} />
                                )}
                                {['INACTIVE', 'DISABLE', 'DISABLED'].includes(props.row.status.toUpperCase()) && (
                                    <Chip color={'error'} label='INACTIVE' />
                                )}
                            </Stack>
                            <Typography variant='body2' sx={{ mt: 0.5 }}>
                                Last login: {!props.row.lastLogin ? 'Never' : formatListDateTime(props.row.lastLogin)}
                            </Typography>
                            <Box>{rowActions}</Box>
                        </Box>
                    </Stack>
                </Paper>
                {assignedRolesDrawer}
            </React.Fragment>
        )
    }

    return (
        <React.Fragment>
            <StyledTableRow hover sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                <StyledTableCell component='th' scope='row'>
                    <div
                        style={{
                            display: 'flex',
                            flexDirection: 'row',
                            alignItems: 'center'
                        }}
                    >
                        <div
                            style={{
                                width: 25,
                                height: 25,
                                marginRight: 10,
                                borderRadius: '50%'
                            }}
                        >
                            {props?.row?.isOrgOwner ? (
                                <IconUserStar
                                    style={{
                                        width: '100%',
                                        height: '100%',
                                        borderRadius: '50%',
                                        objectFit: 'contain'
                                    }}
                                />
                            ) : (
                                <IconUser
                                    style={{
                                        width: '100%',
                                        height: '100%',
                                        borderRadius: '50%',
                                        objectFit: 'contain'
                                    }}
                                />
                            )}
                        </div>
                    </div>
                </StyledTableCell>
                <StyledTableCell>
                    {props.row.user.name ?? ''}
                    {props.row.user.email && (
                        <>
                            <br />
                            {props.row.user.email}
                        </>
                    )}

                    {props.row.isOrgOwner && (
                        <>
                            {' '}
                            <br />
                            <Chip size='small' label={isOpenSource ? 'Super User, read-only' : 'ORGANIZATION OWNER'} />{' '}
                        </>
                    )}
                </StyledTableCell>
                <StyledTableCell sx={{ textAlign: 'center' }}>
                    {props.row.roleCount}
                    {roleToggle}
                </StyledTableCell>
                <StyledTableCell>
                    {'ACTIVE' === props.row.status.toUpperCase() && <Chip color={'success'} label={props.row.status.toUpperCase()} />}
                    {'INVITED' === props.row.status.toUpperCase() && <Chip color={'warning'} label={props.row.status.toUpperCase()} />}
                    {['INACTIVE', 'DISABLE', 'DISABLED'].includes(props.row.status.toUpperCase()) && (
                        <Chip color={'error'} label='INACTIVE' />
                    )}
                </StyledTableCell>
                <StyledTableCell>{!props.row.lastLogin ? 'Never' : formatListDateTime(props.row.lastLogin)}</StyledTableCell>
                <StyledTableCell>{rowActions}</StyledTableCell>
            </StyledTableRow>
            {assignedRolesDrawer}
        </React.Fragment>
    )
}

ShowUserRow.propTypes = {
    row: PropTypes.any,
    onDeleteClick: PropTypes.func,
    onSessionsClick: PropTypes.func,
    open: PropTypes.bool,
    theme: PropTypes.any,
    deletingUserId: PropTypes.string,
    narrow: PropTypes.bool
}

// ==============================|| Users ||============================== //

const Users = () => {
    const theme = useTheme()
    const narrow = useMediaQuery(theme.breakpoints.down('sm'))
    const customization = useSelector((state) => state.customization)
    const dispatch = useDispatch()
    useNotifier()
    const { error, setError } = useError()
    const currentUser = useSelector((state) => state.auth.user)
    const { isOpenSource } = useConfig()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [isLoading, setLoading] = useState(true)
    const [showInviteDialog, setShowInviteDialog] = useState(false)
    const [inviteDialogProps, setInviteDialogProps] = useState({})
    const [users, setUsers] = useState([])
    const [search, setSearch] = useState('')
    const [deletingUserId, setDeletingUserId] = useState(null)
    const [sessionUser, setSessionUser] = useState(null)

    const { confirm } = useConfirm()

    const getAllUsersByOrganizationIdApi = useApi(userApi.getAllUsersByOrganizationId)

    const onSearchChange = (event) => {
        setSearch(event.target.value)
    }

    function filterUsers(data) {
        return (
            data.user.name?.toLowerCase().indexOf(search.toLowerCase()) > -1 ||
            data.user.email.toLowerCase().indexOf(search.toLowerCase()) > -1
        )
    }

    const addNew = () => {
        const dialogProp = {
            type: 'ADD',
            cancelButtonName: 'Cancel',
            confirmButtonName: 'Send Invite',
            data: null
        }
        setInviteDialogProps(dialogProp)
        setShowInviteDialog(true)
    }

    const deleteUser = async (user) => {
        const confirmPayload = {
            title: `Delete`,
            description: `Remove ${user.name ?? user.email} from organization?`,
            confirmButtonName: 'Delete',
            cancelButtonName: 'Cancel'
        }
        const isConfirmed = await confirm(confirmPayload)

        if (isConfirmed) {
            try {
                setDeletingUserId(user.id)
                const deleteResp = await userApi.deleteOrganizationUser(currentUser.activeOrganizationId, user.id)
                if (deleteResp.data) {
                    enqueueSnackbar({
                        message: 'User removed from organization successfully',
                        options: {
                            key: new Date().getTime() + Math.random(),
                            variant: 'success',
                            action: (key) => (
                                <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                    <IconX />
                                </Button>
                            )
                        }
                    })
                    onConfirm()
                }
            } catch (error) {
                const serverMessage = error?.response?.data?.message
                enqueueSnackbar({
                    message: serverMessage || 'The user could not be removed from the organization.',
                    options: {
                        key: new Date().getTime() + Math.random(),
                        variant: 'error',
                        persist: true,
                        action: (key) => (
                            <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                <IconX />
                            </Button>
                        )
                    }
                })
            } finally {
                setDeletingUserId(null)
            }
        }
    }

    const onConfirm = () => {
        setShowInviteDialog(false)
        getAllUsersByOrganizationIdApi.request(currentUser.activeOrganizationId)
    }

    useEffect(() => {
        getAllUsersByOrganizationIdApi.request(currentUser.activeOrganizationId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        setLoading(getAllUsersByOrganizationIdApi.loading)
    }, [getAllUsersByOrganizationIdApi.loading])

    useEffect(() => {
        if (getAllUsersByOrganizationIdApi.error) {
            setError(getAllUsersByOrganizationIdApi.error)
        }
    }, [getAllUsersByOrganizationIdApi.error, setError])

    useEffect(() => {
        if (getAllUsersByOrganizationIdApi.data) {
            const users = getAllUsersByOrganizationIdApi.data || []
            const orgAdmin = users.find((user) => user.isOrgOwner === true)
            if (orgAdmin) {
                users.splice(users.indexOf(orgAdmin), 1)
                users.unshift(orgAdmin)
            }
            setUsers(users)
        }
    }, [getAllUsersByOrganizationIdApi.data])

    return (
        <>
            <MainCard>
                {error ? (
                    <ErrorBoundary error={error} />
                ) : (
                    <Stack flexDirection='column' sx={{ gap: 3 }}>
                        <ViewHeader
                            onSearchChange={onSearchChange}
                            search={true}
                            searchPlaceholder='Search Users'
                            title='User Management'
                            description={
                                <>
                                    Owner, Admin, Builder, and Viewer are built-in. Their permission sets are fixed.{' '}
                                    <Link to='/roles'>Add a custom role</Link> when someone needs a different set.
                                </>
                            }
                        >
                            <StyledPermissionButton
                                permissionId={'workspace:add-user,users:manage'}
                                variant='contained'
                                sx={{ borderRadius: 2, height: '100%' }}
                                onClick={addNew}
                                startIcon={<IconPlus />}
                                id='btn_createUser'
                            >
                                {isOpenSource ? 'Add User' : 'Invite User'}
                            </StyledPermissionButton>
                        </ViewHeader>
                        {!isLoading && users.length === 0 ? (
                            <Stack sx={{ alignItems: 'center', justifyContent: 'center' }} flexDirection='column'>
                                <Box sx={{ p: 2, height: 'auto' }}>
                                    <img
                                        style={{ objectFit: 'cover', height: '20vh', width: 'auto' }}
                                        src={users_emptySVG}
                                        alt='users_emptySVG'
                                    />
                                </Box>
                                <div>
                                    No users yet. Add a person with a name and an email. They use the sign-in method configured for this
                                    server.
                                </div>
                            </Stack>
                        ) : narrow ? (
                            <Stack sx={{ gap: 1.5, width: '100%' }}>
                                {isLoading ? (
                                    <>
                                        <Skeleton variant='rounded' height={96} />
                                        <Skeleton variant='rounded' height={96} />
                                    </>
                                ) : (
                                    users
                                        .filter(filterUsers)
                                        .map((item, index) => (
                                            <ShowUserRow
                                                key={index}
                                                narrow
                                                row={item}
                                                onDeleteClick={deleteUser}
                                                onSessionsClick={setSessionUser}
                                                deletingUserId={deletingUserId}
                                            />
                                        ))
                                )}
                            </Stack>
                        ) : (
                            <>
                                <Stack flexDirection='row'>
                                    <Box sx={{ py: 2, height: 'auto', width: '100%' }}>
                                        <TableContainer
                                            style={{ display: 'flex', flexDirection: 'row' }}
                                            sx={{ border: 1, borderColor: theme.palette.grey[900] + 25, borderRadius: 2 }}
                                            component={Paper}
                                        >
                                            <Table sx={{ minWidth: 650 }} aria-label='users table'>
                                                <TableHead
                                                    sx={{
                                                        backgroundColor: customization.isDarkMode
                                                            ? theme.palette.common.black
                                                            : theme.palette.grey[100],
                                                        height: 56
                                                    }}
                                                >
                                                    <TableRow>
                                                        <StyledTableCell>&nbsp;</StyledTableCell>
                                                        <StyledTableCell>Email/Name</StyledTableCell>
                                                        <StyledTableCell>Assigned Roles</StyledTableCell>
                                                        <StyledTableCell>Status</StyledTableCell>
                                                        <StyledTableCell>Last Login</StyledTableCell>
                                                        <StyledTableCell> </StyledTableCell>
                                                    </TableRow>
                                                </TableHead>
                                                <TableBody>
                                                    {isLoading ? (
                                                        <>
                                                            <StyledTableRow>
                                                                <StyledTableCell>
                                                                    <Skeleton variant='text' />
                                                                </StyledTableCell>
                                                                <StyledTableCell>
                                                                    <Skeleton variant='text' />
                                                                </StyledTableCell>
                                                                <StyledTableCell>
                                                                    <Skeleton variant='text' />
                                                                </StyledTableCell>
                                                                <StyledTableCell>
                                                                    <Skeleton variant='text' />
                                                                </StyledTableCell>
                                                                <StyledTableCell>
                                                                    <Skeleton variant='text' />
                                                                </StyledTableCell>
                                                                <StyledTableCell>
                                                                    <Skeleton variant='text' />
                                                                </StyledTableCell>
                                                            </StyledTableRow>
                                                            <StyledTableRow>
                                                                <StyledTableCell>
                                                                    <Skeleton variant='text' />
                                                                </StyledTableCell>
                                                                <StyledTableCell>
                                                                    <Skeleton variant='text' />
                                                                </StyledTableCell>
                                                                <StyledTableCell>
                                                                    <Skeleton variant='text' />
                                                                </StyledTableCell>
                                                                <StyledTableCell>
                                                                    <Skeleton variant='text' />
                                                                </StyledTableCell>
                                                                <StyledTableCell>
                                                                    <Skeleton variant='text' />
                                                                </StyledTableCell>
                                                            </StyledTableRow>
                                                        </>
                                                    ) : (
                                                        <>
                                                            {users.filter(filterUsers).map((item, index) => (
                                                                <ShowUserRow
                                                                    key={index}
                                                                    row={item}
                                                                    onDeleteClick={deleteUser}
                                                                    onSessionsClick={setSessionUser}
                                                                    deletingUserId={deletingUserId}
                                                                />
                                                            ))}
                                                        </>
                                                    )}
                                                </TableBody>
                                            </Table>
                                        </TableContainer>
                                    </Box>
                                </Stack>
                            </>
                        )}
                    </Stack>
                )}
            </MainCard>
            {showInviteDialog &&
                (isOpenSource && inviteDialogProps.type === 'ADD' ? (
                    <CreateUserDialog show={showInviteDialog} onCancel={() => setShowInviteDialog(false)} onConfirm={onConfirm} />
                ) : (
                    <InviteUsersDialog
                        show={showInviteDialog}
                        dialogProps={inviteDialogProps}
                        onCancel={() => setShowInviteDialog(false)}
                        onConfirm={onConfirm}
                    ></InviteUsersDialog>
                ))}
            <UserSessionsDrawer
                open={Boolean(sessionUser)}
                userId={sessionUser?.userId || sessionUser?.user?.id || ''}
                userName={sessionUser?.user?.name || ''}
                onClose={() => setSessionUser(null)}
            />
            <ConfirmDialog />
        </>
    )
}

export default Users
