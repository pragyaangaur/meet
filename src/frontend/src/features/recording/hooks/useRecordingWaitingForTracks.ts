import { useEffect, useState } from 'react'
import { useTracks } from '@livekit/components-react'
import { Track } from 'livekit-client'
import { RecordingMode } from '@/features/recording'
import { useRecordingStatuses } from './useRecordingStatuses'

const STARTING_NOTIFICATION_DELAY = 15_000

export const useRecordingWaitingForTracks = (mode: RecordingMode) => {
  const { isStarting } = useRecordingStatuses(mode)
  const tracks = useTracks(
    mode === RecordingMode.Transcript ? [Track.Source.Microphone] : undefined,
    { onlySubscribed: false }
  )
  // Since LiveKit Egress v1.13, a transcript only starts on actual audio,
  // which a muted microphone does not send.
  const hasTracks =
    mode === RecordingMode.Transcript
      ? tracks.some((track) => !track.publication.isMuted)
      : tracks.length > 0
  const [delayElapsed, setDelayElapsed] = useState(false)

  useEffect(() => {
    setDelayElapsed(false)
    if (!isStarting) return

    const timeout = window.setTimeout(
      () => setDelayElapsed(true),
      STARTING_NOTIFICATION_DELAY
    )
    return () => window.clearTimeout(timeout)
  }, [isStarting, mode])

  return isStarting && delayElapsed && !hasTracks
}
