import 'pinia';

declare module 'pinia' {
  export interface DefineStoreOptionsBase<S, Store> {
    // Keep this loose: the runtime plugin already validates options.
    persist?: boolean | Record<string, unknown> | Array<Record<string, unknown>>;
  }

  export interface PiniaCustomProperties {
    $hydrate: (opts?: { runHooks?: boolean }) => void;
    $persist: () => void;
  }
}

export {};
