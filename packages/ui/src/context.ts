import { createContext, useContext } from "react";
import type { CycleApp } from "./client/app.ts";

export const AppContext = createContext<CycleApp | null>(null);

export function useApp(): CycleApp {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp needs an AppContext");
  return app;
}
