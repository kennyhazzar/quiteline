import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  const webManifest: MetadataRoute.Manifest & {
    gcm_sender_id: string
    gcm_user_visible_only: boolean
  } = {
    name: 'Quietline',
    short_name: 'Quietline',
    description: 'Private realtime messenger',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#111315',
    theme_color: '#111315',
    gcm_sender_id: '103953800507',
    gcm_user_visible_only: true,
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  }
  return webManifest
}
