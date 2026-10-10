import { chatImages } from './chatImages'

describe('chatImages', () => {
    it('turns PNG and JPEG artifacts into data URLs, in order', () => {
        expect(
            chatImages([
                { type: 'png', mime: 'image/png', name: 'chart.png', specialist: 'analyst', base64: 'iVBO' },
                { type: 'jpeg', mime: 'image/jpeg', name: 'photo.jpg', specialist: 'analyst', base64: '/9j/' }
            ])
        ).toEqual([
            { type: 'png', data: 'data:image/png;base64,iVBO' },
            { type: 'jpeg', data: 'data:image/jpeg;base64,/9j/' }
        ])
    })

    it('skips anything that is not an image with bytes', () => {
        expect(chatImages(undefined)).toEqual([])
        expect(chatImages('chart.png')).toEqual([])
        expect(
            chatImages([
                { type: 'png', mime: 'image/png', name: 'names-only.png' },
                { type: 'svg', mime: 'image/svg+xml', base64: 'PHN2Zz4=' },
                null
            ])
        ).toEqual([])
    })
})
