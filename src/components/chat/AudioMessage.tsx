import { Music, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MediaFallback } from "@/components/chat/MediaFallback";
import { hasAudioMetadata, useAudioMetadata, useAudioWaveform } from "@/hooks/useAudioMetadata";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import {
  pauseOthers,
  playNextAfter,
  registerAudioPlayer,
} from "@/lib/audioPlaybackQueue";
import { formatTime } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

import type { ImetaEncryption } from "@/lib/imeta";

interface AudioMessageProps {
  src: string;
  mime?: string;
  /** AES-GCM decryption params for client-encrypted (Concord/Vector) blobs. */
  encryption?: ImetaEncryption;
  /** Sender-declared alternative sources (imeta `fallback`), same key and nonce. */
  fallbacks?: string[];
  /** Space-separated 0–100 amplitude samples from the imeta `waveform` field. */
  waveform?: string;
  /** Duration in seconds from the imeta `duration` field. */
  duration?: string;
  className?: string;
}

const BAR_COUNT = 48;

/** Parse the imeta `waveform` field's space-separated amplitudes. */
function parseWaveform(waveform: string | undefined): number[] {
  return waveform
    ?.split(/\s+/)
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n)) ?? [];
}

/** Downsample (or pad) a waveform to a fixed number of bars. */
function toBars(raw: number[] | null | undefined): number[] {
  if (!raw || raw.length === 0) {
    // Flat while the real shape is unknown (not yet decoded, or undecodable):
    // anything else would be a shape the file doesn't have.
    return Array.from({ length: BAR_COUNT }, () => 20);
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
 * other audio attachments. A music file that carries its own tags or cover
 * art (read out of the file, not the event) is presented as a track: the art
 * beside its title, artist and album.
 */
export function AudioMessage({
  src,
  mime,
  encryption,
  fallbacks,
  waveform,
  duration,
  className,
}: AudioMessageProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  // Set when a coordinated `play()` request arrives before the <audio> element
  // has mounted (encrypted blobs mount lazily once decrypted); consumed on the
  // next play attempt.
  const wantsPlayRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(() => {
    const parsed = Number.parseFloat(duration ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  });

  // Encrypted (Concord/Vector) attachments are AES-GCM ciphertext on Blossom:
  // fetch + decrypt to an object URL before handing anything to <audio>.
  // Plain URLs resolve immediately to themselves.
  const { resolved, onError, failed, fallbackProps } = useMediaWithFallback({ url: src, encryption, mime, fallbacks });

  const resolvedSrc = resolved.status === "ready" ? resolved.src : undefined;

  // The file's own tags. Read from the resolved bytes: a decrypted object URL
  // in memory, or a plain URL read by range request for just the tag block.
  const meta = useAudioMetadata(src, resolvedSrc);

  // A voice message carries its recorder's waveform. Anything else has its
  // shape computed from its own decoded samples: at once when the bytes are
  // already in memory (a decrypted `blob:`), but for a plain URL only once it
  // is played, since that means downloading the whole file.
  const declared = useMemo(() => parseWaveform(waveform), [waveform]);
  const [hasPlayed, setHasPlayed] = useState(false);
  const waveformSrc = declared.length > 0 || !resolvedSrc
    ? undefined
    : resolvedSrc.startsWith("blob:") || hasPlayed
      ? resolvedSrc
      : undefined;
  const computed = useAudioWaveform(src, waveformSrc);

  const bars = useMemo(() => toBars(declared.length > 0 ? declared : computed), [declared, computed]);
  const progress = mediaDuration > 0 ? currentTime / mediaDuration : 0;

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // A rejected play() is either the browser refusing to start without a
  // gesture (NotAllowedError — leave it paused for the user to tap) or the
  // source being unplayable (NotSupportedError). The latter is a failed
  // candidate just like an `error` event, so it walks to the next one — and
  // the viewer asked to hear it, so the next candidate starts playing.
  //
  // Only for the element still mounted: a candidate whose <source> error has
  // already walked the fallback on can reject its play() afterwards, and
  // acting on that too would skip the candidate that replaced it.
  const playOn = useCallback((audio: HTMLAudioElement) => {
    audio.play().catch((err: unknown) => {
      if (audioRef.current !== audio) return;
      if ((err as { name?: string } | null)?.name !== "NotSupportedError") return;
      wantsPlayRef.current = true;
      onErrorRef.current();
    });
  }, []);

  // Imperatively start playback. Used both by the play button and by the
  // playback coordinator (auto-advance). If the <audio> element hasn't mounted
  // yet (encrypted blob still decrypting), flag it to play as soon as it does.
  const play = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      playOn(audio);
    } else {
      wantsPlayRef.current = true;
    }
  }, [playOn]);

  // Register with the cross-component coordinator so this player participates in
  // single-playback and auto-advance. `play` is stable, so this runs once.
  useEffect(() => registerAudioPlayer({ get el() { return audioRef.current; }, play }), [play]);

  // The <audio> element only mounts once the src is resolved, and is replaced
  // whenever the fallback walk moves to another candidate (see its `key`), so
  // re-attach listeners to whichever element is current.
  const currentSrc = resolved.status === "ready" ? resolved.src : undefined;
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // A replacement element starts from nothing; the one it replaced may have
    // been torn down mid-playback, before its `pause` could arrive.
    setIsPlaying(!audio.paused);
    setCurrentTime(audio.currentTime);
    const onPlay = () => {
      setIsPlaying(true);
      setHasPlayed(true);
      // Only one voice note plays at a time.
      pauseOthers(audio);
    };
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      // Continue the thread: play the next voice note in document order.
      playNextAfter(audio);
    };
    const onTime = () => setCurrentTime(audio.currentTime);
    const onDur = () => {
      if (Number.isFinite(audio.duration)) setMediaDuration(audio.duration);
    };
    // Honour a play request that arrived before this element mounted.
    if (wantsPlayRef.current) {
      wantsPlayRef.current = false;
      playOn(audio);
    }
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
  }, [currentSrc, playOn]);

  // A walk that ran out of candidates drops the request to play: a later
  // Retry is a fresh start, not permission to begin playing unprompted.
  useEffect(() => {
    if (failed) wantsPlayRef.current = false;
  }, [failed]);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) play();
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

  // Every mirror failed (bad key, blob gone, all servers down): link + retry.
  if (failed) {
    return <MediaFallback {...fallbackProps} label="Audio" />;
  }

  // Keyed by source: changing a mounted <source>'s src does nothing until
  // load() is called, so a fallback step would otherwise leave the element
  // stuck on the candidate that just failed. A fresh element runs resource
  // selection on the new one.
  const element = resolved.status === "ready" && (
    <audio key={resolved.src} ref={audioRef} preload="metadata" className="hidden" onError={onError}>
      {mime ? <source src={resolved.src} type={mime} /> : <source src={resolved.src} />}
    </audio>
  );

  const playButton = (
    <button
      type="button"
      onClick={togglePlay}
      aria-label={isPlaying ? "Pause" : "Play"}
      className="size-9 shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 transition-opacity"
    >
      {isPlaying ? <Pause className="size-4" fill="currentColor" /> : <Play className="size-4 ml-0.5" fill="currentColor" />}
    </button>
  );

  const scrubber = (
    <>
      <div
        className="flex-1 min-w-0 overflow-hidden flex items-center gap-[2px] h-8 cursor-pointer"
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
    </>
  );

  if (hasAudioMetadata(meta)) {
    const { title, artist, album, year, coverUrl } = meta;
    const details = [artist, album, year].filter(Boolean).join(" · ");
    return (
      <div
        className={cn(
          "flex items-center gap-3 my-1.5 max-w-sm rounded-2xl border border-border bg-secondary/30 p-2 pr-3",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {element}
        <CoverArt src={coverUrl} />
        <div className="flex-1 min-w-0">
          {(title || details) && (
            <div className="min-w-0 px-0.5">
              {title && <p className="truncate text-sm font-semibold leading-snug">{title}</p>}
              {details && <p className="truncate text-xs text-muted-foreground leading-snug">{details}</p>}
            </div>
          )}
          <div className="flex items-center gap-2.5 mt-1">
            {playButton}
            {scrubber}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 my-1.5 max-w-sm rounded-2xl border border-border bg-secondary/30 px-3 py-2",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {element}
      {playButton}
      {scrubber}
    </div>
  );
}

/** A track's cover art, or a music glyph where it has none or it won't decode. */
function CoverArt({ src }: { src?: string }) {
  const [broken, setBroken] = useState<string | undefined>(undefined);
  return (
    <div className="size-20 shrink-0 overflow-hidden rounded-lg bg-secondary flex items-center justify-center text-muted-foreground">
      {src && broken !== src ? (
        <img src={src} alt="" className="size-full object-cover" onError={() => setBroken(src)} />
      ) : (
        <Music className="size-7" />
      )}
    </div>
  );
}
