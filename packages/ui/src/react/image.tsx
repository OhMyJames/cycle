import { useState } from "react";
import { MAX_SHOWN_BASE64, viewOfImage } from "../attachments.ts";
import type { Block } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";
import { Lightbox, type LightboxImage } from "./lightbox.tsx";

/**
 * An image block of a conversation: what the agent sent, or what was sent to it. It is drawn only if `viewOfImage`
 * allows it (a known type, base64, a size the page can hold), from a data URL: nothing is fetched, so the page's CSP stands.
 * Click opens it large, over the whole window (lightbox.tsx); `set` is every image of the same message, this one among
 * them, so the others are a step away there. Otherwise a line says what it was.
 */
export function ImageBlockView({
  block,
  from,
  set,
}: {
  block: Block;
  from: "agent" | "user";
  set?: readonly Block[];
}) {
  const { t, number } = useI18n();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [images, setImages] = useState<LightboxImage[]>([]);
  const view = viewOfImage(block);
  if (!view.ok) {
    const megabytes = Math.round(
      ((typeof block.data === "string" ? block.data.length : MAX_SHOWN_BASE64) * 0.75) / 1048576,
    );
    return (
      <span data-slot="block-note">
        {view.reason === "too-large"
          ? t("image.tooLarge", {
              size: number(megabytes, {
                style: "unit",
                unit: "megabyte",
                maximumFractionDigits: 0,
              }),
            })
          : t("image.unsupported", { type: view.type })}
      </span>
    );
  }
  const alt = t(from === "agent" ? "image.alt.agent" : "image.alt.user");
  const name = view.name !== "" ? view.name : alt;
  // Gathered when it opens, not on every render: only what can be shown is stepped through, and this one is where it opens.
  const show = () => {
    const shown: { block: Block; image: LightboxImage }[] = [];
    for (const each of set ?? [block]) {
      const seen = each === block ? view : viewOfImage(each);
      if (seen.ok)
        shown.push({
          block: each,
          image: {
            src: seen.src,
            type: seen.type,
            data: typeof each.data === "string" ? each.data : "",
            name: seen.name,
            alt,
          },
        });
    }
    setImages(shown.map((each) => each.image));
    setIndex(
      Math.max(
        0,
        shown.findIndex((each) => each.block === block),
      ),
    );
    setOpen(true);
  };
  return (
    <>
      <button type="button" data-slot="image" aria-label={t("image.open", { name })} onClick={show}>
        <img src={view.src} alt={alt} />
      </button>
      <Lightbox
        images={images}
        index={index}
        onIndexChange={setIndex}
        open={open}
        onOpenChange={setOpen}
        from={from}
      />
    </>
  );
}
