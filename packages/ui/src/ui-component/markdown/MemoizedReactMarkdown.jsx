import { memo, useMemo } from 'react'
import PropTypes from 'prop-types'
import ReactMarkdown from 'react-markdown'
import './Markdown.css'
import { CodeBlock } from '../markdown/CodeBlock'
import rehypeMathjax from 'rehype-mathjax'
import { containsLaTeX, preprocessLatex, remarkPluginsFor } from './math.mjs'

/**
 * Enhanced Markdown component with memoization for better performance
 * Supports various plugins and custom rendering components
 */
export const MemoizedReactMarkdown = memo(
    ({ children, ...props }) => {
        // Preprocess text to improve LaTeX compatibility
        const processedChildren = useMemo(() => (typeof children === 'string' ? preprocessLatex(children) : children), [children])

        // Enable math by default unless explicitly disabled
        const shouldEnableMath = useMemo(() => {
            const hasLatex = processedChildren && containsLaTeX(processedChildren, props.mathPatterns || [])

            return props.disableMath === true ? false : props.forceMath || hasLatex
        }, [processedChildren, props.forceMath, props.disableMath, props.mathPatterns])

        // Configure plugins based on content
        const remarkPlugins = useMemo(() => {
            if (props.remarkPlugins) return props.remarkPlugins
            return remarkPluginsFor(shouldEnableMath)
        }, [props.remarkPlugins, shouldEnableMath])

        const rehypePlugins = useMemo(() => {
            if (props.rehypePlugins) return props.rehypePlugins
            return shouldEnableMath ? [rehypeMathjax] : []
        }, [props.rehypePlugins, shouldEnableMath])

        return (
            <div className='react-markdown'>
                <ReactMarkdown
                    remarkPlugins={remarkPlugins}
                    rehypePlugins={rehypePlugins}
                    components={{
                        code({ inline, className, children, ...codeProps }) {
                            const match = /language-(\w+)/.exec(className || '')
                            return !inline ? (
                                <CodeBlock
                                    key={Math.random()}
                                    chatflowid={props.chatflowid}
                                    isFullWidth={props.isFullWidth !== undefined ? props.isFullWidth : true}
                                    language={(match && match[1]) || ''}
                                    value={String(children).replace(/\n$/, '')}
                                    {...codeProps}
                                />
                            ) : (
                                <code className={className} {...codeProps}>
                                    {children}
                                </code>
                            )
                        },
                        a({ href, children, ...linkProps }) {
                            return (
                                <a href={href} target='_blank' rel='noopener noreferrer' {...linkProps}>
                                    {children}
                                </a>
                            )
                        },
                        p({ children }) {
                            return <p style={{ whiteSpace: 'pre-line' }}>{children}</p>
                        },
                        ...props.components
                    }}
                    {...props}
                >
                    {processedChildren}
                </ReactMarkdown>
            </div>
        )
    },
    (prevProps, nextProps) => {
        // More detailed comparison for better memoization
        if (prevProps.children !== nextProps.children) return false

        // Check if other props have changed
        const prevEntries = Object.entries(prevProps).filter(([key]) => key !== 'children')
        const nextEntries = Object.entries(nextProps).filter(([key]) => key !== 'children')

        if (prevEntries.length !== nextEntries.length) return false

        // Simple shallow comparison of remaining props
        for (const [key, value] of prevEntries) {
            if (key === 'components' || key === 'remarkPlugins' || key === 'rehypePlugins') continue // Skip complex objects

            if (nextProps[key] !== value) return false
        }

        return true
    }
)

MemoizedReactMarkdown.displayName = 'MemoizedReactMarkdown'

MemoizedReactMarkdown.propTypes = {
    children: PropTypes.any,
    chatflowid: PropTypes.string,
    isFullWidth: PropTypes.bool,
    remarkPlugins: PropTypes.array,
    rehypePlugins: PropTypes.array,
    components: PropTypes.object,
    forceMath: PropTypes.bool,
    disableMath: PropTypes.bool,
    mathPatterns: PropTypes.array
}
