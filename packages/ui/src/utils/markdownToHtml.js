import DOMPurify from 'dompurify'
import { marked } from 'marked'

// GitHub-flavored markdown (tables, strikethrough, task lists, bare links) to sanitized HTML for the rich text inputs.
export const markdownToHtml = (markdown) => DOMPurify.sanitize(marked.parse(String(markdown ?? ''), { gfm: true, async: false }))
