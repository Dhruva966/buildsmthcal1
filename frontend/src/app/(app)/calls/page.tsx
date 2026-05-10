'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

type Call = {
  id: string
  retell_call_id: string | null
  outcome: string | null
  transcript: string | null
  sentiment: string | null
  duration_seconds: number | null
  created_at: string
  patients: { name: string; phone: string } | null
  appointments: { appointment_type: string; scheduled_at: string; provider_name: string | null } | null
}

function outcomeBadge(outcome: string | null) {
  const map: Record<string, string> = {
    confirmed: 'bg-green-500/20 text-green-400',
    rescheduled: 'bg-purple-500/20 text-purple-400',
    declined: 'bg-red-500/20 text-red-400',
    no_answer: 'bg-gray-500/20 text-gray-400',
  }
  return map[outcome || ''] || 'bg-gray-500/20 text-gray-400'
}

function sentimentBadge(sentiment: string | null) {
  const map: Record<string, string> = {
    positive: 'bg-green-500/20 text-green-400',
    anxious: 'bg-yellow-500/20 text-yellow-400',
    hostile: 'bg-red-500/20 text-red-400',
    neutral: 'bg-gray-500/20 text-gray-400',
  }
  return map[sentiment || ''] || 'bg-gray-500/20 text-gray-400'
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function fmtDuration(s: number | null) {
  if (s === null) return '—'
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export default function CallsPage() {
  const [calls, setCalls] = useState<Call[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${API}/api/calls`)
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(setCalls)
      .catch(() => toast.error('Failed to load call history'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Call History</h1>
        <p className="text-sm text-muted-foreground mt-1">All outbound calls with outcomes and transcripts</p>
      </div>

      {/* Summary stats */}
      {!loading && calls.length > 0 && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Total Calls', value: calls.length, color: 'text-foreground' },
            { label: 'Confirmed', value: calls.filter(c => c.outcome === 'confirmed').length, color: 'text-green-400' },
            { label: 'Rescheduled', value: calls.filter(c => c.outcome === 'rescheduled').length, color: 'text-purple-400' },
            { label: 'No Answer', value: calls.filter(c => c.outcome === 'no_answer' || !c.outcome).length, color: 'text-gray-400' },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-xl border border-border p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Calls table */}
      <div className="rounded-xl border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 border-b border-border">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Date</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Patient</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Type</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Duration</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Outcome</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Sentiment</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="text-center py-12 text-muted-foreground">Loading…</td></tr>
            ) : calls.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-muted-foreground">
                  No calls yet. Trigger a call from the Dashboard or Batch Call page.
                </td>
              </tr>
            ) : (
              calls.map(call => (
                <>
                  <tr
                    key={call.id}
                    className="border-t border-border hover:bg-muted/20 cursor-pointer transition-colors"
                    onClick={() => setExpanded(expanded === call.id ? null : call.id)}
                  >
                    <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                      {fmtDate(call.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{call.patients?.name ?? 'Unknown'}</div>
                      <div className="text-xs text-muted-foreground font-mono">{call.patients?.phone ?? '—'}</div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {call.appointments?.appointment_type ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {fmtDuration(call.duration_seconds)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-md text-xs capitalize ${outcomeBadge(call.outcome)}`}>
                        {call.outcome ?? 'pending'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-md text-xs capitalize ${sentimentBadge(call.sentiment)}`}>
                        {call.sentiment ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {call.transcript ? (expanded === call.id ? '▲' : '▼') : ''}
                    </td>
                  </tr>
                  {expanded === call.id && call.transcript && (
                    <tr key={`${call.id}-transcript`} className="border-t border-border bg-muted/10">
                      <td colSpan={7} className="px-6 py-4">
                        <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Transcript</p>
                        <pre className="text-xs text-foreground/80 whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">
                          {call.transcript}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
