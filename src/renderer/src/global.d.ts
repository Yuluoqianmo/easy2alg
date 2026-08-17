import type { Easy2AlgApi } from "../../shared/ipc";

declare global {
  interface Window {
    readonly easy2alg?: Easy2AlgApi;
  }
}

export {};
