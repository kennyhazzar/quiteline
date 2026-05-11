import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import './globals.css'
import { ColorSchemeScript } from '@mantine/core'
import { Providers } from './providers'
import type { Metadata, Viewport } from 'next'

export const metadata: Metadata = {
  title: 'Quietline',
  description: 'Client-side encrypted WebSocket messenger',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Quietline',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
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
