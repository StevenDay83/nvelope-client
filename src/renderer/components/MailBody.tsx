import { useMemo, useState, useRef, useEffect } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { sanitizeMailHtml, buildMailSrcDoc } from '../lib/htmlMail'

interface MailBodySource {
  messageData: string
}

function parseMailBody(messageData: string): { html: string; isHtml: boolean } {
  try {
    const data = JSON.parse(messageData)
    // formats is a string[] on received mail, an object map on sent mail
    const formats = data.formats
    const fmtList: string[] = Array.isArray(formats) ? formats : Object.keys(formats ?? {})
    const hasHtml = fmtList.includes('html')
    if (data.bodyText) {
      // bodyText is filled with md > plaintext > html priority — render
      // markdown/plaintext through the markdown renderer, html stays raw
      // for the sanitizer + iframe path below.
      if (fmtList.includes('md') || fmtList.includes('markdown') || fmtList.includes('plaintext')) {
        return { html: renderMarkdown(data.bodyText), isHtml: false }
      }
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

/** Strips src from remote images in rendered markdown until the user opts in. */
function gateMarkdownImages(html: string): { html: string; hasRemoteImages: boolean } {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  let hasRemoteImages = false
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    if (/^https?:/i.test(src)) {
      hasRemoteImages = true
      img.setAttribute('data-src', src)
      img.removeAttribute('src')
    }
  }
  return { html: doc.body.innerHTML, hasRemoteImages }
}

/**
 * Renders a stored message body. Markdown/plaintext goes through the inline
 * markdown renderer (escapes raw HTML). HTML bodies are DOMPurify-sanitized
 * as whole documents (head <style> blocks and table layouts survive) and
 * isolated in a sandboxed iframe (no scripts) behind a strict CSP; remote
 * images load only after the user clicks "Load images", on both paths.
 * Links open externally via <base target="_blank"> + allow-popups, which the
 * main process routes through shell.openExternal (setWindowOpenHandler).
 */
export default function MailBody({ mail }: { mail: MailBodySource }) {
  const { html, isHtml } = useMemo(() => parseMailBody(mail.messageData), [mail.messageData])
  const [loadImages, setLoadImages] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    setLoadImages(false)
    if (iframeRef.current) iframeRef.current.style.height = ''
  }, [mail.messageData])

  const sanitized = useMemo(() => (isHtml ? sanitizeMailHtml(html) : html), [html, isHtml])
  const gated = useMemo(
    () => (!isHtml && !loadImages ? gateMarkdownImages(sanitized) : null),
    [isHtml, loadImages, sanitized],
  )

  const hasRemoteImages = isHtml
    ? /<img[^>]+src=["']https?:/i.test(sanitized)
    : loadImages
      ? /<img[^>]+src=["']https?:/i.test(sanitized)
      : (gated?.hasRemoteImages ?? false)

  const loadImagesButton = hasRemoteImages && !loadImages && (
    <button
      onClick={(e) => { e.stopPropagation(); setLoadImages(true) }}
      className="mb-2 rounded-md border border-neutral-600 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
    >
      Load remote images
    </button>
  )

  if (!isHtml) {
    return (
      <div>
        {loadImagesButton}
        <div
          className="prose prose-invert max-w-none prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-blockquote:border-blue-500 prose-code:text-amber-300"
          dangerouslySetInnerHTML={{ __html: gated?.html ?? sanitized }}
        />
      </div>
    )
  }

  // allow-same-origin (without allow-scripts) lets us measure the content
  // height so long newsletters render in full instead of a small scroll box.
  const resizeIframe = () => {
    const iframe = iframeRef.current
    const doc = iframe?.contentDocument
    if (!iframe || !doc) return
    const height = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, 200)
    iframe.style.height = `${height}px`
  }

  return (
    <div>
      {loadImagesButton}
      <iframe
        ref={iframeRef}
        sandbox="allow-popups allow-same-origin"
        srcDoc={buildMailSrcDoc(sanitized, loadImages)}
        onLoad={resizeIframe}
        title="Message content"
        className="h-96 w-full rounded-md border border-neutral-800"
      />
    </div>
  )
}
