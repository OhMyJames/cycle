// Runs in the browser before each test file, with the stylesheet the app ships. Motion's animations are skipped: a test
// waits for what the person would end up seeing, not for a transition to finish.
import { MotionGlobalConfig } from "motion/react";
import { beforeEach } from "vitest";
import { clearReadings } from "../../src/react/conversation.tsx";
// The app's stylesheet, as the window has it: layout, visibility and sizes are the real ones.
import "../../src/styles/built.css";

MotionGlobalConfig.skipAnimations = true;

// Every test starts from empty storage and scroll memory. The two files that run at once share one origin, and tests
// within a file reuse the same session key ("local:s1"), so remembered scroll offsets would otherwise leak across tests.
beforeEach(() => {
  localStorage.clear();
  clearReadings();
});
