import { useCallback, useEffect, useRef, useState } from "react";

import type { RefObject } from "react";

interface UsePlayerControlsOptions {
  mediaRef: RefObject<HTMLMediaElement | null>;
  /** Observed for IntersectionObserver and mouse events. */
  containerRef: RefObject<HTMLElement | null>;
  isPlaying: boolean;
}

interface UsePlayerControlsReturn {
  showControls: boolean;
  revealControls: () => void;
  scheduleHide: () => void;
  isMuted: boolean;
  volume: number;
  toggleMute: (e: React.MouseEvent) => void;
  handleVolumeChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

/**
 * Custom video player behaviour: auto-hide controls 2.5s after mouse movement, pause when
 * scrolled out of view, and track volume/mute via `volumechange` (e.g. muted autoplay).
 */
export function usePlayerControls({
  mediaRef,
  containerRef,
  isPlaying,
}: UsePlayerControlsOptions): UsePlayerControlsReturn {
  const [showControls, setShowControls] = useState(true);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const scheduleHide = useCallback(() => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    if (isPlaying) {
      hideTimeoutRef.current = setTimeout(() => setShowControls(false), 2500);
    }
  }, [isPlaying]);

  const revealControls = useCallback(() => {
    setShowControls(true);
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => {
    if (isPlaying) {
      scheduleHide();
    } else {
      setShowControls(true);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    }
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, [isPlaying, scheduleHide]);

  useEffect(() => {
    const media = mediaRef.current;
    const container = containerRef.current;
    if (!media || !container) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting && !media.paused) media.pause();
      },
      { threshold: 0.25 },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [mediaRef, containerRef]);

  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const prevVolumeRef = useRef(1);

  // Covers programmatic changes (e.g. autoplay muting).
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;

    const sync = () => {
      setIsMuted(media.muted);
      setVolume(media.muted ? 0 : media.volume);
    };

    sync();
    media.addEventListener("volumechange", sync);
    return () => media.removeEventListener("volumechange", sync);
  }, [mediaRef]);

  const toggleMute = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const media = mediaRef.current;
      if (!media) return;
      if (media.muted || media.volume === 0) {
        const restored = prevVolumeRef.current > 0 ? prevVolumeRef.current : 0.5;
        media.muted = false;
        media.volume = restored;
        setIsMuted(false);
        setVolume(restored);
      } else {
        prevVolumeRef.current = media.volume;
        media.muted = true;
        setIsMuted(true);
      }
    },
    [mediaRef],
  );

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      e.stopPropagation();
      const media = mediaRef.current;
      if (!media) return;
      const v = parseFloat(e.target.value);
      media.volume = v;
      media.muted = v === 0;
      if (v > 0) prevVolumeRef.current = v;
      setVolume(v);
      setIsMuted(v === 0);
    },
    [mediaRef],
  );

  return { showControls, revealControls, scheduleHide, isMuted, volume, toggleMute, handleVolumeChange };
}
