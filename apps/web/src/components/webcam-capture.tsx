"use client";

import { useEffect, useRef, useState } from "react";
import { CameraIcon, SmartphoneIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Brackets, ScanStage } from "@/components/vendor/station";

/** Card aspect ratio (63 x 88 mm) and how much of the frame height the guide covers. */
const CARD_ASPECT = 63 / 88;
const GUIDE_HEIGHT = 0.8;
/** Longest edge of the emitted crop: plenty for a 224 px model input, small enough to preview. */
const MAX_CROP_EDGE = 680;

/** Live camera preview with a card-shaped guide. Emits a canvas holding just the guide region. */
export function WebcamCapture({
  onCapture,
  disabled,
  chip,
  footer,
}: {
  onCapture: (card: HTMLCanvasElement) => void;
  disabled?: boolean;
  /** Status chip for the stage's top-left corner. */
  chip?: React.ReactNode;
  /** Rendered next to the capture button (the station's search-by-name box). */
  footer?: React.ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((e) => setError(e instanceof Error ? e.message : "camera unavailable"));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  /** The guide rectangle in video pixels. */
  function guide(w: number, h: number) {
    const gh = Math.min(h * GUIDE_HEIGHT, (w * 0.95) / CARD_ASPECT);
    const gw = gh * CARD_ASPECT;
    return { x: (w - gw) / 2, y: (h - gh) / 2, w: gw, h: gh };
  }

  function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const g = guide(video.videoWidth, video.videoHeight);
    const scale = Math.min(1, MAX_CROP_EDGE / g.h);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(g.w * scale);
    canvas.height = Math.round(g.h * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(video, g.x, g.y, g.w, g.h, 0, 0, canvas.width, canvas.height);
    onCapture(canvas);
  }

  const box = size ? guide(size.w, size.h) : null;
  return (
    <div className="flex flex-col gap-4">
      <ScanStage chip={chip}>
        {/* Natural aspect ratio, so the overlay's percentages line up with video pixels. */}
        <div className="relative w-full overflow-hidden">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="block h-auto w-full"
            onLoadedMetadata={(e) => setSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
          />
          {box && size && (
            <div
              aria-hidden
              className="pointer-events-none absolute shadow-[0_0_0_9999px_rgba(17,17,18,0.45)]"
              style={{ left: `${(100 * box.x) / size.w}%`, top: `${(100 * box.y) / size.h}%`, width: `${(100 * box.w) / size.w}%`, height: `${(100 * box.h) / size.h}%` }}
            >
              <Brackets className="-inset-2" />
            </div>
          )}
        </div>
        {!size && (
          // Camera not streaming yet (starting, denied or missing): the Station · Empty stage.
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="relative flex aspect-[63/88] h-[62%] max-h-[29rem] flex-col items-center justify-center gap-2 px-4 text-center">
              <Brackets />
              <SmartphoneIcon aria-hidden className="mb-1 size-7 text-text-2" strokeWidth={1.5} />
              <p className="text-[16px] font-semibold text-text">{error ? "Camera unavailable" : "Hold one card inside the frame"}</p>
              <p className="text-[13px] text-text-2">{error ?? "Flat, face up, no sleeve glare"}</p>
            </div>
          </div>
        )}
      </ScanStage>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button onClick={capture} disabled={disabled || !!error || !size} variant="inverse" size="md" className="h-[46px] shrink-0 px-6">
          <CameraIcon />Capture
        </Button>
        {footer}
      </div>
    </div>
  );
}
