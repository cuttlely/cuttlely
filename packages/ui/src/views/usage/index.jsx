import { useSelector } from 'react-redux'

import UsagePage from './UsagePage'

// The price editor follows the organization owner, the same check as the price routes.
const Usage = () => {
    const isOwner = useSelector((state) => Boolean(state.auth?.isGlobal))
    return <UsagePage isOwner={isOwner} />
}

export default Usage
