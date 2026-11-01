import React from 'react'
import App from '@/App'
import config from '@/config'
import routes from '@/routes'
import RouteErrorPage from '@/routes/RouteErrorPage'
import { store } from '@/store'
import { createRoot } from 'react-dom/client'

// style + assets
import '@/assets/fonts/inter/inter.css'
import '@/assets/scss/style.scss'

// third party
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { Provider } from 'react-redux'
import { SnackbarProvider } from 'notistack'
import ConfirmContextProvider from '@/store/context/ConfirmContextProvider'
import { ReactFlowContext } from '@/store/context/ReactFlowContext'
import { ConfigProvider } from '@/store/context/ConfigContext'
import { ErrorProvider } from '@/store/context/ErrorContext'

// The providers sit inside the router because ErrorProvider navigates. A data router is what lets
// the canvas block navigation while it has unsaved changes (useBlocker).
const AppShell = () => (
    <SnackbarProvider>
        <ConfigProvider>
            <ErrorProvider>
                <ConfirmContextProvider>
                    <ReactFlowContext>
                        <App />
                    </ReactFlowContext>
                </ConfirmContextProvider>
            </ErrorProvider>
        </ConfigProvider>
    </SnackbarProvider>
)

// errorElement replaces the default router crash screen when a page throws while it renders or loads.
const router = createBrowserRouter([{ element: <AppShell />, errorElement: <RouteErrorPage />, children: routes }], {
    basename: config.basename || '/'
})

const container = document.getElementById('root')
const root = createRoot(container)

root.render(
    <React.StrictMode>
        <Provider store={store}>
            <RouterProvider router={router} />
        </Provider>
    </React.StrictMode>
)
