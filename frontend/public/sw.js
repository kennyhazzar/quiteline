self.addEventListener('push', (event) => {
  let data = {
    title: 'Quietline',
    body: 'New event',
    url: '/',
  }
  try {
    if (event.data) data = { ...data, ...event.data.json() }
  } catch {
    // Keep the safe fallback payload.
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Quietline', {
      body: data.body || 'New event',
      tag: data.type || 'quietline-event',
      renotify: false,
      data: { url: data.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl)
          return client.focus()
        }
      }
      return clients.openWindow(targetUrl)
    }),
  )
})
