import { styled } from '@mui/material/styles'
import { Fab } from '@mui/material'

export const StyledFab = styled(Fab)(({ theme, color = 'primary' }) => ({
    color: theme.palette[color].contrastText,
    backgroundColor: theme.palette[color].main,
    '&:hover': {
        backgroundColor: theme.palette[color].main,
        backgroundImage: `linear-gradient(rgb(0 0 0/10%) 0 0)`
    }
}))
