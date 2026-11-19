import { useEffect, useMemo, useReducer, useState } from 'react'
import { npubEncode } from 'nostr-tools/nip19'
import {
  chipLabelForContact,
  formatPartialNpub,
  ensureIdentityLabel,
  getResolvedIdentity,
  subscribeIdentityLabels,
} from '../lib/identityLabel'
import type { ContactRecord } from '../../preload'

interface Props {
  pubkey: string // hex, as recorded on the mail row / inner message
  contactsByPubkey: Record<string, ContactRecord>
  selfPubkeys: readonly string[] // every account in the identity → "You"
  labelOverride?: string // special senders (e.g. the nVelope welcome bot)
  onAddContact?: (pubkey: string) => void
}

// Static sender/recipient chip for received and sent mail. Unlike the
// composer's chips these are part of the message: never editable, never
// dismissable, always blue.
export default function IdentityChip({ pubkey, contactsByPubkey, selfPubkeys, labelOverride, onAddContact }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const npub = useMemo(() => {
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null
    try {
      return npubEncode(pubkey)
    } catch {
      return null
    }
  }, [pubkey])

  const isSelf = selfPubkeys.includes(pubkey)
  const contact = contactsByPubkey[pubkey]

  // Re-render when the shared resolution cache learns a new label.
  const [, bumpLabelsVersion] = useReducer((v: number) => v + 1, 0)
  useEffect(() => subscribeIdentityLabels(() => bumpLabelsVersion()), [])

  // Non-contacts get one async kind-0/NIP-05 resolution, cached per session.
  useEffect(() => {
    if (!npub || isSelf || contact || labelOverride) return
    ensureIdentityLabel(pubkey)
  }, [npub, pubkey, isSelf, contact, labelOverride])

  const fetchedLabel = getResolvedIdentity(pubkey)?.chip ?? null

  // Not a usable key — values from a created email are displayed as plain
  // text rather than an error state.
  if (!npub) return <span>{labelOverride ?? pubkey}</span>

  const label =
    labelOverride ??
    (isSelf ? 'You' : contact ? chipLabelForContact(contact) : (fetchedLabel ?? formatPartialNpub(npub)))

  const canAddContact = !isSelf && !contact && !!onAddContact

  return (
    <>
      <span
        title={npub}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        className="inline-flex max-w-full items-center rounded-full border border-blue-700/50 bg-blue-500/20 px-2 py-0.5 text-xs text-blue-300"
      >
        <span className="max-w-64 truncate">{label}</span>
      </span>
      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
            }}
          />
          <div
            className="fixed z-50 min-w-44 rounded-md border border-neutral-700 bg-neutral-800 py-1 shadow-xl"
            style={{
              left: Math.min(menu.x, window.innerWidth - 190),
              top: Math.min(menu.y, window.innerHeight - 120),
            }}
          >
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(label)
                setMenu(null)
              }}
              className="flex w-full items-center px-3 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-700"
            >
              Copy address text
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(npub)
                setMenu(null)
              }}
              className="flex w-full items-center px-3 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-700"
            >
              Copy npub
            </button>
            {canAddContact && (
              <button
                type="button"
                onClick={() => {
                  onAddContact!(pubkey)
                  setMenu(null)
                }}
                className="flex w-full items-center px-3 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-700"
              >
                Add contact
              </button>
            )}
          </div>
        </>
      )}
    </>
  )
}
