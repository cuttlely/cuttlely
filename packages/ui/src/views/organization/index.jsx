import { Navigate, useLocation } from 'react-router-dom'

// Older first-run addresses open the single setup page and keep the query and the fragment.
const OrganizationSetupPage = () => {
    const location = useLocation()
    return <Navigate to={{ pathname: '/setup', search: location.search, hash: location.hash }} replace />
}

export default OrganizationSetupPage
