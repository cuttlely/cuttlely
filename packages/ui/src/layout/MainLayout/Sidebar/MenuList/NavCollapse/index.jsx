import PropTypes from 'prop-types'
import { useEffect, useState } from 'react'
import { useSelector } from 'react-redux'
import { useLocation } from 'react-router-dom'

// material-ui
import { useTheme } from '@mui/material/styles'
import { Collapse, List, ListItemButton, ListItemIcon, ListItemText, Typography } from '@mui/material'

// project imports
import NavItem from '../NavItem'
import { isGroupActive } from '../activeRoute'

// assets
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord'
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react'

// ==============================|| SIDEBAR MENU LIST COLLAPSE ITEMS ||============================== //

const NavCollapse = ({ menu, level }) => {
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)
    const { pathname } = useLocation()
    const childActive = isGroupActive(menu, pathname)

    // The group opens on the page of one of its items. Only that item is marked; the heading is bold only while
    // the group is closed, so the current page is never lost.
    const [open, setOpen] = useState(childActive)
    useEffect(() => {
        if (childActive) setOpen(true)
    }, [childActive])

    const handleClick = () => {
        setOpen(!open)
    }

    // menu collapse & item
    const menus = menu.children?.map((item) => {
        switch (item.type) {
            case 'collapse':
                return <NavCollapse key={item.id} menu={item} level={level + 1} />
            case 'item':
                return <NavItem key={item.id} item={item} level={level + 1} />
            default:
                return (
                    <Typography key={item.id} variant='h6' color='error' align='center'>
                        Menu Items Error
                    </Typography>
                )
        }
    })

    const Icon = menu.icon
    const menuIcon = menu.icon ? (
        <Icon strokeWidth={1.5} size='1.3rem' style={{ marginTop: 'auto', marginBottom: 'auto' }} />
    ) : (
        <FiberManualRecordIcon
            sx={{
                width: childActive ? 8 : 6,
                height: childActive ? 8 : 6
            }}
            fontSize={level > 0 ? 'inherit' : 'medium'}
        />
    )

    return (
        <>
            <ListItemButton
                sx={{
                    borderRadius: `${customization.borderRadius}px`,
                    mb: 0.5,
                    alignItems: 'flex-start',
                    backgroundColor: level > 1 ? 'transparent !important' : 'inherit',
                    py: level > 1 ? 1 : 1.25,
                    pl: `${level * 24}px`
                }}
                aria-expanded={open}
                onClick={handleClick}
            >
                <ListItemIcon sx={{ my: 'auto', minWidth: !menu.icon ? 18 : 36 }}>{menuIcon}</ListItemIcon>
                <ListItemText
                    primary={
                        <Typography variant={childActive && !open ? 'h5' : 'body1'} color='inherit' sx={{ my: 'auto' }}>
                            {menu.title}
                        </Typography>
                    }
                    secondary={
                        menu.caption && (
                            <Typography variant='caption' sx={{ ...theme.typography.subMenuCaption }} display='block' gutterBottom>
                                {menu.caption}
                            </Typography>
                        )
                    }
                />
                {open ? (
                    <IconChevronUp stroke={1.5} size='1rem' style={{ marginTop: 'auto', marginBottom: 'auto' }} />
                ) : (
                    <IconChevronDown stroke={1.5} size='1rem' style={{ marginTop: 'auto', marginBottom: 'auto' }} />
                )}
            </ListItemButton>
            <Collapse in={open} timeout='auto' unmountOnExit>
                <List
                    component='div'
                    disablePadding
                    sx={{
                        position: 'relative',
                        '&:after': {
                            content: "''",
                            position: 'absolute',
                            left: '32px',
                            top: 0,
                            height: '100%',
                            width: '1px',
                            opacity: 1,
                            background: theme.palette.primary.light
                        }
                    }}
                >
                    {menus}
                </List>
            </Collapse>
        </>
    )
}

NavCollapse.propTypes = {
    menu: PropTypes.object,
    level: PropTypes.number
}

export default NavCollapse
