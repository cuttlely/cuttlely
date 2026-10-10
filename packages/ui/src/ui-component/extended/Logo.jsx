import PropTypes from 'prop-types'
import { useSelector } from 'react-redux'

import logo from '@/assets/images/brand/cuttlely-logo-horizontal.svg'
import logoDark from '@/assets/images/brand/cuttlely-logo-horizontal-dark.svg'

// ==============================|| LOGO ||============================== //
// The Cuttlely horizontal logo: the C-wave mark and the wordmark. Light and dark versions follow the theme.

const Logo = ({ height = 32 }) => {
    const customization = useSelector((state) => state.customization)

    return (
        <div style={{ alignItems: 'center', display: 'flex', flexDirection: 'row', marginLeft: '10px' }}>
            <img
                style={{ display: 'block', objectFit: 'contain', height, width: 'auto' }}
                src={customization.isDarkMode ? logoDark : logo}
                alt='Cuttlely'
            />
        </div>
    )
}

Logo.propTypes = {
    height: PropTypes.number
}

export default Logo
