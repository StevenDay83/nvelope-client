/**
 * Lightweight markdown-to-HTML renderer for nVelope.
 * Handles common mail formatting: paragraphs, bold, italic, links,
 * headers, lists, code blocks, blockquotes, and horizontal rules.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderInline(text: string): string {
  // Code spans: `code`
  text = text.replace(/`([^`]+)`/g, '<code class="rounded bg-neutral-800 px-1 py-0.5 text-xs font-mono text-amber-300">$1</code>')

  // Bold: **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>')

  // Italic: *text* or _text_ (but not ** which was already handled)
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
  text = text.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>')

  // Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue-400 underline hover:text-blue-300">$1</a>')

  return text
}

export function renderMarkdown(md: string): string {
  if (!md) return ''

  const lines = md.split('\n')
  const out: string[] = []
  let inCodeBlock = false
  let codeBuffer: string[] = []
  let codeLang = ''
  let inList = false
  let listBuffer: string[] = []
  let listOrdered = false

  const flushCode = () => {
    if (codeBuffer.length > 0) {
      const code = escapeHtml(codeBuffer.join('\n'))
      out.push(`<pre class="my-3 overflow-x-auto rounded-lg bg-neutral-800 p-3"${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ''}><code class="text-sm font-mono text-neutral-300">${code}</code></pre>`)
      codeBuffer = []
      codeLang = ''
    }
  }

  const flushList = () => {
    if (listBuffer.length > 0) {
      const tag = listOrdered ? 'ol' : 'ul'
      const items = listBuffer.map((item) => `<li class="ml-4 leading-relaxed">${renderInline(item)}</li>`).join('')
      out.push(`<${tag} class="my-2 ${listOrdered ? 'list-decimal' : 'list-disc'}">${items}</${tag}>`)
      listBuffer = []
      inList = false
      listOrdered = false
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    // Code blocks
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        flushCode()
        inCodeBlock = false
      } else {
        flushList()
        inCodeBlock = true
        codeLang = line.slice(3).trim()
      }
      continue
    }

    if (inCodeBlock) {
      codeBuffer.push(line)
      continue
    }

    // Horizontal rule
    if (/^(---|___|\*\*\*)\s*$/.test(line)) {
      flushList()
      out.push('<hr class="my-4 border-neutral-700" />')
      continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      flushList()
      const content = renderInline(line.slice(2))
      out.push(`<blockquote class="my-2 border-l-4 border-blue-500 pl-3 italic text-neutral-300">${content}</blockquote>`)
      continue
    }

    // Headers
    const hMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (hMatch) {
      flushList()
      const level = hMatch[1]!.length
      const sizes = ['text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm', 'text-sm']
      const content = renderInline(hMatch[2]!)
      out.push(`<h${level} class="${sizes[level - 1]} mt-4 mb-2 font-semibold text-white">${content}</h${level}>`)
      continue
    }

    // Lists
    const ulMatch = line.match(/^[-*]\s+(.*)$/)
    const olMatch = line.match(/^\d+\.\s+(.*)$/)
    if (ulMatch || olMatch) {
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

    if (inList && line.trim() === '') {
      flushList()
      continue
    }

    // Empty line -> paragraph break
    if (line.trim() === '') {
      flushList()
      continue
    }

    // Regular paragraph
    flushList()
    const content = renderInline(escapeHtml(line))
    out.push(`<p class="my-2 leading-relaxed text-neutral-200">${content}</p>`)
  }

  flushCode()
  flushList()

  return out.join('\n')
}
