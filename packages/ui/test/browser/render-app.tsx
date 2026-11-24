import { act, render } from "@testing-library/react";
import type { CycleBridge } from "../../src/api.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";

/** The whole app on `bridge`, started as the window starts it: its store, for what a test reads or does through it. */
export const renderApp = async (bridge: CycleBridge): Promise<AppStore> => {
  const store = new AppStore(bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  return store;
};
