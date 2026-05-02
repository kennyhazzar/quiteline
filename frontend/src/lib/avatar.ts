const AVATAR_SIZE = 256
const AVATAR_QUALITY = 0.82

export async function compressAvatar(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) {
    throw new Error('avatar_must_be_image')
  }

  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_SIZE
    canvas.height = AVATAR_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas_unavailable')

    const sourceSize = Math.min(bitmap.width, bitmap.height)
    const sx = Math.floor((bitmap.width - sourceSize) / 2)
    const sy = Math.floor((bitmap.height - sourceSize) / 2)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, sx, sy, sourceSize, sourceSize, 0, 0, AVATAR_SIZE, AVATAR_SIZE)

    return await canvasToBlob(canvas)
  } finally {
    bitmap.close()
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('avatar_compression_failed'))
          return
        }
        resolve(blob)
      },
      'image/webp',
      AVATAR_QUALITY,
    )
  })
}
