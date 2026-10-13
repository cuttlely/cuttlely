import PropTypes from 'prop-types'

import { baseURL } from '@/store/constant'

// Real node icons are pictures. A white disc inside the accent ring keeps them readable in both themes.
const CardAccentIcon = ({ name, color, size = 40 }) => {
    const inner = size - 6
    return (
        <div
            data-testid='card-accent-icon'
            data-accent={color}
            style={{
                width: size,
                height: size,
                borderRadius: '50%',
                backgroundColor: color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'grab',
                flexShrink: 0
            }}
        >
            <div
                style={{
                    width: inner,
                    height: inner,
                    borderRadius: '50%',
                    backgroundColor: '#ffffff',
                    overflow: 'hidden'
                }}
            >
                <img
                    style={{ width: '100%', height: '100%', padding: 4, objectFit: 'contain' }}
                    src={`${baseURL}/api/v1/node-icon/${name || 'unknown'}`}
                    alt={name || 'Node'}
                />
            </div>
        </div>
    )
}

CardAccentIcon.propTypes = {
    name: PropTypes.string,
    color: PropTypes.string.isRequired,
    size: PropTypes.number
}

export default CardAccentIcon
