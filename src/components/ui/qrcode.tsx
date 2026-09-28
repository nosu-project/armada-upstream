import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

interface QRCodeCanvasProps {
  value: string;
  size?: number;
  level?: 'L' | 'M' | 'Q' | 'H';
  className?: string;
}

/**
 * QR code as an `<img>` from an SVG data URL, never a `<canvas>`: fingerprint
 * blockers poison canvas readback. Name kept for call sites.
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

  // Sized placeholder so an empty `src` never flashes a broken image.
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
