import { createContext, useContext, useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { getReconnectCount, subscribeReconnect } from '@/api/connectionState'

const ConnectionContext = createContext(0)

export const ConnectionProvider = ({ children }) => {
    const [count, setCount] = useState(getReconnectCount)

    useEffect(() => subscribeReconnect(setCount), [])

    return <ConnectionContext.Provider value={count}>{children}</ConnectionContext.Provider>
}

export const useReconnectCount = () => useContext(ConnectionContext)

ConnectionProvider.propTypes = {
    children: PropTypes.any
}
