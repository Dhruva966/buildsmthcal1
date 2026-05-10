'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import Papa from 'papaparse'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

type Appointment = {
  id: string
  scheduled_at: string
  appointment_type: string
  provider_name: string | null
  risk_score: number | null
  outreach_status: string
  patients: { name: string; phone: string } | null
}

type Contact = {
  name: string
  phone: string
  appointment_type?: string
  scheduled_at?: string
  provider_name?: string
}

type BatchItem = {
  id: string
  appointment_id: string | null
  phone: string
  name: string
  status: 'pending' | 'calling' | 'done' | 'failed' | 'cancelled'
  callSid?: string
  outcome?: string
}

type BatchStatus = {
  total: number
  pending: number
  calling: number
  done: number
  failed: number
  active: boolean
  queue: BatchItem[]
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function riskColor(score: number | null) {
  if (score === null) return 'bg-gray-500/20 text-gray-400'
  if (score >= 0.7) return 'bg-red-500/20 text-red-400 font-bold'
  if (score >= 0.4) return 'bg-yellow-500/20 text-yellow-400'
  return 'bg-green-500/20 text-green-400'
}

function StatusPill({ status }: { status: BatchItem['status'] }) {
  const map: Record<string, string> = {
    pending: 'bg-gray-500/20 text-gray-400',
    calling: 'bg-blue-500/20 text-blue-400',
    done: 'bg-green-500/20 text-green-400',
    failed: 'bg-red-500/20 text-red-400',
    cancelled: 'bg-gray-500/10 text-gray-500',
  }
  const label: Record<string, string> = {
    pending: 'Pending',
    calling: '📞 Calling…',
    done: '✓ Done',
    failed: '✗ Failed',
    cancelled: 'Cancelled',
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${map[status] || map.pending}`}>
      {label[status] || status}
    </span>
  )
}

export default function BatchCallPage() {
  const [tab, setTab] = useState<'appointments' | 'csv'>('appointments')
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [csvContacts, setCsvContacts] = useState<Contact[]>([])
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const csvRef = useRef<HTMLInputElement>(null)

  const fetchAppointments = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/appointments/all`)
      if (res.ok) setAppointments(await res.json())
    } catch {
      toast.error('Failed to load appointments')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchBatchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/calls/batch-status`)
      if (res.ok) {
        const data: BatchStatus = await res.json()
        setBatchStatus(data)
        if (data.total > 0 && data.pending === 0 && !data.active) {
          stopPolling()
        }
      }
    } catch { /* ignore */ }
  }, [])

  function startPolling() {
    if (pollRef.current) return
    pollRef.current = setInterval(fetchBatchStatus, 3000)
  }

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  useEffect(() => {
    fetchAppointments()
    fetchBatchStatus()
    return () => stopPolling()
  }, [fetchAppointments, fetchBatchStatus])

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (selected.size === appointments.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(appointments.map(a => a.id)))
    }
  }

  function handleCSVUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    Papa.parse<Contact>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: h => h.trim().toLowerCase().replace(/\s+/g, '_'),
      complete: (result) => {
        const contacts = result.data.filter(r => r.phone)
        if (contacts.length === 0) {
          toast.error('No valid rows found. CSV needs a "phone" column.')
          return
        }
        setCsvContacts(contacts)
        toast.success(`Loaded ${contacts.length} contacts from CSV`)
      },
      error: () => toast.error('Failed to parse CSV'),
    })
    if (csvRef.current) csvRef.current.value = ''
  }

  async function startBatch() {
    const body =
      tab === 'appointments'
        ? { appointment_ids: [...selected] }
        : { contacts: csvContacts }

    const count = tab === 'appointments' ? selected.size : csvContacts.length
    if (count === 0) {
      toast.error('Select at least one contact to call')
      return
    }

    setStarting(true)
    try {
      const res = await fetch(`${API}/api/calls/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to start batch')
      setBatchStatus(await (await fetch(`${API}/api/calls/batch-status`)).json())
      startPolling()
      toast.success(`Batch started — ${data.queued} calls queued`)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Start failed')
    } finally {
      setStarting(false)
    }
  }

  async function cancelBatch() {
    await fetch(`${API}/api/calls/batch`, { method: 'DELETE' })
    stopPolling()
    await fetchBatchStatus()
    toast.info('Batch cancelled')
  }

  const batchRunning = batchStatus && (batchStatus.active || batchStatus.pending > 0)
  const batchDone = batchStatus && batchStatus.total > 0 && !batchStatus.active && batchStatus.pending === 0
  const pct = batchStatus && batchStatus.total > 0
    ? Math.round(((batchStatus.done + batchStatus.failed) / batchStatus.total) * 100)
    : 0

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Batch Call</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Call patients consecutively via OpenAI voice + Twilio
          </p>
        </div>
      </div>

      {/* Progress panel — shown when batch is running or done */}
      {batchStatus && batchStatus.total > 0 && (
        <section className="rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              {batchRunning ? 'Batch in progress…' : batchDone ? 'Batch complete' : 'Batch status'}
            </h2>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                {batchStatus.done + batchStatus.failed} / {batchStatus.total} calls
              </span>
              {batchRunning && (
                <button
                  onClick={cancelBatch}
                  className="text-xs px-3 py-1 rounded-md border border-border hover:bg-muted/40 transition text-muted-foreground"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          {/* Progress bar */}
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>

          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>✓ Done: {batchStatus.done}</span>
            <span>📞 Calling: {batchStatus.calling}</span>
            <span>⧖ Pending: {batchStatus.pending}</span>
            {batchStatus.failed > 0 && <span className="text-red-400">✗ Failed: {batchStatus.failed}</span>}
          </div>

          {/* Per-row status */}
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">#</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Phone</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {batchStatus.queue.map((item, i) => (
                  <tr key={item.id} className="border-t border-border">
                    <td className="px-4 py-2 text-muted-foreground text-xs">{i + 1}</td>
                    <td className="px-4 py-2 font-medium">{item.name}</td>
                    <td className="px-4 py-2 text-muted-foreground font-mono text-xs">{item.phone}</td>
                    <td className="px-4 py-2"><StatusPill status={item.status} /></td>
                    <td className="px-4 py-2 text-xs text-muted-foreground capitalize">{item.outcome ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Input section — hidden while batch is actively running */}
      {!batchRunning && (
        <section className="space-y-4">
          {/* Tabs */}
          <div className="flex gap-1 p-1 rounded-lg bg-muted/40 w-fit">
            {(['appointments', 'csv'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
                  tab === t ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t === 'appointments' ? '◦ Select Appointments' : '◦ Upload CSV'}
              </button>
            ))}
          </div>

          {/* Tab: Appointments */}
          {tab === 'appointments' && (
            <div className="rounded-xl border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 border-b border-border">
                  <tr>
                    <th className="px-4 py-3 w-10">
                      <input
                        type="checkbox"
                        checked={selected.size === appointments.length && appointments.length > 0}
                        onChange={toggleAll}
                        className="rounded"
                      />
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Patient</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Phone</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Scheduled</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Type</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Risk</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">Loading…</td></tr>
                  ) : appointments.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">No appointments yet. Upload a CSV on the Dashboard first.</td></tr>
                  ) : (
                    appointments.map(a => (
                      <tr
                        key={a.id}
                        className={`border-t border-border cursor-pointer transition-colors ${selected.has(a.id) ? 'bg-primary/5' : 'hover:bg-muted/20'}`}
                        onClick={() => toggleSelect(a.id)}
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selected.has(a.id)}
                            onChange={() => toggleSelect(a.id)}
                            onClick={e => e.stopPropagation()}
                            className="rounded"
                          />
                        </td>
                        <td className="px-4 py-3 font-medium">{a.patients?.name ?? '—'}</td>
                        <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{a.patients?.phone ?? '—'}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">{fmt(a.scheduled_at)}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">{a.appointment_type}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded-md text-xs ${riskColor(a.risk_score)}`}>
                            {a.risk_score !== null ? a.risk_score.toFixed(2) : '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-block px-2 py-0.5 rounded-md text-xs bg-gray-500/10 text-muted-foreground capitalize">
                            {a.outreach_status}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Tab: CSV */}
          {tab === 'csv' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-dashed border-border p-8 text-center space-y-3">
                <p className="text-muted-foreground text-sm">
                  Upload a CSV with columns: <code className="bg-muted px-1 rounded text-xs">name</code>, <code className="bg-muted px-1 rounded text-xs">phone</code>
                </p>
                <p className="text-xs text-muted-foreground">
                  Optional: <code className="bg-muted px-1 rounded text-xs">appointment_type</code>, <code className="bg-muted px-1 rounded text-xs">scheduled_at</code>, <code className="bg-muted px-1 rounded text-xs">provider_name</code>
                </p>
                <input ref={csvRef} type="file" accept=".csv" className="hidden" onChange={handleCSVUpload} />
                <button
                  onClick={() => csvRef.current?.click()}
                  className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted/40 transition"
                >
                  Choose CSV file
                </button>
              </div>

              {csvContacts.length > 0 && (
                <div className="rounded-xl border border-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 border-b border-border">
                      <tr>
                        <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">#</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Name</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Phone</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Type</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Scheduled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {csvContacts.map((c, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="px-4 py-2 text-muted-foreground text-xs">{i + 1}</td>
                          <td className="px-4 py-2 font-medium">{c.name || '—'}</td>
                          <td className="px-4 py-2 text-muted-foreground font-mono text-xs">{c.phone}</td>
                          <td className="px-4 py-2 text-muted-foreground text-xs">{c.appointment_type || '—'}</td>
                          <td className="px-4 py-2 text-muted-foreground text-xs">{c.scheduled_at || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Start button */}
          <div className="flex items-center gap-3">
            <button
              onClick={startBatch}
              disabled={starting || (tab === 'appointments' ? selected.size === 0 : csvContacts.length === 0)}
              className="px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {starting
                ? 'Starting…'
                : `Start Batch Call${tab === 'appointments' && selected.size > 0 ? ` (${selected.size})` : tab === 'csv' && csvContacts.length > 0 ? ` (${csvContacts.length})` : ''}`}
            </button>
            {tab === 'appointments' && selected.size > 0 && (
              <span className="text-sm text-muted-foreground">{selected.size} patient{selected.size !== 1 ? 's' : ''} selected</span>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
