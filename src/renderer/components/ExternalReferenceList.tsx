// Shared renderer for a message's external references (SPEC §3.1): image
// links inline, everything else as a generic file+link chip that opens in
// the browser. Used by the reading pane (InboxView) and the composer preview.
const IMAGE_URL_RE = /\.(png|jpe?g|gif|webp)(\?|#|$)/i

function linkLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const file = parsed.pathname.split('/').filter(Boolean).pop()
    return file ? decodeURIComponent(file) : parsed.hostname
  } catch {
    return url
  }
}

export default function ExternalReferenceList({ references }: { references: string[][] }) {
  if (references.length === 0) return null
  const open = (url: string) => window.nvelope.file.openExternal(url).catch((e) => console.error('Open link failed:', e))
  return (
    <div className="mt-4 border-t border-neutral-800 pt-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">Attachments</div>
      <div className="flex flex-col gap-2">
        {references.map((ref) => {
          const url = ref[1]
          if (IMAGE_URL_RE.test(url)) {
            return (
              <button key={url} onClick={() => open(url)} title={`Open ${url} in browser`} className="w-fit cursor-pointer">
                <img
                  src={url}
                  alt={linkLabel(url)}
                  className="max-h-64 max-w-full rounded-md border border-neutral-700 object-contain"
                />
                <span className="mt-1 block truncate text-left text-xs text-neutral-500">{linkLabel(url)}</span>
              </button>
            )
          }
          return (
            <button
              key={url}
              onClick={() => open(url)}
              title={`Open ${url} in browser`}
              className="flex w-fit items-center gap-2 rounded-md border border-neutral-700 bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-300 hover:border-blue-600 hover:text-blue-300 transition-colors"
            >
              <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="max-w-80 truncate">{linkLabel(url)}</span>
              <svg className="h-3.5 w-3.5 shrink-0 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
            </button>
          )
        })}
      </div>
    </div>
  )
}
