"use client";

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { isAddress, getAddress } from "viem";

/** Reads a QR code containing an Ethereum address from the camera and reports it once. */
export function QrScanner({ onAddress }: { onAddress: (address: `0x${string}`) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("Point the camera at the collector's QR code");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    const tick = () => {
      const video = videoRef.current;
      if (video && video.readyState === video.HAVE_ENOUGH_DATA && !done) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height);
        const text = code?.data?.trim().replace(/^ethereum:/, "");
        if (text && isAddress(text)) {
          done = true;
          setStatus(`Found ${text}`);
          onAddress(getAddress(text));
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }).then((s) => {
      stream = s;
      if (videoRef.current) videoRef.current.srcObject = s;
      raf = requestAnimationFrame(tick);
    }).catch(() => setStatus("Camera unavailable, paste the address instead"));

    return () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onAddress]);

  return (
    <div className="space-y-2">
      <video ref={videoRef} autoPlay playsInline muted className="aspect-video w-full rounded-lg bg-black object-cover" />
      <p className="text-sm text-muted-foreground">{status}</p>
    </div>
  );
}
