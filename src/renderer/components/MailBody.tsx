import { useMemo, useState } from 'react'
import DOMPurify from 'dompurify'
import { renderMarkdown } from '../lib/markdown'

interface MailBodySource {
  messageData: string
}

function parseMailBody(messageData: string): { html: string; isHtml: boolean } {
  try {
    const data = JSON.parse(messageData)
    // formats is a string[] on received mail, an object map on sent mail
    const formats = data.formats
    const hasHtml = Array.isArray(formats) ? formats.includes('html') : formats?.html !== undefined
    if (data.bodyText) {
      return { html: data.bodyText, isHtml: hasHtml || !!data.messageType?.html }
    }
    const mt = data.messageType ?? {}
    if (mt.md) return { html: renderMarkdown(atob(mt.md)), isHtml: false }
    if (mt.plaintext) return { html: renderMarkdown(atob(mt.plaintext)), isHtml: false }
    if (mt.html) return { html: atob(mt.html), isHtml: true }
    if (formats?.html) return { html: formats.html, isHtml: true }
    if (formats?.markdown) return { html: renderMarkdown(formats.markdown), isHtml: false }
    if (formats?.plaintext) return { html: renderMarkdown(formats.plaintext), isHtml: false }
    return { html: renderMarkdown(messageData), isHtml: false }
  } catch {
    return { html: renderMarkdown(messageData), isHtml: false }
  }
}

const IFRAME_BASE_STYLE = `
  body { background: #0a0a0a; color: #e5e5e5; margin: 12px; word-wrap: break-word;
         font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  a { color: #60a5fa; }
  img { max-width: 100%; height: auto; }
  pre { overflow-x: auto; background: #262626; padding: 8px; border-radius: 6px; }
  blockquote { border-left: 3px solid #3b82f6; margin-left: 0; padding-left: 12px; color: #a3a3a3; }
`

function buildSrcDoc(html: string, allowRemoteImages: boolean): string {
  // Remote content stays blocked until the user opts in — also stops tracking pixels.
  const imgSrc = allowRemoteImages ? "img-src data: https:;" : 'img-src data:;'
  const csp = `default-src 'none'; ${imgSrc} style-src 'unsafe-inline'; font-src data:;`
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<base target="_blank">',
    `<style>${IFRAME_BASE_STYLE}</style>`,
    '</head><body>',
    html,
    '</body></html>',
  ].join('')
}

/**
 * Renders a stored message body. Markdown/plaintext goes through the inline
 * markdown renderer (escapes raw HTML). HTML bodies are DOMPurify-sanitized
 * and isolated in a sandboxed iframe (no scripts, no same-origin) behind a
 * strict CSP; remote images load only after the user clicks "Load images".
 * Links open externally via <base target="_blank"> + allow-popups, which the
 * main process routes through shell.openExternal (setWindowOpenHandler).
 */
export default function MailBody({ mail }: { mail: MailBodySource }) {
  const { html, isHtml } = useMemo(() => parseMailBody(mail.messageData), [mail.messageData])
  const [loadImages, setLoadImages] = useState(false)

  const sanitized = useMemo(
    () => (isHtml ? DOMPurify.sanitize(html, { USE_PROFILES: { html: true } }) : html),
    [html, isHtml],
  )

  if (!isHtml) {
    return (
      <div
        className="prose prose-invert max-w-none prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-blockquote:border-blue-500 prose-code:text-amber-300"
        dangerouslySetInnerHTML={{ __html: sanitized }}
      />
    )
  }

  const hasRemoteImages = /<img[^>]+src=["']https?:/i.test(sanitized)
  return (
    <div>
      {hasRemoteImages && !loadImages && (
        <button
          onClick={(e) => { e.stopPropagation(); setLoadImages(true) }}
          className="mb-2 rounded-md border border-neutral-600 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
        >
          Load remote images
        </button>
      )}
      <iframe
        sandbox="allow-popups"
        srcDoc={buildSrcDoc(sanitized, loadImages)}
        title="Message content"
        className="h-96 w-full rounded-md border border-neutral-800"
      />
    </div>
  )
}
