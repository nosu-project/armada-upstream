import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { formatTime } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

interface AudioMessageProps {
  src: string;
  mime?: string;
  /** Space-separated 0–100 amplitude samples from the imeta `waveform` field. */
  waveform?: string;
  /** Duration in seconds from the imeta `duration` field. */
  duration?: string;
  className?: string;
}

const BAR_COUNT = 48;

/** Downsample (or pad) a waveform to a fixed number of bars. */
function toBars(waveform: string | undefined): number[] {
  const raw = waveform
    ?.split(/\s+/)
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n)) ?? [];

  if (raw.length === 0) {
    // Synthetic gentle wave when no waveform data is available
    return Array.from({ length: BAR_COUNT }, (_, i) => 30 + Math.round(25 * Math.sin(i / 2.5)));
  }

  if (raw.length <= BAR_COUNT) return raw;

  const bars: number[] = [];
  const step = raw.length / BAR_COUNT;
  for (let i = 0; i < BAR_COUNT; i++) {
    const start = Math.floor(i * step);
    const end = Math.floor((i + 1) * step);
    let max = 0;
    for (let j = start; j < end && j < raw.length; j++) {
      if (raw[j] > max) max = raw[j];
    }
    bars.push(max);
  }
  return bars;
}

/**
 * Compact chat audio player: play/pause button, clickable waveform with
 * playback progress, and a duration label. Used for voice messages and
 * other audio attachments.
 */
export function AudioMessage({ src, mime, waveform, duration, className }: AudioMessageProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(() => {
    const parsed = Number.parseFloat(duration ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  });

  const bars = useMemo(() => toBars(waveform), [waveform]);
  const progress = mediaDuration > 0 ? currentTime / mediaDuration : 0;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    const onTime = () => setCurrentTime(audio.currentTime);
    const onDur = () => {
      if (Number.isFinite(audio.duration)) setMediaDuration(audio.duration);
    };
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("durationchange", onDur);
    audio.addEventListener("loadedmetadata", onDur);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("durationchange", onDur);
      audio.removeEventListener("loadedmetadata", onDur);
    };
  }, []);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play();
    else audio.pause();
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const audio = audioRef.current;
    if (!audio || !mediaDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * mediaDuration;
  };

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 my-1.5 max-w-sm rounded-2xl border border-border bg-secondary/30 px-3 py-2",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <audio ref={audioRef} preload="metadata" className="hidden">
        {mime ? <source src={src} type={mime} /> : <source src={src} />}
      </audio>

      <button
        type="button"
        onClick={togglePlay}
        aria-label={isPlaying ? "Pause" : "Play"}
        className="size-9 shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 transition-opacity"
      >
        {isPlaying ? <Pause className="size-4" fill="currentColor" /> : <Play className="size-4 ml-0.5" fill="currentColor" />}
      </button>

      <div
        className="flex-1 flex items-center gap-[2px] h-8 cursor-pointer"
        onClick={handleSeek}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(mediaDuration)}
        aria-valuenow={Math.round(currentTime)}
      >
        {bars.map((amp, i) => {
          const played = bars.length > 0 && i / bars.length <= progress;
          const h = 4 + (amp / 100) * 24;
          return (
            <div
              key={i}
              className={cn(
                "w-[3px] shrink-0 rounded-full transition-colors",
                played ? "bg-primary" : "bg-muted-foreground/40",
              )}
              style={{ height: `${h}px` }}
            />
          );
        })}
      </div>

      <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
        {formatTime(isPlaying || currentTime > 0 ? currentTime : mediaDuration)}
      </span>
    </div>
  );
}
