import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { useSelector } from 'react-redux'

import { Divider, List } from '@mui/material'
import { useTheme } from '@mui/material/styles'

import roleApi from '@/api/role'
import NavCollapse from './NavCollapse'

const AdminSection = ({ group }) => {
    const theme = useTheme()
    const user = useSelector((state) => state.auth.user)
    const [showRoles, setShowRoles] = useState(false)
    const includeRoles = (group.children || []).some((item) => item.id === 'roles')

    useEffect(() => {
        const organizationId = user?.activeOrganizationId
        if (!organizationId || !includeRoles) return
        let cancelled = false
        roleApi
            .getAllRolesByOrganizationId(organizationId)
            .then((response) => {
                if (cancelled) return
                const roles = response.data || []
                setShowRoles(roles.length > 0)
            })
            .catch(() => {
                if (!cancelled) setShowRoles(false)
            })
        return () => {
            cancelled = true
        }
    }, [user?.activeOrganizationId, includeRoles])

    const children = (group.children || []).filter((item) => item.id !== 'roles' || showRoles)
    if (!children.length) return null

    return (
        <>
            <Divider sx={{ height: '1px', borderColor: theme.palette.grey[900] + 25, my: 0 }} />
            <List sx={{ p: '16px', py: 2 }}>
                <NavCollapse menu={{ ...group, children }} level={1} />
            </List>
        </>
    )
}

AdminSection.propTypes = {
    group: PropTypes.object
}

export default AdminSection
