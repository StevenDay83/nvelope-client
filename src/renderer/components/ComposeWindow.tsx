import Composer from './Composer'

interface Props {
  data: Record<string, unknown>
}

export default function ComposeWindow({ data }: Props) {
  return (
    <div className="h-screen w-screen overflow-hidden bg-neutral-900 text-neutral-100">
      <Composer
        identityId={String(data.identityId ?? '')}
        accountId={String(data.accountId ?? '')}
        accountDisplayName={data.accountDisplayName ? String(data.accountDisplayName) : undefined}
        accountNpub={data.accountNpub ? String(data.accountNpub) : undefined}
        initialRecipient={data.recipientNpub ? String(data.recipientNpub) : undefined}
        initialSubject={data.subject ? String(data.subject) : undefined}
        initialBody={data.body ? String(data.body) : undefined}
        initialFormat={(data.format as 'plaintext' | 'markdown' | 'html') ?? 'plaintext'}
        initialThreadId={data.threadId ? String(data.threadId) : undefined}
        initialDraftId={data.draftId ? String(data.draftId) : undefined}
        windowMode
        onClose={() => window.close()}
        onSent={() => window.close()}
      />
    </div>
  )
}
