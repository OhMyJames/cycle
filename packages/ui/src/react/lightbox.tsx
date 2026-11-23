import { isComposing } from "@ui-sdk/core";
import { Dialog, DialogBackdrop, DialogContent, DialogTitle } from "@ui-sdk/react/dialog";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ImageType } from "../attachments.ts";
import { useI18n } from "./i18n.tsx";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  MinusIcon,
  PlusIcon,
} from "./icons.tsx";
import { useOptionalAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/** A picture the lightbox shows: drawn from its data URL, and its base64 is what is copied or saved. */
export type LightboxImage = {
  src: string;
  type: ImageType;
  /** Base64, as the block carries it. */
  data: string;
  /** The file's own name, or "" when the sender gave none. */
  name: string;
  alt: string;
};

type Size = { w: number; h: number };
type Point = { x: number; y: number };

/** How far a picture may be made smaller and larger than its own size. */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
/** One press of − or +. */
const ZOOM_STEP = 1.25;
/** How long a check, or the word for what went wrong, stays on Copy and Download after a press. */
const SAID_MS = 1500;

export const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/** The scale that shows the whole picture in the room it has, never above its own size: a small picture stays small. */
export const fitScale = (natural: Size, room: Size): number =>
  natural.w <= 0 || natural.h <= 0 || room.w <= 0 || room.h <= 0
    ? 1
    : clampZoom(Math.min(1, room.w / natural.w, room.h / natural.h));

/** A shift of the picture kept so that an edge never comes in past the room's edge, and none when it fits. */
const clampPan = (pan: Point, natural: Size, scale: number, room: Size): Point => {
  const maxX = Math.max(0, (natural.w * scale - room.w) / 2);
  const maxY = Math.max(0, (natural.h * scale - room.h) / 2);
  return { x: Math.min(maxX, Math.max(-maxX, pan.x)), y: Math.min(maxY, Math.max(-maxY, pan.y)) };
};

/**
 * A picture of the conversation, opened over the whole window (CYCL-212): a dark scrim in either theme, as a lightbox is,
 * the picture at the size the window allows, never above its own, and nothing framing it. Copy, Download and Close sit at
 * the top right (the traffic lights are top left on a Mac), − / the percentage / + at the bottom. It zooms by the buttons,
 * + − and 0, ctrl or cmd and the wheel, and a pinch; a zoomed picture is dragged or scrolled to see the rest. Esc, the
 * scrim or Close closes it, and the focus goes back to the thumbnail. Pictures of one message are stepped through with ←
 * and → or the buttons at the sides.
 */
export function Lightbox({
  images,
  index,
  onIndexChange,
  open,
  onOpenChange,
  from,
}: {
  images: LightboxImage[];
  index: number;
  onIndexChange: (index: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Who sent it, for what analytics counts: never the picture. */
  from: "agent" | "user";
}) {
  const { t, number } = useI18n();
  const store = useOptionalAppStore();
  const image = images[index];
  const many = images.length > 1;

  const [natural, setNatural] = useState<Size | undefined>(undefined);
  const [room, setRoom] = useState<Size>({ w: 0, h: 0 });
  /** Undefined: fit to the room. */
  const [zoom, setZoom] = useState<number | undefined>(undefined);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [said, setSaid] = useState<{ what: "copy" | "download"; ok: boolean } | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const frame = useRef<HTMLDivElement | null>(null);
  const picture = useRef<HTMLImageElement | null>(null);
  const drag = useRef<{ id: number; start: Point; pan: Point; moved: boolean } | undefined>(
    undefined,
  );
  /** A drag just ended: the click that follows it is not a press on the scrim. */
  const dragged = useRef(false);

  // Each picture opens fitted, in the middle: what was set for the one before is let go as soon as another is shown.
  const showing = open ? index : -1;
  const [seen, setSeen] = useState(showing);
  if (seen !== showing) {
    setSeen(showing);
    setNatural(undefined);
    setZoom(undefined);
    setPan({ x: 0, y: 0 });
    setSaid(undefined);
  }

  // The room the picture has: the space between the controls, as the window is now.
  const watching = useRef<ResizeObserver | undefined>(undefined);
  const measure = useCallback((element: HTMLDivElement | null) => {
    watching.current?.disconnect();
    watching.current = undefined;
    frame.current = element;
    if (element === null) return;
    const read = () =>
      setRoom((was) =>
        was.w === element.clientWidth && was.h === element.clientHeight
          ? was
          : { w: element.clientWidth, h: element.clientHeight },
      );
    read();
    watching.current = new ResizeObserver(read);
    watching.current.observe(element);
  }, []);

  const fit = natural === undefined ? 1 : fitScale(natural, room);
  const scale = zoom ?? fit;

  /** Zooms to `next`, keeping the point `at` (from the room's middle) where it is on the screen. */
  const zoomTo = useCallback(
    (next: number, at: Point = { x: 0, y: 0 }) => {
      if (natural === undefined) return;
      const to = clampZoom(next);
      const ratio = to / scale;
      setZoom(to);
      setPan((was) =>
        clampPan(
          { x: at.x - (at.x - was.x) * ratio, y: at.y - (at.y - was.y) * ratio },
          natural,
          to,
          room,
        ),
      );
    },
    [natural, room, scale],
  );
  const reset = () => {
    setZoom(undefined);
    setPan({ x: 0, y: 0 });
  };
  const pannable =
    natural !== undefined && (natural.w * scale > room.w + 0.5 || natural.h * scale > room.h + 0.5);

  // The wheel: with ctrl or cmd, or a pinch (which comes as a wheel with ctrl), it zooms at the pointer; without, it moves a
  // zoomed picture. Not React's listener: that one is passive, and the page behind must not scroll or zoom.
  const now = useRef({ natural, scale, room, pannable, zoomTo });
  now.current = { natural, scale, room, pannable, zoomTo };
  const unwheel = useRef<(() => void) | undefined>(undefined);
  const content = useCallback((element: HTMLDivElement | null) => {
    unwheel.current?.();
    unwheel.current = undefined;
    if (element === null) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const { natural, scale, room, pannable, zoomTo } = now.current;
      const box = frame.current?.getBoundingClientRect();
      if (box === undefined || natural === undefined) return;
      if (event.ctrlKey || event.metaKey) {
        const delta = Math.max(-50, Math.min(50, event.deltaY));
        zoomTo(scale * 2 ** (-delta / 100), {
          x: event.clientX - (box.left + box.width / 2),
          y: event.clientY - (box.top + box.height / 2),
        });
      } else if (pannable) {
        setPan((was) =>
          clampPan({ x: was.x - event.deltaX, y: was.y - event.deltaY }, natural, scale, room),
        );
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    unwheel.current = () => element.removeEventListener("wheel", wheel);
  }, []);

  const step = (by: number) => {
    if (!many) return;
    onIndexChange((index + by + images.length) % images.length);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (isComposing(event.nativeEvent) || event.altKey) return;
    const key = event.key;
    if (key === "+" || key === "=") zoomTo(scale * ZOOM_STEP);
    else if (key === "-" || key === "_") zoomTo(scale / ZOOM_STEP);
    else if (key === "0") reset();
    else if (key === "ArrowLeft" && many) step(-1);
    else if (key === "ArrowRight" && many) step(1);
    else return;
    event.preventDefault();
  };

  const onPointerDown = (event: PointerEvent<HTMLImageElement>) => {
    if (!pannable || event.button !== 0) return;
    event.preventDefault();
    // Held while it leaves the picture. A pointer the browser has no record of cannot be held: the drag still works over it.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    drag.current = {
      id: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      pan,
      moved: false,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLImageElement>) => {
    const held = drag.current;
    if (held === undefined || held.id !== event.pointerId || natural === undefined) return;
    const dx = event.clientX - held.start.x;
    const dy = event.clientY - held.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) held.moved = true;
    setPan(clampPan({ x: held.pan.x + dx, y: held.pan.y + dy }, natural, scale, room));
  };
  const onPointerUp = (event: PointerEvent<HTMLImageElement>) => {
    const held = drag.current;
    if (held === undefined || held.id !== event.pointerId) return;
    drag.current = undefined;
    dragged.current = held.moved;
  };

  const tell = (what: "copy" | "download", ok: boolean) => {
    setSaid({ what, ok });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(undefined), SAID_MS);
  };
  const copy = async () => {
    if (store === undefined || image === undefined) return;
    const png = image.type === "image/png" || image.type === "image/jpeg";
    const data = png ? image.data : pngOf(picture.current);
    const done =
      data !== undefined &&
      (await store.copyImage(png ? image.type : "image/png", data).catch(() => false));
    tell("copy", done);
    if (done) store.track("image_copied", { from });
  };
  const download = async () => {
    if (store === undefined || image === undefined) return;
    const saved = await store.saveImage(image.name, image.type, image.data);
    if (saved === "cancelled") return;
    tell("download", saved === "saved");
    if (saved === "saved") store.track("image_downloaded", { from });
  };

  if (image === undefined) return null;
  const name = image.name !== "" ? image.name : image.alt;
  const copyLabel =
    said?.what === "copy" ? t(said.ok ? "image.copied" : "image.copyFailed") : t("image.copy");
  const downloadLabel =
    said?.what === "download"
      ? t(said.ok ? "image.downloaded" : "image.downloadFailed")
      : t("image.download");
  const shown = natural !== undefined && room.w > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop data-palette="lightbox" />
      <DialogContent
        ref={content}
        data-palette="lightbox"
        initialFocus="content"
        onKeyDown={onKeyDown}
        onClick={(event) => {
          // A press on the scrim (anything but the picture and the controls) closes, unless it ended a drag.
          const target = event.target as HTMLElement;
          const was = dragged.current;
          dragged.current = false;
          if (was || target.closest("img, button") !== null) return;
          onOpenChange(false);
        }}
      >
        {/* Said, not shown: the picture is its own title. */}
        <DialogTitle>
          {many
            ? t("image.viewer.many", { name, index: index + 1, total: images.length })
            : t("image.viewer.one", { name })}
        </DialogTitle>
        <div data-slot="lightbox-frame" ref={measure}>
          <img
            // A picture of its own each time, so that it says when it has loaded even when two are the same.
            key={index}
            ref={(element) => {
              picture.current = element;
              if (element?.complete && element.naturalWidth > 0 && natural === undefined)
                setNatural({ w: element.naturalWidth, h: element.naturalHeight });
            }}
            src={image.src}
            alt={image.alt}
            draggable={false}
            data-slot="lightbox-image"
            data-shown={shown ? "" : undefined}
            data-pannable={pannable ? "" : undefined}
            onLoad={(event) => {
              const element = event.currentTarget;
              setNatural({ w: element.naturalWidth, h: element.naturalHeight });
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            // Its size and place change with every zoom and drag: numbers, not a style that could be named.
            style={
              shown
                ? {
                    width: natural.w * scale,
                    height: natural.h * scale,
                    transform: `translate(${pan.x}px, ${pan.y}px)`,
                  }
                : undefined
            }
          />
        </div>
        <div data-slot="lightbox-actions">
          {store !== undefined ? (
            <>
              <Tip label={copyLabel} side="bottom">
                <button
                  type="button"
                  data-slot="lightbox-button"
                  data-said={said?.what === "copy" ? (said.ok ? "done" : "failed") : undefined}
                  onClick={() => void copy()}
                >
                  {said?.what === "copy" && said.ok ? <CheckIcon /> : <CopyIcon />}
                </button>
              </Tip>
              <Tip label={downloadLabel} side="bottom">
                <button
                  type="button"
                  data-slot="lightbox-button"
                  data-said={said?.what === "download" ? (said.ok ? "done" : "failed") : undefined}
                  onClick={() => void download()}
                >
                  {said?.what === "download" && said.ok ? <CheckIcon /> : <DownloadIcon />}
                </button>
              </Tip>
            </>
          ) : null}
          <Tip label={t("image.close")} side="bottom">
            <button type="button" data-slot="lightbox-button" onClick={() => onOpenChange(false)}>
              <CloseIcon />
            </button>
          </Tip>
        </div>
        {many ? (
          <>
            <Tip label={t("image.previous")} side="right">
              <button
                type="button"
                data-slot="lightbox-button"
                data-side="previous"
                onClick={() => step(-1)}
              >
                <ChevronLeftIcon />
              </button>
            </Tip>
            <Tip label={t("image.next")} side="left">
              <button
                type="button"
                data-slot="lightbox-button"
                data-side="next"
                onClick={() => step(1)}
              >
                <ChevronRightIcon />
              </button>
            </Tip>
          </>
        ) : null}
        {/* At an end a button is aria-disabled, not disabled: a disabled one would drop the focus, and the keys with it. */}
        <fieldset data-slot="lightbox-zoom" aria-label={t("image.zoom")}>
          <Tip label={t("image.zoomOut")}>
            <button
              type="button"
              data-slot="lightbox-zoom-button"
              aria-disabled={scale <= ZOOM_MIN + 1e-6}
              onClick={() => zoomTo(scale / ZOOM_STEP)}
            >
              <MinusIcon />
            </button>
          </Tip>
          <span data-slot="lightbox-percent">
            {number(scale, { style: "percent", maximumFractionDigits: 0 })}
          </span>
          <Tip label={t("image.zoomIn")}>
            <button
              type="button"
              data-slot="lightbox-zoom-button"
              aria-disabled={scale >= ZOOM_MAX - 1e-6}
              onClick={() => zoomTo(scale * ZOOM_STEP)}
            >
              <PlusIcon />
            </button>
          </Tip>
        </fieldset>
        {/* What Copy and Download came to, said once to a screen reader as well as on the button. */}
        <span data-slot="visually-hidden" role="status">
          {said === undefined ? "" : said.what === "copy" ? copyLabel : downloadLabel}
        </span>
      </DialogContent>
    </Dialog>
  );
}

/** A picture the clipboard does not take as it is (a GIF, a WebP) drawn again as a PNG: its first frame. */
const pngOf = (element: HTMLImageElement | null): string | undefined => {
  if (element === null || element.naturalWidth === 0) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = element.naturalWidth;
  canvas.height = element.naturalHeight;
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  context.drawImage(element, 0, 0);
  return canvas.toDataURL("image/png").split(",")[1];
};
