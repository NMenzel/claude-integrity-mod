// Deterministic fixture projects: representative Next.js/React sources as the
// engine sees them after an edit. Strings, because tests run without a file
// system; each is a file a real project could hold.

/** 1. A functional component: fetches real data, handles failure, renders it. */
export const FUNCTIONAL = {
  'app/discover/EventList.tsx': `'use client'
import { useEffect, useState } from 'react'
import type { Event } from '@/lib/types'

export function EventList() {
  const [events, setEvents] = useState<Event[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/events')
        if (!res.ok) throw new Error(\`HTTP \${res.status}\`)
        setEvents(await res.json())
      } catch (err) {
        setError(String(err))
      }
    }
    void load()
  }, [])

  if (error) return <p role="alert">Could not load events: {error}</p>
  return (
    <ul>
      {events.map(e => <li key={e.id}><a href={\`/discover/\${e.id}\`}>{e.title}</a> · {e.venue}</li>)}
    </ul>
  )
}
`,
  'app/api/events/route.ts': `import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET() {
  const events = await db.event.findMany({ orderBy: { startsAt: 'asc' } })
  return NextResponse.json(events)
}
`,
}

/** 2. A static mock presented as live data: the page claims the API but renders a constant. */
export const MOCK_AS_LIVE = {
  'app/discover/page.tsx': `import { EventCard } from '@/components/EventCard'

// Events from the live API
const mockEvents = [
  { id: 1, title: 'Jazz Night', venue: 'Blue Room', startsAt: '2026-11-01T20:00' },
  { id: 2, title: 'Gallery Opening', venue: 'Space 9', startsAt: '2026-11-03T18:00' },
  { id: 3, title: 'Food Market', venue: 'Pier 4', startsAt: '2026-11-04T11:00' },
]

export default async function DiscoverPage() {
  const res = await fetch('https://api.events.local/v1/events')
  return (
    <main>
      <h1>Discover</h1>
      {mockEvents.map(e => <EventCard key={e.id} event={e} />)}
    </main>
  )
}
`,
}

/** 3. A legitimate prototype: the same pattern, but the contract asks for a mockup with fixtures. */
export const PROTOTYPE = {
  'app/discover/page.tsx': `import { sampleEvents } from '@/fixtures/events'
import { EventCard } from '@/components/EventCard'

export default function DiscoverPrototype() {
  return <main>{sampleEvents.map(e => <EventCard key={e.id} event={e} />)}</main>
}
`,
}

/** 4. An API contract mismatch: the client posts to a route nobody serves; the handler that exists fakes success. */
export const API_MISMATCH = {
  'app/discover/RegisterForm.tsx': `'use client'
export function RegisterForm({ eventId }: { eventId: string }) {
  async function onRegister() {
    try {
      const res = await fetch('/api/events/register', { method: 'POST', body: JSON.stringify({ eventId }) })
      if (!res.ok) throw new Error('failed')
    } catch {
      alert('Registration failed')
    }
  }
  return <button onClick={onRegister}>Register</button>
}
`,
  'app/api/registrations/route.ts': `import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const body = await request.json()
  return NextResponse.json({ success: true, id: body.eventId })
}
`,
}

/** 6. An incomplete event registration flow: inert button, local-only submit, a TODO, a not-implemented service. */
export const INCOMPLETE_REGISTRATION = {
  'components/RegisterPanel.tsx': `'use client'
import { useState } from 'react'
import { toast } from 'sonner'

export function RegisterPanel() {
  const [registered, setRegistered] = useState(false)

  const handleSubmit = async () => {
    // TODO: wire this to the registration API
    await new Promise(resolve => setTimeout(resolve, 800))
    setRegistered(true)
    toast.success('You are registered!')
  }

  return (
    <div>
      <button onClick={handleSubmit}>Register</button>
      <button onClick={() => {}}>Add to calendar</button>
      <a href="#">Terms</a>
      {registered && <p>See you there.</p>}
    </div>
  )
}
`,
  'lib/registration.ts': `export async function registerForEvent(eventId: string): Promise<void> {
  throw new Error('Not implemented')
}
`,
}

/** Test-runner output, as each runner prints it. */
export const OUTPUT = {
  jestPass: `PASS src/events.test.ts
Test Suites: 3 passed, 3 total
Tests:       24 passed, 24 total
Snapshots:   0 total
Time:        1.2 s`,
  jestFail: `FAIL src/events.test.ts
  ● events › sorts by start time
Test Suites: 1 failed, 2 passed, 3 total
Tests:       1 failed, 23 passed, 24 total`,
  vitestSkipped: ` Test Files  4 passed (4)
      Tests  20 passed | 3 skipped (23)`,
  pytest: `============ 12 passed, 1 skipped in 0.40s ============`,
  mocha: `  18 passing (32ms)
  2 failing`,
  nodeTest: `# tests 9
# pass 9
# fail 0`,
  truncated: `PASS src/a.test.ts
PASS src/b.test.ts
… 4000 more lines`,
  noTests: `No tests found, exiting with code 0`,
}
