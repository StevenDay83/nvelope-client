import { useState } from 'react'

const OFFICIAL_NPUB = 'npub1xxzyawrm7hsfwj3q9plr03f30kg32qpt9wx2qm8tsc5wwajtmj4s9h088q'

/**
 * Custom About page (all platforms — the native about panel is macOS-only).
 * Background art is ./about-bg.jpg (renderer public dir); the purple gradient
 * underneath is the fallback when the image is absent.
 */
export default function AboutWindow({ data }: { data: Record<string, unknown> }) {
  const version = typeof data.version === 'string' ? data.version : ''
  const identityId = typeof data.identityId === 'string' ? data.identityId : null
  const accountId = typeof data.accountId === 'string' ? data.accountId : null
  const accountDisplayName = typeof data.accountDisplayName === 'string' ? data.accountDisplayName : undefined
  const [note, setNote] = useState('')

  const messageTeam = async () => {
    if (!identityId || !accountId) {
      setNote('Unlock an identity to send mail to the nVelope team.')
      return
    }
    await window.nvelope.compose.open({
      identityId,
      accountId,
      accountDisplayName,
      recipientNpub: OFFICIAL_NPUB,
      format: 'plaintext',
    })
    window.close()
  }

  return (
    <div className="relative flex h-screen flex-col items-center justify-center overflow-hidden bg-[#2a0d4a]">
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: "url('./about-bg.jpg')" }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-[#3b1563]/50 via-[#2a0d4a]/60 to-[#160527]/85" />

      <div className="relative flex flex-col items-center space-y-2 px-8 text-center">
        <h1 className="text-4xl font-bold text-white drop-shadow-lg">nVelope</h1>
        <p className="text-sm text-purple-200 drop-shadow">Self-sovereign email over the Internet.</p>
        <p className="text-xs text-purple-300 drop-shadow">Version {version}</p>

        <div className="flex items-center gap-4 pt-3 text-sm">
          <a
            href="https://nvelope.messagepush.io"
            className="rounded-md border border-purple-300/40 bg-black/30 px-3 py-1.5 text-purple-100 backdrop-blur-sm transition-colors hover:bg-black/50 hover:text-white"
          >
            nvelope.messagepush.io
          </a>
          <a
            href="https://github.com/StevenDay83/nvelope-client"
            className="rounded-md border border-purple-300/40 bg-black/30 px-3 py-1.5 text-purple-100 backdrop-blur-sm transition-colors hover:bg-black/50 hover:text-white"
          >
            GitHub
          </a>
        </div>

        <button
          onClick={messageTeam}
          title={OFFICIAL_NPUB}
          className="flex items-center gap-2 rounded-md border border-purple-300/40 bg-black/30 px-3 py-1.5 text-sm text-purple-100 backdrop-blur-sm transition-colors hover:bg-black/50 hover:text-white"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          Message the nVelope team
        </button>
        {note && <p className="text-xs text-amber-300 drop-shadow">{note}</p>}

        <p className="pt-4 text-[11px] text-purple-200/70 drop-shadow">
          Copyright &copy; 2026 Steven Day. All rights reserved.
        </p>
      </div>
    </div>
  )
}
