import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import './globals.css'
import { ColorSchemeScript } from '@mantine/core'
import { Providers } from './providers'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Quietline',
  description: 'Client-side encrypted WebSocket messenger',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <ColorSchemeScript />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
