import { createPortal } from 'react-dom'
import PropTypes from 'prop-types'
import { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Link } from 'react-router-dom'

import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Box,
    Typography,
    OutlinedInput,
    MenuItem,
    Alert,
    Select
} from '@mui/material'

import { StyledButton } from '@/ui-component/button/StyledButton'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import { IconX, IconUserPlus } from '@tabler/icons-react'

import accountApi from '@/api/account.api'
import { isBuiltInOwnerRole, roleLabel } from '@/utils/roleLabel'
import roleApi from '@/api/role'
import workspaceApi from '@/api/workspace'
import useNotifier from '@/utils/useNotifier'
import {
    enqueueSnackbar as enqueueSnackbarAction,
    closeSnackbar as closeSnackbarAction,
    HIDE_CANVAS_DIALOG,
    SHOW_CANVAS_DIALOG
} from '@/store/actions'

const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/

const CreateUserDialog = ({ show, workspace, onCancel, onConfirm }) => {
    const portalElement = document.getElementById('portal')
    const dispatch = useDispatch()
    useNotifier()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))
    const currentUser = useSelector((state) => state.auth.user)

    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [teams, setTeams] = useState([])
    const [roles, setRoles] = useState([])
    const [teamId, setTeamId] = useState(workspace?.id || '')
    const [roleId, setRoleId] = useState('')
    const [people, setPeople] = useState([])
    const [existingId, setExistingId] = useState('')
    const [loadingChoices, setLoadingChoices] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [formError, setFormError] = useState('')
    const [inviteLink, setInviteLink] = useState('')
    const [copied, setCopied] = useState(false)

    useEffect(() => {
        if (show) dispatch({ type: SHOW_CANVAS_DIALOG })
        else dispatch({ type: HIDE_CANVAS_DIALOG })
        return () => dispatch({ type: HIDE_CANVAS_DIALOG })
    }, [show, dispatch])

    useEffect(() => {
        if (!show) return
        let cancelled = false
        setName('')
        setEmail('')
        setFormError('')
        setTeamId(workspace?.id || '')
        setRoleId('')
        setExistingId('')
        setLoadingChoices(true)
        Promise.all([
            workspaceApi.getAllWorkspacesByOrganizationId(currentUser.activeOrganizationId),
            roleApi.getAllRolesByOrganizationId(currentUser.activeOrganizationId),
            // Best effort: a caller without users:manage can still add someone by email.
            accountApi.listOrganizationUsers(currentUser.activeOrganizationId).catch(() => ({ data: [] }))
        ])
            .then(([workspaceResponse, roleResponse, peopleResponse]) => {
                if (cancelled) return
                setPeople(
                    (Array.isArray(peopleResponse.data) ? peopleResponse.data : [])
                        .filter((item) => item.user && item.status?.toLowerCase() !== 'deleted')
                        .map((item) => item.user)
                )
                const nextTeams = (workspaceResponse.data || []).filter((item) => item.name !== 'Personal Workspace')
                const nextRoles = (roleResponse.data || []).filter((item) => currentUser?.isOrganizationAdmin || !isBuiltInOwnerRole(item))
                setTeams(nextTeams)
                setRoles(nextRoles)
                setTeamId((current) => current || (nextTeams.length === 1 ? nextTeams[0].id : ''))
                setRoleId(nextRoles.length === 1 ? nextRoles[0].id : '')
            })
            .catch((error) => {
                if (cancelled) return
                setFormError(error.response?.data?.message || error.message || 'Could not load teams and roles')
            })
            .finally(() => {
                if (!cancelled) setLoadingChoices(false)
            })
        return () => {
            cancelled = true
        }
    }, [show, workspace?.id, currentUser.activeOrganizationId, currentUser?.isOrganizationAdmin])

    const canSubmit =
        !isSaving &&
        !loadingChoices &&
        (existingId || (name.trim().length > 0 && name.trim().length <= 100 && EMAIL_PATTERN.test(email.trim()))) &&
        teamId &&
        roleId

    const saveUser = async () => {
        const problem = existingId
            ? !teamId
                ? 'Choose a team.'
                : !roleId
                ? 'Choose a role.'
                : ''
            : !name.trim()
            ? 'Name is required.'
            : !EMAIL_PATTERN.test(email.trim())
            ? 'Enter a valid email.'
            : !teamId
            ? 'Choose a team.'
            : !roleId
            ? 'Choose a role. Create one on the Roles page first.'
            : ''
        if (problem) {
            setFormError(problem)
            return
        }
        setFormError('')
        setIsSaving(true)
        try {
            const typed = email.trim().toLowerCase()
            const known = existingId ? { id: existingId } : people.find((person) => (person.email || '').toLowerCase() === typed)
            let response
            let added = false
            if (known) {
                response = await accountApi.addWorkspaceUser({ userId: known.id, workspaceId: teamId, roleId })
                added = true
            } else {
                try {
                    response = await accountApi.inviteAccount({
                        user: {
                            name: name.trim(),
                            email: email.trim(),
                            createdBy: currentUser.id
                        },
                        workspace: { id: teamId },
                        role: { id: roleId }
                    })
                } catch (error) {
                    // The account exists but was not in the list this caller can see: add it to the team instead.
                    if (error.response?.status !== 409) throw error
                    response = await accountApi.addWorkspaceUser({ email: email.trim(), workspaceId: teamId, roleId })
                    added = true
                }
            }
            enqueueSnackbar({
                message: added ? 'User added to team' : 'User created',
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
            if (!added && response.data?.link) setInviteLink(response.data.link)
            else onConfirm()
        } catch (error) {
            const message = error.response?.data?.message || error.message || 'Could not create the user'
            setFormError(message)
            enqueueSnackbar({
                message,
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
            setIsSaving(false)
        }
    }

    const finishInvite = () => {
        setInviteLink('')
        setCopied(false)
        onConfirm()
    }

    const copyInvite = async () => {
        try {
            await navigator.clipboard.writeText(inviteLink)
            setCopied(true)
        } catch {
            setCopied(false)
        }
    }

    const inviteStep = (
        <>
            <DialogContent>
                <Alert severity='success' sx={{ mb: 2 }}>
                    Send this one-time invite link to {email.trim()}. They open it and sign in with that email to join. It is shown only
                    once and works once. Do not paste it into a shared chat.
                </Alert>
                <OutlinedInput
                    id='invite-link'
                    size='small'
                    fullWidth
                    readOnly
                    value={inviteLink}
                    onFocus={(event) => event.target.select()}
                />
            </DialogContent>
            <DialogActions>
                <Button onClick={copyInvite}>{copied ? 'Copied' : 'Copy link'}</Button>
                <StyledButton id='btn_invite_done' variant='contained' onClick={finishInvite}>
                    Done
                </StyledButton>
            </DialogActions>
        </>
    )

    const component = show ? (
        <Dialog fullWidth maxWidth='sm' open={show} onClose={inviteLink ? finishInvite : onCancel} aria-labelledby='create-user-title'>
            <DialogTitle sx={{ fontSize: '1rem' }} id='create-user-title'>
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                    <IconUserPlus style={{ marginRight: '10px' }} />
                    Add User
                </div>
            </DialogTitle>
            {inviteLink ? (
                inviteStep
            ) : (
                <>
                    <DialogContent>
                        {roles.length === 0 && !loadingChoices && (
                            <Alert severity='info' sx={{ mb: 2 }}>
                                Create a role on the{' '}
                                <Link to='/roles' onClick={onCancel}>
                                    Roles
                                </Link>{' '}
                                page before adding a user. The role is where you set what they can do.
                            </Alert>
                        )}
                        {formError && (
                            <Alert severity='error' sx={{ mb: 2 }}>
                                {formError}
                            </Alert>
                        )}
                        {people.length > 0 && (
                            <Box sx={{ p: 1 }}>
                                <Typography>Existing user</Typography>
                                <Select
                                    id='user-existing'
                                    size='small'
                                    sx={{ mt: 1 }}
                                    fullWidth
                                    value={existingId}
                                    displayEmpty
                                    onChange={(event) => setExistingId(event.target.value)}
                                    input={<OutlinedInput />}
                                >
                                    <MenuItem value=''>New user</MenuItem>
                                    {people.map((person) => (
                                        <MenuItem key={person.id} value={person.id}>
                                            {person.name ? `${person.name} (${person.email})` : person.email}
                                        </MenuItem>
                                    ))}
                                </Select>
                            </Box>
                        )}
                        {!existingId && (
                            <>
                                <Box sx={{ p: 1 }}>
                                    <Typography>
                                        Name<span style={{ color: 'red' }}>&nbsp;*</span>
                                    </Typography>
                                    <OutlinedInput
                                        id='user-name'
                                        size='small'
                                        sx={{ mt: 1 }}
                                        fullWidth
                                        value={name}
                                        onChange={(event) => setName(event.target.value)}
                                    />
                                </Box>
                                <Box sx={{ p: 1 }}>
                                    <Typography>
                                        Email<span style={{ color: 'red' }}>&nbsp;*</span>
                                    </Typography>
                                    <OutlinedInput
                                        id='user-email'
                                        size='small'
                                        sx={{ mt: 1 }}
                                        type='email'
                                        fullWidth
                                        value={email}
                                        onChange={(event) => setEmail(event.target.value)}
                                    />
                                </Box>
                                <Box sx={{ p: 1 }}>
                                    <Typography variant='caption' color='text.secondary'>
                                        They join from a one-time invite link and sign in with WorkOS. No password is stored here. If the
                                        email already has an account, that person is added to the team instead.
                                    </Typography>
                                </Box>
                            </>
                        )}
                        <Box sx={{ p: 1 }}>
                            <Typography>
                                Team<span style={{ color: 'red' }}>&nbsp;*</span>
                            </Typography>
                            <Select
                                id='user-team'
                                size='small'
                                sx={{ mt: 1 }}
                                fullWidth
                                value={teamId}
                                displayEmpty
                                disabled={Boolean(workspace?.id)}
                                onChange={(event) => setTeamId(event.target.value)}
                                input={<OutlinedInput />}
                            >
                                <MenuItem value='' disabled>
                                    Choose a team
                                </MenuItem>
                                {teams.map((team) => (
                                    <MenuItem key={team.id} value={team.id}>
                                        {team.name}
                                    </MenuItem>
                                ))}
                            </Select>
                        </Box>
                        <Box sx={{ p: 1 }}>
                            <Typography>
                                Role<span style={{ color: 'red' }}>&nbsp;*</span>
                            </Typography>
                            <Select
                                id='user-role'
                                size='small'
                                sx={{ mt: 1 }}
                                fullWidth
                                value={roleId}
                                displayEmpty
                                onChange={(event) => setRoleId(event.target.value)}
                                input={<OutlinedInput />}
                            >
                                <MenuItem value='' disabled>
                                    Choose a role
                                </MenuItem>
                                {roles.map((role) => (
                                    <MenuItem key={role.id} value={role.id}>
                                        {roleLabel(role)}
                                    </MenuItem>
                                ))}
                            </Select>
                        </Box>
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={onCancel}>Cancel</Button>
                        <StyledButton id='btn_submit_user' disabled={!canSubmit} variant='contained' onClick={saveUser}>
                            {isSaving ? 'Saving...' : existingId ? 'Add to Team' : 'Create User'}
                        </StyledButton>
                    </DialogActions>
                </>
            )}
            <ConfirmDialog />
        </Dialog>
    ) : null

    return portalElement ? createPortal(component, portalElement) : null
}

CreateUserDialog.propTypes = {
    show: PropTypes.bool,
    workspace: PropTypes.object,
    onCancel: PropTypes.func,
    onConfirm: PropTypes.func
}

export default CreateUserDialog
