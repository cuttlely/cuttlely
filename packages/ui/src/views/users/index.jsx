import React, { useEffect, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Link } from 'react-router-dom'
import * as PropTypes from 'prop-types'
import { formatListDateTime } from '@/utils/formatDate'
import { canChangeRole } from '@/utils/roleLabel'
import {
    canRemoveOrganizationUser,
    canOfferPasswordReset,
    canChangeUserAccess,
    isUserDisabled,
    accessConfirmation,
    isPendingInvite,
    organizationOwnerLabel,
    removalConfirmation,
    removeOrganizationUser
} from './userActions'

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
import ResetPasswordDialog from './ResetPasswordDialog'
import UserTeamAccessDrawer from './UserTeamAccessDrawer'
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
import { IconTrash, IconX, IconPlus, IconUser, IconUserStar, IconUserCog, IconKey, IconUserOff, IconUserCheck } from '@tabler/icons-react'
import users_emptySVG from '@/assets/images/users_empty.svg'

// store
import { useError } from '@/store/context/ErrorContext'
import { useConfig } from '@/store/context/ConfigContext'
import { enqueueSnackbar as enqueueSnackbarAction, closeSnackbar as closeSnackbarAction } from '@/store/actions'

function ShowUserRow(props) {
    const [open, setOpen] = useState(false)
    const [editable, setEditable] = useState(false)
    const [accessRevision, setAccessRevision] = useState(0)
    const [roleDialogProps, setRoleDialogProps] = useState(null)

    const { isOpenSource } = useConfig()

    const handleViewUserRoles = (edit = false) => {
        setEditable(edit)
        setOpen(edit || !open)
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
        setAccessRevision((value) => value + 1)
    }

    const currentUser = useSelector((state) => state.auth.user)
    const showChangeRole = canChangeRole(props.row, currentUser.id)
    useEffect(() => {
        setOpen(false)
        setRoleDialogProps(null)
    }, [currentUser.activeOrganizationId, currentUser.activeWorkspaceId])

    const assignedRolesDrawer = open && (
        <UserTeamAccessDrawer
            key={`${props.row.userId}:${currentUser.activeWorkspaceId}`}
            userId={props.row.userId}
            userName={props.row.user.name || props.row.user.email}
            organizationId={props.row.organizationId}
            currentTeamId={currentUser.activeWorkspaceId}
            allTeams={currentUser.isOrganizationAdmin || props.row.userId === currentUser.id}
            loadAccess={userApi.getWorkspacesByOrganizationIdUserId}
            refreshKey={accessRevision}
            renderRoleAction={
                editable && showChangeRole
                    ? (membership) => (
                          <PermissionButton
                              permissionId='workspace:update'
                              size='small'
                              variant='outlined'
                              onClick={() => openRoleDialog(membership)}
                          >
                              Change role
                          </PermissionButton>
                      )
                    : undefined
            }
            onClose={() => {
                setOpen(false)
                setRoleDialogProps(null)
            }}
        />
    )
    const roleToggle = (
        <PermissionButton permissionId='users:manage' size='small' onClick={() => handleViewUserRoles()}>
            View team access
        </PermissionButton>
    )
    const roleDialog = roleDialogProps && (
        <EditWorkspaceUserRoleDialog
            show
            dialogProps={roleDialogProps}
            onCancel={() => setRoleDialogProps(null)}
            onConfirm={onRoleChanged}
        />
    )

    const rowActions = (
        <>
            {canRemoveOrganizationUser(props.row, currentUser.id) &&
                (props.deletingUserId === props.row.user.id ? (
                    <CircularProgress size={24} color='error' />
                ) : (
                    <PermissionIconButton
                        permissionId={'workspace:unlink-user,users:manage'}
                        title={isPendingInvite(props.row) ? 'Cancel invitation' : 'Delete'}
                        color='error'
                        disabled={Boolean(props.deletingUserId || props.changingAccessUserId)}
                        onClick={() => props.onDeleteClick(props.row)}
                    >
                        <IconTrash />
                    </PermissionIconButton>
                ))}
            {props.localUsers && canChangeUserAccess(props.row, currentUser.id) && (
                <PermissionIconButton
                    permissionId='users:manage'
                    title={isUserDisabled(props.row) ? 'Reactivate user' : 'Disable user'}
                    aria-label={isUserDisabled(props.row) ? 'Reactivate user' : 'Disable user'}
                    color={isUserDisabled(props.row) ? 'primary' : 'warning'}
                    disabled={Boolean(props.changingAccessUserId || props.deletingUserId)}
                    onClick={() => props.onAccessClick(props.row)}
                >
                    {props.changingAccessUserId === props.row.userId ? (
                        <CircularProgress size={20} />
                    ) : isUserDisabled(props.row) ? (
                        <IconUserCheck />
                    ) : (
                        <IconUserOff />
                    )}
                </PermissionIconButton>
            )}
            {showChangeRole && (
                <PermissionIconButton
                    permissionId={'workspace:update'}
                    title='Change role'
                    aria-label='Change role'
                    color='primary'
                    onClick={() => handleViewUserRoles(true)}
                >
                    <IconUserCog />
                </PermissionIconButton>
            )}
            {canOfferPasswordReset(props.row) && (
                <PermissionIconButton
                    permissionId={'users:manage'}
                    title='Reset password'
                    aria-label='Reset password'
                    color='primary'
                    onClick={() => props.onResetPasswordClick(props.row)}
                >
                    <IconKey />
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
                                <Chip size='small' sx={{ mt: 0.5 }} label={organizationOwnerLabel(props.row, isOpenSource)} />
                            )}
                            <Stack direction='row' alignItems='center' flexWrap='wrap' sx={{ gap: 1, mt: 1 }}>
                                <Typography variant='body2'>Teams: {props.row.roleCount}</Typography>
                                {roleToggle}
                                {'ACTIVE' === props.row.status.toUpperCase() && (
                                    <Chip color={'success'} label={props.row.status.toUpperCase()} />
                                )}
                                {'INVITED' === props.row.status.toUpperCase() && (
                                    <Chip color={'warning'} label={props.row.status.toUpperCase()} />
                                )}
                                {['INACTIVE', 'DISABLE', 'DISABLED'].includes(props.row.status.toUpperCase()) && (
                                    <Chip color={'error'} label='DISABLED' />
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
                {roleDialog}
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
                            <Chip size='small' label={organizationOwnerLabel(props.row, isOpenSource)} />{' '}
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
                        <Chip color={'error'} label='DISABLED' />
                    )}
                </StyledTableCell>
                <StyledTableCell>{!props.row.lastLogin ? 'Never' : formatListDateTime(props.row.lastLogin)}</StyledTableCell>
                <StyledTableCell>{rowActions}</StyledTableCell>
            </StyledTableRow>
            {assignedRolesDrawer}
            {roleDialog}
        </React.Fragment>
    )
}

