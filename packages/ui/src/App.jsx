import { useSelector } from 'react-redux'
import { Outlet } from 'react-router-dom'

import { ThemeProvider } from '@mui/material/styles'
import { CssBaseline, StyledEngineProvider } from '@mui/material'

// defaultTheme
import themes from '@/themes'

// project imports
import NavigationScroll from '@/layout/NavigationScroll'
import ReconnectingChip from '@/ui-component/connection/ReconnectingChip'

// ==============================|| APP ||============================== //

const App = () => {
    const customization = useSelector((state) => state.customization)

    return (
        <StyledEngineProvider injectFirst>
            <ThemeProvider theme={themes(customization)}>
                <CssBaseline />
                <ReconnectingChip />
                <NavigationScroll>
                    <Outlet />
                </NavigationScroll>
            </ThemeProvider>
        </StyledEngineProvider>
    )
}

export default App
