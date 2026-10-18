import assert from "node:assert/strict";
import test from "node:test";
import { humanClickBox, humanMoveTo } from "../src/core/browser.ts";
import { detectCaptchaState, handleCaptchaIfPresent } from "../src/core/captcha.ts";
import type { Page } from "playwright-core";

test("humanMoveTo and humanClickBox generate smooth curved trajectory and mouse press", async () => {
  const moves: Array<{ x: number; y: number }> = [];
  let downCount = 0;
  let upCount = 0;

  const fakePage = {
    mouse: {
      move: async (x: number, y: number) => {
        moves.push({ x, y });
      },
      down: async () => {
        downCount++;
      },
      up: async () => {
        upCount++;
      },
    },
  } as unknown as Page;

  await humanMoveTo(fakePage, 400, 300);
  assert.ok(moves.length >= 8, "Expected at least 8 trajectory steps");
  const last = moves[moves.length - 1]!;
  assert.ok(Math.abs(last.x - 400) < 0.01 && Math.abs(last.y - 300) < 0.01);

  await humanClickBox(fakePage, { x: 100, y: 100, width: 80, height: 40 });
  assert.equal(downCount, 1);
  assert.equal(upCount, 1);
  const clickPos = moves[moves.length - 1]!;
  assert.ok(clickPos.x >= 124 && clickPos.x <= 156, `Off-center X out of range: ${clickPos.x}`);
  assert.ok(clickPos.y >= 112 && clickPos.y <= 128, `Off-center Y out of range: ${clickPos.y}`);
});

test("handleCaptchaIfPresent clicks Turnstile checkbox and resolves when solved", async () => {
  let turnstileSolved = false;
  let checkboxClicked = false;

  const fakePage = {
    evaluate: async () => {
      if (turnstileSolved) {
        return { present: false, kind: "turnstile", solved: true };
      }
      return { present: true, kind: "turnstile", solved: false };
    },
    locator: () => ({
      first: () => ({
        isVisible: async () => true,
        boundingBox: async () => ({ x: 200, y: 200, width: 300, height: 65 }),
      }),
    }),
    frames: () => [],
    bringToFront: async () => {},
    mouse: {
      move: async () => {},
      down: async () => {
        checkboxClicked = true;
        turnstileSolved = true;
      },
      up: async () => {},
    },
  } as unknown as Page;

  const initial = await detectCaptchaState(fakePage);
  assert.equal(initial.present, true);
  assert.equal(initial.kind, "turnstile");

  const handled = await handleCaptchaIfPresent(fakePage, undefined, { timeoutMs: 10_000 });
  assert.equal(handled, true);
  assert.equal(checkboxClicked, true);
});
