/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { act, fireEvent, render, screen } from '@testing-library/react'
import ResetPasswordDialog from './ResetPasswordDialog'
import userApi from '@/api/user'

jest.mock('@/api/user', () => ({ createPasswordResetLink: jest.fn() }))

const link = 'https://example.com/local-accept#token=one-time-test-token'
const mount = (onClose = jest.fn()) => render(<ResetPasswordDialog userId='member-1' userEmail='member@example.com' onClose={onClose} />)
const generate = () => screen.getByRole('button', { name: 'Generate reset link' })

beforeEach(() => {
    jest.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockResolvedValue() } })
    userApi.createPasswordResetLink.mockResolvedValue({ data: { link } })
})

it('does not issue a reset on open or cancel', () => {
    const close = jest.fn()
    mount(close)
    expect(userApi.createPasswordResetLink).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledTimes(1)
    expect(userApi.createPasswordResetLink).not.toHaveBeenCalled()
})

it('issues once while pending, prevents closing, and copies the returned link', async () => {
    let complete
    userApi.createPasswordResetLink.mockReturnValue(new Promise((resolve) => (complete = resolve)))
    const close = jest.fn()
    const view = mount(close)
    const button = generate()
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' })
    expect(close).not.toHaveBeenCalled()
    expect(userApi.createPasswordResetLink).toHaveBeenCalledTimes(1)
    expect(userApi.createPasswordResetLink).toHaveBeenCalledWith('member-1')
    await act(async () => complete({ data: { link } }))
    expect(screen.getByLabelText('One-time reset link').value).toBe(link)
    expect(screen.getByText(/It has not been emailed/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await screen.findByRole('button', { name: 'Copied' })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(link)
    view.unmount()
    mount()
    expect(screen.queryByLabelText('One-time reset link')).toBeNull()
    expect(generate()).toBeTruthy()
})

it('reports confirmed email delivery and offers manual copy when the clipboard fails', async () => {
    userApi.createPasswordResetLink.mockResolvedValue({ data: { link, mailed: true } })
    navigator.clipboard.writeText.mockRejectedValue(new Error('Clipboard denied'))
    mount()
    fireEvent.click(generate())
    await screen.findByText(/Reset link emailed/)
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await screen.findByText(/copy it manually/)
    expect(screen.getByLabelText('One-time reset link').value).toBe(link)
})

it.each([403, 404, 502])('shows the server refusal (%s), then permits an explicit retry', async (status) => {
    userApi.createPasswordResetLink.mockRejectedValueOnce({ response: { status, data: { message: 'This account cannot be reset.' } } })
    mount()
    fireEvent.click(generate())
    await screen.findByText('This account cannot be reset.')
    expect(screen.queryByLabelText('One-time reset link')).toBeNull()
    fireEvent.click(generate())
    await screen.findByLabelText('One-time reset link')
    expect(userApi.createPasswordResetLink).toHaveBeenCalledTimes(2)
})

it('does not report success for a missing link or a lost response', async () => {
    userApi.createPasswordResetLink.mockResolvedValueOnce({ data: { mailed: true } })
    mount()
    fireEvent.click(generate())
    await screen.findByText(/Could not confirm a reset link/)
    expect(screen.queryByLabelText('One-time reset link')).toBeNull()
    userApi.createPasswordResetLink.mockRejectedValueOnce(new Error('Network failed'))
    fireEvent.click(generate())
    await screen.findByText(/Could not confirm a reset link/)
    expect(screen.queryByLabelText('One-time reset link')).toBeNull()
})

it('discards an in-flight result after unmount and does not show it for another person', async () => {
    let complete
    userApi.createPasswordResetLink.mockReturnValue(new Promise((resolve) => (complete = resolve)))
    const view = mount()
    fireEvent.click(generate())
    view.unmount()
    render(<ResetPasswordDialog userId='member-2' userEmail='second@example.com' onClose={jest.fn()} />)
    await act(async () => complete({ data: { link } }))
    expect(screen.queryByLabelText('One-time reset link')).toBeNull()
    expect(screen.getByText(/second@example.com/)).toBeTruthy()
})
