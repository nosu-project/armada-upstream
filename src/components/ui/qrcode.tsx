import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

interface QRCodeCanvasProps {
  value: string;
  size?: number;
  level?: 'L' | 'M' | 'Q' | 'H';
  className?: string;
}

/**
 * A QR code rendered as an `<img>` from an SVG data URL — never a `<canvas>`.
 *
 * Drawing to a canvas is fine, but reading one back (`toDataURL`/`getImageData`)
 * is exactly what canvas-fingerprint blockers (Brave, Tor Browser,
 * `resistFingerprinting`, CanvasBlocker-type extensions) poison or refuse, which
 * can blank a QR. SVG never touches a canvas, so it is immune to any canvas
 * policy; carried as a data URL (not innerHTML) the browser script-sandboxes it.
 * The `Canvas` name is retained for its call sites.
 */
export function QRCodeCanvas({ value, size = 256, level = 'M', className }: QRCodeCanvasProps) {
  const [dataUrl, setDataUrl] = useState('');

  useEffect(() => {
    let active = true;
    QRCode.toString(value, {
      type: 'svg',
      width: size,
      margin: 1,
      errorCorrectionLevel: level,
    })
      .then((svg) => {
        if (active) setDataUrl(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
      })
      .catch((error) => {
        console.error('QR Code generation error:', error);
        if (active) setDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [value, size, level]);

  // Hold the layout with a sized placeholder until the SVG is ready, so an
  // empty `src` never flashes a broken-image icon.
  if (!dataUrl) {
    return <div style={{ width: size, height: size }} className={className} />;
  }

  return (
    <img
      src={dataUrl}
      alt="QR code"
      width={size}
      height={size}
      className={className}
      decoding="async"
    />
  );
}
