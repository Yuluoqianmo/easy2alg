import type { EasyEda2AllegroApi } from "../../shared/ipc";

declare global {
  interface Window {
    readonly easyeda2allegro?: EasyEda2AllegroApi;
  }
}

export {};
