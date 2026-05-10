/// <reference types="vitest/globals" />

// Module augmentation — adds runAllMicrotasksAsync to VitestUtils
// (the method exists in Vitest's fake-timer runtime but is missing from 3.x type defs)
import "vitest";

declare module "vitest" {
  interface VitestUtils {
    runAllMicrotasksAsync(): Promise<void>;
  }
}
