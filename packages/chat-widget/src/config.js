// Maps a flow's saved share settings (public-chatbotConfig) onto the widget. Field names are the ones the
// Cuttlely share dialog saves. Values that equal the old stock defaults count as unset so the Cuttlely look wins.

import { safeUrl } from './markdown.js'

const LEGACY_DEFAULTS = {
    titleBackgroundColor: ['#3b81f6'],
    titleTextColor: ['#ffffff'],
    backgroundColor: ['#ffffff'],
    poweredByTextColor: ['#303235'],
    botBackground: ['#f7f8ff'],
    botText: ['#303235'],
    userBackground: ['#3b81f6'],
    userText: ['#ffffff'],
    inputBackground: ['#ffffff'],
    inputText: ['#303235'],
    sendButton: ['#3b81f6']
}

const COLOR =
    /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|hsla?\(\s*[\d.]+(deg)?\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+%?\s*)?\))$/i

export function safeColor(value, legacyKey) {
    if (typeof value !== 'string') return ''
    const color = value.trim()
    if (!COLOR.test(color)) return ''
    if (legacyKey && LEGACY_DEFAULTS[legacyKey]?.includes(color.toLowerCase())) return ''
    return color
}

function text(value, max = 2000) {
    return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function starterPrompts(raw) {
    if (!raw || typeof raw !== 'object') return []
    const list = Array.isArray(raw) ? raw : Object.keys(raw).map((key) => raw[key])
    return list
        .map((item) => (typeof item === 'string' ? item : item?.prompt))
        .map((item) => text(item, 300))
        .filter(Boolean)
        .slice(0, 6)
}

function uploadTypes(list) {
    if (!Array.isArray(list)) return { types: [], maxMB: 0 }
    const types = new Set()
    let maxMB = 0
    for (const entry of list) {
        for (const type of Array.isArray(entry?.fileTypes) ? entry.fileTypes : []) if (typeof type === 'string') types.add(type)
        const size = Number(entry?.maxUploadSize)
        if (Number.isFinite(size) && size > maxMB) maxMB = size
    }
    return { types: [...types], maxMB: maxMB || 5 }
}

/** Normalized settings. `raw` is whatever the config endpoint returned (an object, or "OK" when nothing is set). */
export function normalizeConfig(raw, overrides = {}) {
    const cfg = raw && typeof raw === 'object' ? raw : {}
    const bot = cfg.botMessage && typeof cfg.botMessage === 'object' ? cfg.botMessage : {}
    const user = cfg.userMessage && typeof cfg.userMessage === 'object' ? cfg.userMessage : {}
    const input = cfg.textInput && typeof cfg.textInput === 'object' ? cfg.textInput : {}
    const uploads = cfg.uploads && typeof cfg.uploads === 'object' ? cfg.uploads : {}
    const images = uploadTypes(uploads.imgUploadSizeAndTypes)
    const fontSize = Number(cfg.fontSize)
    const merged = {
        title: text(cfg.title, 80),
        avatar: safeUrl(text(cfg.titleAvatarSrc), { image: true }) || '',
        botAvatar: bot.showAvatar ? safeUrl(text(bot.avatarSrc), { image: true }) || '' : '',
        welcome: text(cfg.welcomeMessage),
        errorMessage: text(cfg.errorMessage, 300),
        placeholder: text(input.placeholder, 120),
        starterPrompts: starterPrompts(cfg.starterPrompts),
        feedback: Boolean(cfg.chatFeedback?.status),
        followUps: Boolean(cfg.followUpPrompts?.status),
        newSessionEachVisit: Boolean(cfg.generateNewSession),
        imageUpload: uploads.isImageUploadAllowed && images.types.length ? images : null,
        fontSize: Number.isFinite(fontSize) && fontSize >= 12 && fontSize <= 22 ? fontSize : 0,
        colors: {
            headerBg: safeColor(cfg.titleBackgroundColor, 'titleBackgroundColor'),
            headerText: safeColor(cfg.titleTextColor, 'titleTextColor'),
            background: safeColor(cfg.backgroundColor, 'backgroundColor'),
            botBg: safeColor(bot.backgroundColor, 'botBackground'),
            botText: safeColor(bot.textColor, 'botText'),
            userBg: safeColor(user.backgroundColor, 'userBackground'),
            userText: safeColor(user.textColor, 'userText'),
            inputBg: safeColor(input.backgroundColor, 'inputBackground'),
            inputText: safeColor(input.textColor, 'inputText'),
            accent: safeColor(input.sendButtonColor, 'sendButton')
        }
    }
    for (const [key, value] of Object.entries(overrides || {})) {
        if (value === undefined || value === null || value === '') continue
        if (key === 'colors' && typeof value === 'object') {
            for (const [name, color] of Object.entries(value)) {
                const safe = safeColor(color)
                if (safe && name in merged.colors) merged.colors[name] = safe
            }
        } else if (key === 'starterPrompts') merged.starterPrompts = starterPrompts(value)
        else if (key === 'avatar') merged.avatar = safeUrl(text(value), { image: true }) || merged.avatar
        else if (typeof merged[key] === 'string') merged[key] = text(value)
        else if (typeof merged[key] === 'boolean') merged[key] = Boolean(value)
    }
    return merged
}

/** CSS custom properties for the colors a flow set. Unset colors keep the Cuttlely theme. */
export function colorVariables(colors) {
    const map = {
        headerBg: '--dc-header-bg',
        headerText: '--dc-header-fg',
        background: '--dc-bg',
        botBg: '--dc-bot-bg',
        botText: '--dc-bot-fg',
        userBg: '--dc-user-bg',
        userText: '--dc-user-fg',
        inputBg: '--dc-input-bg',
        inputText: '--dc-input-fg',
        accent: '--dc-accent'
    }
    return Object.entries(map)
        .map(([key, variable]) => (safeColor(colors?.[key]) ? `${variable}:${colors[key]};` : ''))
        .join('')
}
