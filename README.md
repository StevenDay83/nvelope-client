# nVelope (Beta)

A desktop mail client for the **nvelope protocol** — private, spam-resistant electronic mail over [Nostr](https://nostr.com) relays. No mail servers, no accounts to sign up for: your Nostr keypair *is* your address.

> **Status: Beta (`0.1.0-beta.1`).** Core sending, receiving, contacts, and policies are functional and tested against public relays. Expect rough edges; backup your keys before relying on it.

## How it works

nVelope implements the [nvelope protocol](https://github.com/StevenDay83/nvelope-core/blob/master/SPEC.md) via the [`nvelope-core`](https://github.com/StevenDay83/nvelope-core) library:

- **Blinded envelopes (kind 8500)** — messages are encrypted to the recipient's mail certificate (RSA-OAEP) and published to relays signed by a throwaway key. Relays and observers can't tell who mailed whom.
- **Mail certificates & recipient policies (kind 30998)** — accounts publish a certificate so they can receive mail, plus a recipient policy that sets the rules for inbound mail.
- **Proof-of-work anti-spam** — instead of a spam folder, senders must mine the outer envelope's event id to the difficulty the *recipient* demands. Contacts and strangers can carry different requirements; recipients can reject non-contacts outright.
- **No attachments on the wire** — Nostr can't carry meaningful binary payloads, so "attachments" are external references (http/https links). Images render inline in the viewer; other files get a link chip.
- **Threading** — replies propagate an opaque `thread_id` inside the encrypted body, so conversations group without leaking structure to relays.

## Features

- **Identities & vaults** — passphrase-encrypted identity vaults; multiple Nostr accounts per identity; create a fresh keypair or import an existing `nsec`; auto-lock on idle; encrypted vault backup.
- **Onboarding wizard** — key generation/import, mail certificate generation, recipient policy sliders, and a machine hash-rate benchmark used to translate "minutes of sender effort" into PoW difficulty.
- **Composer** — plaintext / Markdown / HTML with formatting toolbars, `;`-separated multiple recipients (npub, NIP-05, or contact name), external-link attachments, and autosaving drafts (one draft per message).
- **Outbox queue** — sending is asynchronous: PoW mining runs in the background with live progress, cancel (pause), and retry. Queued mail survives restarts.
- **Contacts** — kind 3 / NIP-51 list sync, NIP-05 resolution, automatic mail-certificate detection (who can receive nVelope mail), and per-contact PoW cost estimates so you can see what sending will take before you write.
- **Reading** — conversation view with threads spanning folders, folders you create/rename/delete, move-to-folder, search, junk, and read/unread state that survives rescans.
- **Safe HTML mail** — HTML bodies are DOMPurify-sanitized and rendered in a sandboxed iframe behind a strict CSP. Remote images are blocked until you click "Load remote images" (no tracking pixels by default); links open in your system browser, never in-app.
- **Relay management** — per-identity relay lists used for both sending and scanning.

## Tech stack

Electron 40 · React 18 · TypeScript · electron-vite · Tailwind CSS · better-sqlite3 (local mail store) · nostr-tools · nvelope-core · DOMPurify

## Development

```bash
npm install
npm run dev      # live-reload dev build
npm run build    # typecheck + production build
npm run dist     # package installers (electron-builder)
```

Data lives in the Electron `userData` directory (macOS: `~/Library/Application Support/nvelope-client/`) — encrypted vaults, per-identity SQLite mail stores, and client settings.

## Building releases

`npm run dist` produces installers via electron-builder: macOS `.dmg`, Windows `.exe` (NSIS), Linux `.AppImage`. Code signing / notarization and auto-update are on the roadmap and not yet configured.

## Security notes

- Secret keys never leave the encrypted vault (except explicit, warned plaintext export).
- HTML mail is sanitized and isolated; remote content is opt-in per message.
- PoW policy is enforced on both send (mined per recipient) and receive (verified against the outer envelope id post-decryption).

## Links

- Protocol spec: [nvelope-core/SPEC.md](https://github.com/StevenDay83/nvelope-core/blob/master/SPEC.md)
- Protocol library: [nvelope-core](https://github.com/StevenDay83/nvelope-core)

## License

MIT