ShowUserRow.propTypes = {
    row: PropTypes.any,
    onDeleteClick: PropTypes.func,
    onSessionsClick: PropTypes.func,
    onAccessClick: PropTypes.func,
    changingAccessUserId: PropTypes.string,
    localUsers: PropTypes.bool,
    onResetPasswordClick: PropTypes.func,
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
    const deletionPending = useRef(false)
    const accessPending = useRef(false)
    const [changingAccessUserId, setChangingAccessUserId] = useState(null)
    const activeScope = `${currentUser.activeOrganizationId}:${currentUser.activeWorkspaceId}`
    const mounted = useRef(true)
    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
        }
    }, [])
    const scopeRef = useRef(activeScope)
    scopeRef.current = activeScope
    const [sessionUser, setSessionUser] = useState(null)
    const [resetUser, setResetUser] = useState(null)

    useEffect(() => {
        setResetUser(null)
        setSessionUser(null)
        setChangingAccessUserId(null)
    }, [currentUser.activeOrganizationId, currentUser.activeWorkspaceId])

    const { confirm } = useConfirm()

    const getAllUsersByOrganizationIdApi = useApi(userApi.getAllUsersByOrganizationId, { currentOnly: true })
    const signInOptionsApi = useApi(userApi.getSignInOptions, { localUnavailable: true })

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

    const deleteUser = async (row) => {
        if (deletionPending.current || accessPending.current || !canRemoveOrganizationUser(row, currentUser.id)) return
        deletionPending.current = true
        const pendingInvite = isPendingInvite(row)
        const confirmPayload = removalConfirmation(row)
        try {
            const isConfirmed = await confirm(confirmPayload)
            if (isConfirmed) {
                setDeletingUserId(row.userId)
                const deleteResp = await removeOrganizationUser(row, onConfirm, userApi.deleteOrganizationUser)
                if (deleteResp.data) {
                    enqueueSnackbar({
                        message: pendingInvite
                            ? 'Invitation canceled and invite links revoked'
                            : 'User removed from organization successfully',
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
                }
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
            deletionPending.current = false
        }
    }

    const changeUserAccess = async (row) => {
        if (accessPending.current || deletionPending.current || !canChangeUserAccess(row, currentUser.id)) return
        accessPending.current = true
        const scope = activeScope
        const enabling = isUserDisabled(row)
        let attempted = false
        try {
            const accepted = await confirm(accessConfirmation(row))
            if (!accepted || !mounted.current || scopeRef.current !== scope) return
            setChangingAccessUserId(row.userId)
            attempted = true
            const response = await (enabling ? userApi.enableUser : userApi.disableUser)(row.userId)
            if (!mounted.current || scopeRef.current !== scope) return
            if (response.data?.disabled !== !enabling) throw new Error('Unconfirmed access change')
            enqueueSnackbar({
                message: enabling
                    ? 'User reactivated. Existing roles and team assignments are kept.'
                    : 'User disabled. Sessions, links and owned access keys have been revoked.',
                options: { variant: 'success' }
            })
        } catch (error) {
            if (mounted.current && scopeRef.current === scope)
                enqueueSnackbar({
                    message:
                        error.response?.data?.message ||
                        'The access change could not be confirmed. Refresh the user list before trying again.',
                    options: { variant: 'error', persist: true }
                })
        } finally {
            try {
                if (attempted && mounted.current && scopeRef.current === scope)
                    await getAllUsersByOrganizationIdApi.request(currentUser.activeOrganizationId)
            } finally {
                accessPending.current = false
                if (mounted.current) setChangingAccessUserId(null)
            }
        }
    }

    const onConfirm = () => {
        setShowInviteDialog(false)
        return getAllUsersByOrganizationIdApi.request(currentUser.activeOrganizationId)
    }

    useEffect(() => {
        signInOptionsApi.request()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        getAllUsersByOrganizationIdApi.request(currentUser.activeOrganizationId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser.activeOrganizationId, currentUser.activeWorkspaceId])

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
                                        .map((item) => (
                                            <ShowUserRow
                                                key={item.userId}
                                                narrow
                                                row={item}
                                                onDeleteClick={deleteUser}
                                                onSessionsClick={setSessionUser}
                                                onAccessClick={changeUserAccess}
                                                changingAccessUserId={changingAccessUserId}
                                                localUsers={signInOptionsApi.data?.localUsers === true}
                                                onResetPasswordClick={setResetUser}
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
                                                        <StyledTableCell>Teams</StyledTableCell>
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
                                                            {users.filter(filterUsers).map((item) => (
                                                                <ShowUserRow
                                                                    key={item.userId}
                                                                    row={item}
                                                                    onDeleteClick={deleteUser}
                                                                    onSessionsClick={setSessionUser}
                                                                    onAccessClick={changeUserAccess}
                                                                    changingAccessUserId={changingAccessUserId}
                                                                    localUsers={signInOptionsApi.data?.localUsers === true}
                                                                    onResetPasswordClick={setResetUser}
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
            {resetUser && (
                <ResetPasswordDialog
                    key={`${currentUser.activeOrganizationId}:${currentUser.activeWorkspaceId}:${resetUser.userId}`}
                    userId={resetUser.userId}
                    userEmail={resetUser.user.email}
                    createLink={userApi.createPasswordResetLink}
                    onClose={() => setResetUser(null)}
                />
            )}
            <ConfirmDialog />
        </>
    )
}

export default Users
