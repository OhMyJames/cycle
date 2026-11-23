// A picture of the conversation opened large (CYCL-212): over the whole window, closed by Esc, the scrim or Close with the
// focus back on the thumbnail, zoomed by the buttons, the keys and the wheel, and copied or saved through main.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { Block } from "../../src/model/index.ts";
import { ImageBlockView } from "../../src/react/image.tsx";
import { StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge } from "../fake-bridge.ts";

afterEach(cleanup);

/** A picture of a given size, drawn here: its base64. */
const picture = (w: number, h: number, type = "image/png"): string => {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no canvas");
  context.fillStyle = "#3a6";
  context.fillRect(0, 0, w, h);
  return canvas.toDataURL(type).split(",")[1] ?? "";
};

const block = (data: string, mimeType = "image/png", uri?: string): Block =>
  ({ type: "image", data, mimeType, ...(uri !== undefined ? { uri } : {}) }) as Block;

const show = (blocks: Block[], from: "agent" | "user" = "user") => {
  const script = fakeBridge({ connected: true });
  const store = new AppStore(script.bridge);
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <button type="button">before</button>
      {/* The blocks of a sent message never change: their place is who they are (as conversation.tsx keys them). */}
      {blocks
        .map((b, i) => ({ b, id: `image-${String(i)}` }))
        .map(({ b, id }) => (
          <ImageBlockView key={id} block={b} from={from} set={blocks} />
        ))}
    </StoreProvider>,
  );
  const thumbnails = () => screen.getAllByRole("button", { name: /Open image/ });
  const tracked = () =>
    script.calls.filter(([name]) => name === "track").map(([, event, props]) => [event, props]);
  return { script, user, thumbnails, tracked };
};

const opened = async (name: RegExp | string = /./) => screen.findByRole("dialog", { name });
const image = (dialog: HTMLElement) => {
  const img = dialog.querySelector<HTMLImageElement>('[data-slot="lightbox-image"]');
  if (img === null) throw new Error("no picture");
  return img;
};
const percent = (dialog: HTMLElement) =>
  dialog.querySelector('[data-slot="lightbox-percent"]')?.textContent ?? "";
const settled = (dialog: HTMLElement) =>
  waitFor(() => expect(image(dialog).hasAttribute("data-shown")).toBe(true));

