import { get } from 'lodash'

export const customGet = (obj: any, path: string) => {
    if (path.includes('[-1]')) {
        const parts = path.split('.')
        let result = obj

        for (let part of parts) {
            if (part.includes('[') && part.includes(']')) {
                const [name, indexPart] = part.split('[')
                const index = parseInt(indexPart.replace(']', ''))

                result = result[name]
                if (Array.isArray(result)) {
                    if (index < 0) {
                        result = result[result.length + index]
                    } else {
                        result = result[index]
                    }
                } else {
                    return undefined
                }
            } else {
                result = get(result, part)
            }

            if (result === undefined) {
                return undefined
            }
        }

        return result
    } else {
        return get(obj, path)
    }
}
