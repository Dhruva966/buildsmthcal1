'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const nav = [
  {
    section: 'BUILD',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: '▦' },
      { label: 'Batch Call', href: '/batch-call', icon: '◈' },
    ],
  },
  {
    section: 'MONITOR',
    items: [
      { label: 'Call History', href: '/calls', icon: '◷' },
    ],
  },
]

export default function Sidebar() {
  const path = usePathname()

  return (
    <aside className="w-52 shrink-0 flex flex-col border-r border-border bg-sidebar min-h-screen">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-border">
        <span className="text-base font-bold tracking-tight text-foreground">Cadence</span>
        <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">No-show prevention</p>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-5">
        {nav.map(({ section, items }) => (
          <div key={section}>
            <p className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              {section}
            </p>
            <ul className="space-y-0.5">
              {items.map(({ label, href, icon }) => {
                const active = path === href || path.startsWith(href + '/')
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm transition-colors ${
                        active
                          ? 'bg-primary/15 text-primary font-medium'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                      }`}
                    >
                      <span className="text-xs opacity-70">{icon}</span>
                      {label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-border">
        <p className="text-[10px] text-muted-foreground">Powered by OpenAI + Twilio</p>
      </div>
    </aside>
  )
}
