import { useSelector } from 'react-redux'
import { Outlet } from 'react-router-dom'

import { ThemeProvider } from '@mui/material/styles'
import { CssBaseline, StyledEngineProvider } from '@mui/material'

// defaultTheme
import themes from '@/themes'

// project imports
import NavigationScroll from '@/layout/NavigationScroll'

// ==============================|| APP ||============================== //

const App = () => {
    const customization = useSelector((state) => state.customization)

    return (
        <StyledEngineProvider injectFirst>
            <ThemeProvider theme={themes(customization)}>
                <CssBaseline />
                <NavigationScroll>
                    <Outlet />
                </NavigationScroll>
            </ThemeProvider>
        </StyledEngineProvider>
    )
}

export default App
