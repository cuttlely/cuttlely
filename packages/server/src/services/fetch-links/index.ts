import { webCrawl, xmlScrape, checkDenyList } from '@cuttlely/components'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'

const getAllLinks = async (requestUrl: string, relativeLinksMethod: string, queryLimit: string): Promise<any> => {
    try {
        const url = decodeURIComponent(requestUrl)
        await checkDenyList(url)

        if (!relativeLinksMethod) {
            throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Please choose a Relative Links Method in Additional Parameters!`)
        }
        const limit = parseInt(queryLimit)
        if (process.env.DEBUG === 'true') console.info(`Start ${relativeLinksMethod}`)
        const links: string[] = relativeLinksMethod === 'webCrawl' ? await webCrawl(url, limit) : await xmlScrape(url, limit)
        if (process.env.DEBUG === 'true') console.info(`Finish ${relativeLinksMethod}`)
        const dbResponse = {
            status: 'OK',
            links
        }
        return dbResponse
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: fetchLinksService.getAllLinks - ${getErrorMessage(error)}`)
    }
}

export default {
    getAllLinks
}
