import DOMPurify from 'dompurify'

const IFRAME_BASE_STYLE = `
  body { background: #ffffff; color: #111111; margin: 12px; word-wrap: break-word;
         font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  a { color: #2563eb; }
  img { max-width: 100%; height: auto; }
  pre { overflow-x: auto; background: #f3f4f6; padding: 8px; border-radius: 6px; }
  blockquote { border-left: 3px solid #3b82f6; margin-left: 0; padding-left: 12px; color: #4b5563; }
`

/**
 * Sanitizes an HTML mail body as a WHOLE document so <head> <style> blocks
 * (class rules + @media queries used by real newsletters) survive alongside
 * table layout markup and presentational attributes. Scripts, event handlers,
 * javascript: URLs, iframes, forms, and external stylesheets are stripped by
 * DOMPurify; remote subresources are separately controlled by the iframe CSP.
 */
export function sanitizeMailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ['style', 'center', 'font'],
    ADD_ATTR: ['align', 'valign', 'bgcolor', 'cellpadding', 'cellspacing', 'border', 'width', 'height', 'role', 'target'],
    WHOLE_DOCUMENT: true,
  })
}

/**
 * Builds the sandboxed iframe document: the sanitized mail plus a strict CSP
 * (no scripts, remote images only after user opt-in — also stops tracking
 * pixels and CSS-based exfiltration), external-link handling, and base styles.
 */
export function buildMailSrcDoc(sanitizedHtml: string, allowRemoteImages: boolean): string {
  const doc = new DOMParser().parseFromString(sanitizedHtml, 'text/html')
  const imgSrc = allowRemoteImages ? 'img-src data: https:;' : 'img-src data:;'
  const csp = `default-src 'none'; ${imgSrc} style-src 'unsafe-inline'; font-src data:;`

  const meta = doc.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', csp)
  doc.head.prepend(meta)

  const base = doc.createElement('base')
  base.setAttribute('target', '_blank')
  doc.head.append(base)

  const style = doc.createElement('style')
  style.textContent = IFRAME_BASE_STYLE
  doc.head.append(style)

  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
}
