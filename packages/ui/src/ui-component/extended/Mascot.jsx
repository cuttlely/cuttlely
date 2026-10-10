import PropTypes from 'prop-types'

import neutral from '@/assets/images/brand/cuttlely-mascot-neutral.webp'
import wink from '@/assets/images/brand/cuttlely-mascot-wink.webp'
import laptop from '@/assets/images/brand/cuttlely-mascot-laptop.webp'
import lightbulb from '@/assets/images/brand/cuttlely-mascot-lightbulb.webp'
import goggles from '@/assets/images/brand/cuttlely-mascot-goggles.webp'

// ==============================|| MASCOT ||============================== //
// The Cuttlely cuttlefish, for large, friendly moments only (first run, empty states, errors).
// Each pose has one meaning: neutral is the default, wink is success, laptop is building or loading,
// lightbulb is a tip, goggles is a demo. It is never drawn smaller than 96px.

export const MASCOT_MIN_SIZE = 96

const poses = { neutral, wink, laptop, lightbulb, goggles }

const Mascot = ({ pose = 'neutral', size = 120 }) => {
    const px = Math.max(MASCOT_MIN_SIZE, size)
    return (
        <img
            src={poses[pose] || poses.neutral}
            alt=''
            aria-hidden='true'
            width={px}
            height={px}
            style={{ display: 'block', width: px, height: px, objectFit: 'contain' }}
        />
    )
}

Mascot.propTypes = {
    pose: PropTypes.oneOf(Object.keys(poses)),
    size: PropTypes.number
}

export default Mascot
