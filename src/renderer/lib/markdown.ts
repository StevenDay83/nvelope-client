/**
 * Lightweight markdown-to-HTML renderer for nVelope.
 * Covers the classic Markdown syntax: paragraphs, ATX/Setext headers,
 * emphasis, inline & reference links and images, autolinks, ordered and
 * unordered lists, fenced & indented code blocks, (nested) blockquotes,
 * horizontal rules, hard line breaks, and backslash escapes.
 * Raw HTML is always escaped; link/image URLs are scheme-checked.
 */

interface LinkDef {
  url: string
  title?: string
}

type Refs = Record<string, LinkDef>

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;')
}

function safeUrl(url: string, allowMailto = false): string | null {
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (allowMailto && /^mailto:/i.test(trimmed)) return trimmed
  return null
}

const CODE_CLASS = 'rounded bg-neutral-800 px-1 py-0.5 text-xs font-mono text-amber-300'
const LINK_CLASS = 'text-blue-400 underline hover:text-blue-300'

// Values passed to the anchor/image builders are already HTML-escaped
// (inline text is escaped up front, ref definitions at collection) —
// only the attribute delimiter still needs escaping.
function quoteAttr(text: string): string {
  return text.replace(/"/g, '&quot;')
}

function anchorHtml(url: string, label: string, title?: string): string {
  const titleAttr = title ? ` title="${quoteAttr(title)}"` : ''
  return `<a href="${quoteAttr(url)}"${titleAttr} target="_blank" rel="noopener noreferrer" class="${LINK_CLASS}">${label}</a>`
}

function imageHtml(url: string, alt: string, title?: string): string {
  const titleAttr = title ? ` title="${quoteAttr(title)}"` : ''
  return `<img src="${quoteAttr(url)}" alt="${quoteAttr(alt)}"${titleAttr} loading="lazy" class="my-2 max-w-full rounded-md" />`
}

function renderInline(text: string, refs: Refs): string {
  // Generated HTML is stashed behind control-char tokens so later passes
  // (escaping, emphasis) can't mangle it. Restored in one pass at the end.
  const stash: string[] = []
  const token = (html: string): string => {
    stash.push(html)
    return `${stash.length - 1}`
  }

  // Backslash escapes -> literal characters
  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, (_m, ch: string) => token(escapeHtml(ch)))

  // Code spans (single or multi backtick delimiters)
  text = text.replace(/(`+)([\s\S]+?)\1/g, (_m, _ticks: string, content: string) => {
    const trimmed = content.replace(/^ /, '').replace(/ $/, '')
    return token(`<code class="${CODE_CLASS}">${escapeHtml(trimmed)}</code>`)
  })

  // Autolinks: <http://…>, <mailto:…>, <user@domain>
  text = text.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, (_m, url: string) =>
    token(anchorHtml(escapeHtml(url), escapeHtml(url))),
  )
  text = text.replace(/<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/g, (_m, addr: string) =>
    token(anchorHtml(`mailto:${escapeHtml(addr)}`, escapeHtml(addr))),
  )

  text = escapeHtml(text)

  // Inline images: ![alt](url "optional title")
  text = text.replace(/!\[([^\]]*)\]\(\s*(\S+?)(?:\s+["']([^"']*)["'])?\s*\)/g, (match, alt: string, url: string, title?: string) => {
    const safe = safeUrl(url)
    return safe ? token(imageHtml(safe, alt, title)) : match
  })

  // Reference images: ![alt][id] / ![alt][] (implicit id = alt)
  text = text.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (match, alt: string, id: string) => {
    const def = refs[(id || alt).toLowerCase()]
    if (!def) return match
    const safe = safeUrl(def.url)
    return safe ? token(imageHtml(safe, alt, def.title)) : match
  })

  // Inline links: [text](url "optional title")
  text = text.replace(/\[([^\]]+)\]\(\s*(\S+?)(?:\s+["']([^"']*)["'])?\s*\)/g, (match, label: string, url: string, title?: string) => {
    const safe = safeUrl(url, true)
    return safe ? token(anchorHtml(safe, label, title)) : match
  })

  // Reference links: [text][id] / [text][] (implicit id = text)
  text = text.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (match, label: string, id: string) => {
    const def = refs[(id || label).toLowerCase()]
    if (!def) return match
    const safe = safeUrl(def.url, true)
    return safe ? token(anchorHtml(safe, label, def.title)) : match
  })

  // Bold: **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>')

  // Italic: *text* or _text_ (but not ** which was already handled)
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
  text = text.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>')

  return text.replace(/(\d+)/g, (_m, i: string) => stash[Number(i)]!)
}

const HEADING_SIZES = ['text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm', 'text-sm']

export function renderMarkdown(md: string): string {
  if (!md) return ''

  // Reference definitions ([id]: url "title") can appear anywhere; collect
  // them first and blank out their lines so they don't render as paragraphs.
  const refs: Refs = {}
  const lines = md.split('\n').map((line) => {
    const m = line.match(/^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/)
    if (!m || !m[2]) return line
    const title = m[3] ?? m[4] ?? m[5]
    refs[m[1]!.toLowerCase()] = { url: escapeHtml(m[2]), title: title === undefined ? undefined : escapeHtml(title) }
    return ''
  })

  const out: string[] = []
  let inCodeBlock = false
  let codeBuffer: string[] = []
  let codeLang = ''
  let inList = false
  let listBuffer: string[] = []
  let listOrdered = false
  let paraBuffer: string[] = []
  let indentedCode: string[] = []

  const flushCode = () => {
    if (codeBuffer.length > 0) {
      const code = escapeHtml(codeBuffer.join('\n'))
      out.push(`<pre class="my-3 overflow-x-auto rounded-lg bg-neutral-800 p-3"${codeLang ? ` data-lang="${escapeAttr(codeLang)}"` : ''}><code class="text-sm font-mono text-neutral-300">${code}</code></pre>`)
      codeBuffer = []
      codeLang = ''
    }
  }

  const flushList = () => {
    if (listBuffer.length > 0) {
      const tag = listOrdered ? 'ol' : 'ul'
      const items = listBuffer.map((item) => `<li class="ml-4 leading-relaxed">${renderInline(item, refs)}</li>`).join('')
      out.push(`<${tag} class="my-2 ${listOrdered ? 'list-decimal' : 'list-disc'}">${items}</${tag}>`)
      listBuffer = []
      inList = false
      listOrdered = false
    }
  }

  const flushPara = () => {
    if (paraBuffer.length > 0) {
      // Consecutive lines form one paragraph; two trailing spaces = hard break
      const parts = paraBuffer.map((l) => renderInline(l.trim(), refs))
      let content = ''
      for (let j = 0; j < parts.length; j++) {
        if (j > 0) content += / {2,}$/.test(paraBuffer[j - 1]!) ? '<br />' : ' '
        content += parts[j]
      }
      out.push(`<p class="my-2 leading-relaxed text-neutral-200">${content}</p>`)
      paraBuffer = []
    }
  }

  const flushIndentedCode = () => {
    if (indentedCode.length > 0) {
      const code = escapeHtml(indentedCode.map((l) => l.replace(/^(?: {4}|\t)/, '')).join('\n'))
      out.push(`<pre class="my-3 overflow-x-auto rounded-lg bg-neutral-800 p-3"><code class="text-sm font-mono text-neutral-300">${code}</code></pre>`)
      indentedCode = []
    }
  }

  const flushBlocks = () => {
    flushPara()
    flushList()
    flushIndentedCode()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    // Fenced code blocks
    if (line.startsWith('```')) {
      flushBlocks()
      if (inCodeBlock) {
        flushCode()
        inCodeBlock = false
      } else {
        inCodeBlock = true
        codeLang = line.slice(3).trim()
      }
      continue
    }
    if (inCodeBlock) {
      codeBuffer.push(line)
      continue
    }

    if (line.trim() === '') {
      flushBlocks()
      continue
    }

    // Indented code blocks (4 spaces / tab) — not inside a list item
    if (/^(?: {4}|\t)/.test(line) && !inList) {
      flushPara()
      indentedCode.push(line)
      continue
    }
    flushIndentedCode()

    // Horizontal rule (spaces allowed between markers)
    if (/^ {0,3}(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/.test(line)) {
      flushBlocks()
      out.push('<hr class="my-4 border-neutral-700" />')
      continue
    }

    // Blockquote: group consecutive '>' lines, strip one level, and render
    // the inner markdown recursively (handles nesting and inner blocks)
    if (/^ {0,3}>/.test(line)) {
      flushBlocks()
      const quoted: string[] = []
      while (i < lines.length && /^ {0,3}>/.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(/^ {0,3}> ?/, ''))
        i++
      }
      i--
      out.push(`<blockquote class="my-2 border-l-4 border-blue-500 pl-3 italic text-neutral-300">${renderMarkdown(quoted.join('\n'))}</blockquote>`)
      continue
    }

    // ATX headers (optional closing hashes)
    const hMatch = line.match(/^ {0,3}(#{1,6})\s+(.*)$/)
    if (hMatch) {
      flushBlocks()
      const level = hMatch[1]!.length
      const content = renderInline(hMatch[2]!.replace(/\s+#+\s*$/, ''), refs)
      out.push(`<h${level} class="${HEADING_SIZES[level - 1]} mt-4 mb-2 font-semibold text-white">${content}</h${level}>`)
      continue
    }

    // Setext headers (=== / --- under a text line)
    if (i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]!) && !inList) {
      const level = lines[i + 1]!.trimStart().startsWith('=') ? 1 : 2
      flushBlocks()
      const content = renderInline(line.trim(), refs)
      out.push(`<h${level} class="${HEADING_SIZES[level - 1]} mt-4 mb-2 font-semibold text-white">${content}</h${level}>`)
      i++
      continue
    }

    // Lists (*, +, - and numbered)
    const ulMatch = line.match(/^ {0,3}[-*+]\s+(.*)$/)
    const olMatch = line.match(/^ {0,3}\d+\.\s+(.*)$/)
    if (ulMatch || olMatch) {
      flushPara()
      const isOrdered = !!olMatch
      const item = (ulMatch ? ulMatch[1] : olMatch![1])!
      if (!inList) {
        inList = true
        listOrdered = isOrdered
      } else if (listOrdered !== isOrdered) {
        flushList()
        inList = true
        listOrdered = isOrdered
      }
      listBuffer.push(item)
      continue
    }

    // Regular paragraph line (accumulated; hard-wrapped lines join)
    flushList()
    paraBuffer.push(line)
  }

  flushCode()
  flushBlocks()

  return out.join('\n')
}
