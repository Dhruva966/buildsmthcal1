'use client'

import { useEffect, useState, useRef } from 'react'
import { toast } from 'sonner'
import Link from 'next/link'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

type Appointment = {
  id: string
  patient_id: string
  scheduled_at: string
  appointment_type: string
  provider_name: string | null
  status: string
  risk_score: number | null
  risk_reason: string | null
  outreach_status: string
  patients: { name: string; phone: string } | null
}

type WaitlistEntry = {
  id: string
  desired_slot: string
  desired_provider: string | null
  priority_score: number
  claimed_at: string | null
  patients: { name: string } | null
}

function riskColor(score: number | null) {
  if (score === null) return 'bg-gray-500/20 text-gray-400'
  if (score >= 0.7) return 'bg-red-500/20 text-red-400 font-bold'
  if (score >= 0.4) return 'bg-yellow-500/20 text-yellow-400'
  return 'bg-green-500/20 text-green-400'
}

function outreachBadge(status: string) {
  const map: Record<string, string> = {
    pending: 'bg-gray-500/20 text-gray-400',
    called: 'bg-blue-500/20 text-blue-400',
    confirmed: 'bg-green-500/20 text-green-400',
    rescheduled: 'bg-purple-500/20 text-purple-400',
    failed: 'bg-red-500/20 text-red-400',
  }
  return map[status] || 'bg-gray-500/20 text-gray-400'
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

export default function DashboardPage() {
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([])
  const [calling, setCalling] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [activeCalls, setActiveCalls] = useState<number>(0)
  const fileRef = useRef<HTMLInputElement>(null)

  async function fetchData() {
    try {
      const [apptRes, wlRes, healthRes] = await Promise.all([
        fetch(`${API}/api/appointments/all`),
        fetch(`${API}/api/waitlist`),
        fetch(`${API}/api/health`),
      ])
      if (apptRes.ok) setAppointments(await apptRes.json())
      if (wlRes.ok) setWaitlist(await wlRes.json())
      if (healthRes.ok) { const h = await healthRes.json(); setActiveCalls(h.activeCalls ?? 0) }
    } catch {
      toast.error('Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [])

  async function handleCSVUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await fetch(`${API}/api/upload-csv`, { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      toast.success(`Ingested ${data.total} appointments`)
      await fetchData()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleCallNow(appointmentId: string) {
    setCalling(appointmentId)
    try {
      const res = await fetch(`${API}/api/calls/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointment_id: appointmentId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Call failed')
      toast.success('Call initiated via OpenAI + Twilio')
      await fetchData()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Call failed')
    } finally {
      setCalling(null)
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Appointments, outreach status, and risk scores
          </p>
        </div>
        <div className="flex items-center gap-3">
          {activeCalls > 0 && (
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-500/15 text-blue-400 text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              {activeCalls} active call{activeCalls !== 1 ? 's' : ''}
            </span>
          )}
          <Link
            href="/calls"
            className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted/40 transition"
          >
            Call History
          </Link>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleCSVUpload}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition"
          >
            {uploading ? 'Uploading…' : '↑ Upload CSV'}
          </button>
        </div>
      </div>

      {/* Appointments Table */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-3">
          Appointments
        </h2>
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Patient</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Scheduled</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Type</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Provider</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Risk</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground max-w-xs">Reason</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="text-center py-8 text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : appointments.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-8 text-muted-foreground">
                    No appointments yet. Upload a CSV to get started.
                  </td>
                </tr>
              ) : (
                appointments.map((a) => (
                  <tr key={a.id} className="border-t border-border hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 font-medium">
                      {a.patients?.name ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {fmt(a.scheduled_at)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{a.appointment_type}</td>
                    <td className="px-4 py-3 text-muted-foreground">{a.provider_name ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-md text-xs ${riskColor(a.risk_score)}`}>
                        {a.risk_score !== null ? a.risk_score.toFixed(2) : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs max-w-xs truncate">
                      {a.risk_reason ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-md text-xs capitalize ${outreachBadge(a.outreach_status)}`}>
                        {a.outreach_status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleCallNow(a.id)}
                        disabled={calling === a.id || a.outreach_status === 'confirmed'}
                        className="px-3 py-1 rounded-md bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed transition whitespace-nowrap"
                      >
                        {calling === a.id ? 'Calling…' : 'Call Now'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Waitlist */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-3">
          Waitlist
        </h2>
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Patient</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Desired Slot</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Provider</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Priority</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody>
              {waitlist.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-muted-foreground">
                    No patients on waitlist.
                  </td>
                </tr>
              ) : (
                waitlist.map((w) => (
                  <tr key={w.id} className="border-t border-border hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 font-medium">{w.patients?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {fmt(w.desired_slot)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{w.desired_provider ?? 'Any'}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-muted-foreground">
                        {(w.priority_score * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-md text-xs ${w.claimed_at ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'}`}>
                        {w.claimed_at ? 'Claimed' : 'Waiting'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
