// The alerts the app shows. The SDK's toast region keeps its own assertive live region in <body> (role "alert", empty, a
// pixel wide) for screen readers, so `screen.getByRole("alert")` finds two once the app is mounted. A test means the
// app's alert, not that one.
import { screen, waitFor } from "@testing-library/react";

const announcer = "[data-ui-sdk-announcer]";
const own = () => screen.queryAllByRole("alert").filter((el) => !el.matches(announcer));

/** The app's one alert, or null when there is none. Throws when there are several. */
export function queryAlert(): HTMLElement | null {
  const found = own();
  if (found.length > 1) throw new Error(`Found ${found.length} alerts, expected at most one`);
  return found[0] ?? null;
}

/** The app's one alert; throws when there is none or several. */
export function getAlert(): HTMLElement {
  const found = queryAlert();
  if (!found)
    throw new Error('Unable to find an element with the role "alert" besides the SDK announcer');
  return found;
}

/** Waits for the app's one alert. */
export function findAlert(): Promise<HTMLElement> {
  return waitFor(getAlert);
}