test("a thumbnail opens the picture over the whole window, at its own size, with Copy, Download and Close; Close puts the focus back", async () => {
  const { user, thumbnails } = show([
    block(picture(480, 270), "image/png", "attachment:///shot.png"),
  ]);
  const thumbnail = thumbnails()[0] as HTMLElement;
  await user.click(thumbnail);
  const dialog = await opened("shot.png");
  await settled(dialog);
  // The whole window, and no surface of its own: the picture sits on the scrim.
  const box = dialog.getBoundingClientRect();
  expect(box.width).toBe(window.innerWidth);
  expect(box.height).toBe(window.innerHeight);
  expect(getComputedStyle(dialog).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  // Small: never made larger than it is.
  expect(percent(dialog)).toBe("100%");
  // Once it has grown into place (the frame scales in as it appears).
  await waitFor(() => {
    const shown = image(dialog).getBoundingClientRect();
    expect(shown.width).toBeCloseTo(480, 0);
    expect(shown.height).toBeCloseTo(270, 0);
  });
  // The controls: top right, and the zoom at the bottom middle.
  const close = within(dialog).getByRole("button", { name: "Close" });
  const copy = within(dialog).getByRole("button", { name: "Copy image" });
  within(dialog).getByRole("button", { name: "Download image" });
  expect(close.getBoundingClientRect().right).toBeGreaterThan(window.innerWidth - 20);
  expect(close.getBoundingClientRect().top).toBeLessThan(20);
  expect(copy.getBoundingClientRect().left).toBeLessThan(close.getBoundingClientRect().left);
  const zoom = within(dialog).getByRole("group", { name: "Zoom" }).getBoundingClientRect();
  expect(Math.abs(zoom.left + zoom.width / 2 - window.innerWidth / 2)).toBeLessThan(1);
  expect(zoom.bottom).toBeGreaterThan(window.innerHeight - 30);
  // No bottom Close of the old dialog.
  expect(within(dialog).getAllByRole("button", { name: "Close" })).toHaveLength(1);
  await user.click(close);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(thumbnail);
});

test("Esc closes it, and the focus goes back to the thumbnail", async () => {
  const { user, thumbnails } = show([block(picture(200, 100))]);
  const thumbnail = thumbnails()[0] as HTMLElement;
  await user.click(thumbnail);
  await opened("Image you sent");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(thumbnail);
});

test("a press on the scrim closes it; a press on the picture does not", async () => {
  const { user, thumbnails } = show([block(picture(200, 100))]);
  const thumbnail = thumbnails()[0] as HTMLElement;
  await user.click(thumbnail);
  const dialog = await opened();
  await settled(dialog);
  await user.click(image(dialog));
  expect(screen.getByRole("dialog")).toBeTruthy();
  // Well away from the picture and the controls.
  const frame = dialog.querySelector<HTMLElement>('[data-slot="lightbox-frame"]');
  if (frame === null) throw new Error("no frame");
  await user.click(frame, { position: { x: 10, y: 10 } });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(thumbnail);
});

test("the buttons, + − 0 and ctrl with the wheel zoom it, between 10% and 800%", async () => {
  const { user, thumbnails } = show([block(picture(400, 300))]);
  await user.click(thumbnails()[0] as HTMLElement);
  const dialog = await opened();
  await settled(dialog);
  const zoomIn = within(dialog).getByRole("button", { name: "Zoom in" });
  const zoomOut = within(dialog).getByRole("button", { name: "Zoom out" });
  await user.click(zoomIn);
  expect(percent(dialog)).toBe("125%");
  await waitFor(() => expect(image(dialog).getBoundingClientRect().width).toBeCloseTo(500, 0));
  await user.click(zoomOut);
  expect(percent(dialog)).toBe("100%");
  await user.keyboard("+");
  expect(percent(dialog)).toBe("125%");
  await user.keyboard("=");
  expect(percent(dialog)).toBe("156%");
  await user.keyboard("0");
  expect(percent(dialog)).toBe("100%");
  await user.keyboard("-");
  expect(percent(dialog)).toBe("80%");
  // Ctrl or cmd with the wheel, and a pinch (a wheel with ctrl): in toward the pointer, and the page does not scroll.
  const wheel = new WheelEvent("wheel", {
    deltaY: -100,
    ctrlKey: true,
    clientX: 600,
    clientY: 400,
    bubbles: true,
    cancelable: true,
  });
  image(dialog).dispatchEvent(wheel);
  expect(wheel.defaultPrevented).toBe(true);
  await waitFor(() => expect(percent(dialog)).toBe("113%"));
  // Down to 10%, no further, and − is then off.
  for (let i = 0; i < 20; i++) await user.keyboard("-");
  expect(percent(dialog)).toBe("10%");
  expect(zoomOut.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(zoomOut);
  for (let i = 0; i < 20; i++) await user.keyboard("+");
  expect(percent(dialog)).toBe("800%");
  expect(zoomIn.getAttribute("aria-disabled")).toBe("true");
});

test("a large picture fits the window, a tall one its height; zoomed, it is dragged and scrolled to see the rest", async () => {
  const { user, thumbnails } = show([block(picture(3000, 2000)), block(picture(400, 4000))]);
  await user.click(thumbnails()[0] as HTMLElement);
  const dialog = await opened(/1 of 2/);
  await settled(dialog);
  await waitFor(() => expect(image(dialog).getBoundingClientRect().left).toBeGreaterThanOrEqual(0));
  const fitted = Number.parseInt(percent(dialog), 10);
  expect(fitted).toBeLessThan(100);
  const large = image(dialog).getBoundingClientRect();
  expect(large.left).toBeGreaterThanOrEqual(0);
  expect(large.right).toBeLessThanOrEqual(window.innerWidth);
  expect(large.top).toBeGreaterThan(40);
  expect(large.bottom).toBeLessThan(window.innerHeight - 50);
  // The tall one: its height is what fits.
  await user.keyboard("{ArrowRight}");
  await opened(/2 of 2/);
  await waitFor(() => expect(percent(dialog)).not.toBe(`${String(fitted)}%`));
  await settled(dialog);
  const tall = image(dialog).getBoundingClientRect();
  expect(tall.top).toBeGreaterThan(40);
  expect(tall.bottom).toBeLessThan(window.innerHeight - 50);
  expect(tall.height).toBeGreaterThan(window.innerHeight - 160);
  // At its own size it is taller than the window: a scroll moves it, and so does a drag.
  await user.keyboard("0");
  for (let i = 0; i < 10; i++) await user.keyboard("+");
  await waitFor(() => expect(image(dialog).hasAttribute("data-pannable")).toBe(true));
  const before = image(dialog).getBoundingClientRect().top;
  image(dialog).dispatchEvent(
    new WheelEvent("wheel", { deltaY: 200, bubbles: true, cancelable: true }),
  );
  await waitFor(() =>
    expect(image(dialog).getBoundingClientRect().top).toBeCloseTo(before - 200, 0),
  );
  const img = image(dialog);
  const at = { clientX: 600, clientY: 400, pointerId: 7, button: 0, bubbles: true };
  img.dispatchEvent(new PointerEvent("pointerdown", at));
  img.dispatchEvent(new PointerEvent("pointermove", { ...at, clientY: 500 }));
  img.dispatchEvent(new PointerEvent("pointerup", { ...at, clientY: 500 }));
  await waitFor(() =>
    expect(image(dialog).getBoundingClientRect().top).toBeCloseTo(before - 100, 0),
  );
  // The click that ends a drag is not a press on the scrim.
  img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("the pictures of one message are stepped through with ← →, and the buttons at the sides", async () => {
  const { user, thumbnails } = show([
    block(picture(100, 100), "image/png", "attachment:///a.png"),
    block(picture(100, 100), "image/png", "attachment:///b.png"),
    block(picture(100, 100), "image/png", "attachment:///c.png"),
  ]);
  await user.click(thumbnails()[1] as HTMLElement);
  const dialog = await opened("b.png, 2 of 3");
  await user.keyboard("{ArrowRight}");
  await opened("c.png, 3 of 3");
  await user.click(within(dialog).getByRole("button", { name: "Next image" }));
  await opened("a.png, 1 of 3");
  await user.click(within(dialog).getByRole("button", { name: "Previous image" }));
  await opened("c.png, 3 of 3");
  await user.keyboard("{ArrowLeft}");
  await opened("b.png, 2 of 3");
});

test("one picture has no steps", async () => {
  const { user, thumbnails } = show([block(picture(100, 100))]);
  await user.click(thumbnails()[0] as HTMLElement);
  const dialog = await opened();
  expect(within(dialog).queryByRole("button", { name: "Next image" })).toBeNull();
});

test("Copy puts the picture on the clipboard through main, and only that it was copied is counted", async () => {
  const data = picture(120, 80);
  const { script, user, thumbnails, tracked } = show([block(data)], "agent");
  await user.click(thumbnails()[0] as HTMLElement);
  const dialog = await opened();
  await settled(dialog);
  await user.click(within(dialog).getByRole("button", { name: "Copy image" }));
  await waitFor(() =>
    expect(script.named("copyImage")).toEqual([["copyImage", "image/png", data]]),
  );
  await within(dialog).findByRole("button", { name: "Copied" });
  expect(within(dialog).getByRole("status").textContent).toBe("Copied");
  expect(tracked()).toEqual([["image_copied", { from: "agent" }]]);
  expect(JSON.stringify(tracked())).not.toContain(data.slice(0, 40));
});

test("a WebP is copied as a PNG, which is what the clipboard takes", async () => {
  const { script, user, thumbnails } = show([block(picture(64, 48, "image/webp"), "image/webp")]);
  await user.click(thumbnails()[0] as HTMLElement);
  const dialog = await opened();
  await settled(dialog);
  await user.click(within(dialog).getByRole("button", { name: "Copy image" }));
  await waitFor(() => expect(script.named("copyImage")).toHaveLength(1));
  const [, type, png] = script.named("copyImage")[0] ?? [];
  expect(type).toBe("image/png");
  expect(String(png).startsWith("iVBORw0KGgo")).toBe(true);
});

test("a copy that fails says so on the button, and is not counted", async () => {
  const { script, user, thumbnails, tracked } = show([block(picture(120, 80))]);
  script.bridge.copyImage = async () => false;
  await user.click(thumbnails()[0] as HTMLElement);
  const dialog = await opened();
  await settled(dialog);
  await user.click(within(dialog).getByRole("button", { name: "Copy image" }));
  await within(dialog).findByRole("button", { name: "Could not copy the image" });
  expect(tracked()).toEqual([]);
});

test("Download saves it through main's save dialog under its name; a cancelled one says and counts nothing", async () => {
  const data = picture(120, 80, "image/jpeg");
  const { script, user, thumbnails, tracked } = show([
    block(data, "image/jpeg", "attachment:///holiday.jpg"),
  ]);
  await user.click(thumbnails()[0] as HTMLElement);
  const dialog = await opened("holiday.jpg");
  await user.click(within(dialog).getByRole("button", { name: "Download image" }));
  await waitFor(() =>
    expect(script.named("saveImage")).toEqual([["saveImage", "holiday.jpg", "image/jpeg", data]]),
  );
  await within(dialog).findByRole("button", { name: "Saved" });
  expect(tracked()).toEqual([["image_downloaded", { from: "user" }]]);
  expect(JSON.stringify(tracked())).not.toContain("holiday");

  const calls: unknown[] = [];
  script.bridge.saveImage = async (...args) => {
    calls.push(args);
    return "cancelled";
  };
  await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Saved" })).toBeNull(), {
    timeout: 3000,
  });
  await user.click(within(dialog).getByRole("button", { name: "Download image" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(within(dialog).getByRole("button", { name: "Download image" })).toBeTruthy();
  expect(tracked()).toHaveLength(1);
});
