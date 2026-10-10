import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { colorVariables, normalizeConfig, safeColor } from '../src/config.js'

describe('normalizeConfig', () => {
    it('maps share settings saved by the Cuttlely share dialog', () => {
        const cfg = normalizeConfig({
            title: 'Crumb & Co',
            titleAvatarSrc: 'https://bakery.example/logo.png',
            welcomeMessage: 'Ask about today\u2019s bakes',
            starterPrompts: { 0: { prompt: 'What is fresh today?' }, 1: { prompt: '' }, 2: { prompt: 'Gluten free?' } },
            chatFeedback: { status: true },
            textInput: { placeholder: 'Type here', sendButtonColor: '#aa5500' },
            botMessage: { backgroundColor: '#fafafa', showAvatar: true, avatarSrc: 'javascript:alert(1)' },
            uploads: { isImageUploadAllowed: true, imgUploadSizeAndTypes: [{ fileTypes: ['image/png', 'image/jpeg'], maxUploadSize: 5 }] }
        })
        assert.equal(cfg.title, 'Crumb & Co')
        assert.equal(cfg.avatar, 'https://bakery.example/logo.png')
        assert.deepEqual(cfg.starterPrompts, ['What is fresh today?', 'Gluten free?'])
        assert.equal(cfg.feedback, true)
        assert.equal(cfg.placeholder, 'Type here')
        assert.equal(cfg.colors.accent, '#aa5500')
        assert.equal(cfg.colors.botBg, '#fafafa')
        assert.equal(cfg.botAvatar, '', 'unsafe avatar URL dropped')
        assert.deepEqual(cfg.imageUpload, { types: ['image/png', 'image/jpeg'], maxMB: 5 })
    })

    it('treats the old stock default colors as unset', () => {
        const cfg = normalizeConfig({
            titleBackgroundColor: '#3B81F6',
            titleTextColor: '#ffffff',
            backgroundColor: '#ffffff',
            botMessage: { backgroundColor: '#f7f8ff', textColor: '#303235' },
            userMessage: { backgroundColor: '#3B81F6', textColor: '#ffffff' },
            textInput: { backgroundColor: '#ffffff', textColor: '#303235', sendButtonColor: '#3B81F6' }
        })
        assert.ok(Object.values(cfg.colors).every((value) => value === ''))
    })

    it('works when the server answers "OK" (nothing saved)', () => {
        const cfg = normalizeConfig('OK')
        assert.equal(cfg.title, '')
        assert.deepEqual(cfg.starterPrompts, [])
        assert.equal(cfg.imageUpload, null)
    })

    it('applies embed overrides on top', () => {
        const cfg = normalizeConfig({ title: 'Saved' }, { title: 'From embed', colors: { accent: '#123456', bad: '#000' }, feedback: true })
        assert.equal(cfg.title, 'From embed')
        assert.equal(cfg.colors.accent, '#123456')
        assert.equal(cfg.feedback, true)
    })
})

describe('colors', () => {
    it('refuses anything that is not a plain color', () => {
        for (const bad of ['red;background:url(https://x)', 'expression(alert(1))', '#12345g', 'url(x)', '#fff;}', '']) {
            assert.equal(safeColor(bad), '', bad)
        }
        assert.equal(safeColor('rgb(10, 20, 30)'), 'rgb(10, 20, 30)')
        assert.equal(safeColor('#0a0'), '#0a0')
    })

    it('writes CSS variables only for colors that are set', () => {
        assert.equal(colorVariables({ accent: '#123456', userBg: '' }), '--dc-accent:#123456;')
    })
})
