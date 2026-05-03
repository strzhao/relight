import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface HeicDecoder {
  /** Whether heif-convert CLI is available on this system */
  available: boolean;
  /**
   * Convert a HEIC/HEIF file to JPEG.
   * @param input  Absolute path to the source HEIC/HEIF file (must exist and be a regular file)
   * @param output Absolute path for the output JPEG file
   * @throws If conversion fails, times out, or the input path is invalid
   */
  convertToJpeg(input: string, output: string): Promise<void>;
}

/**
 * Resolve and validate the input path.
 * Returns the real path (symlinks resolved) or throws.
 */
function validateInputPath(input: string): string {
  try {
    const real = fs.realpathSync(input);
    const stat = fs.statSync(real);
    if (!stat.isFile()) {
      throw new Error(`Input is not a regular file: ${input}`);
    }
    return real;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Input is not")) {
      throw err;
    }
    throw new Error(`Input file not found or not accessible: ${input}`);
  }
}

const TIMEOUT_MS = 30_000;

/**
 * Directories created for temporary HEIC conversion files.
 * Tracked so we can clean them up on process exit.
 */
const tempDirs = new Set<string>();

function registerExitCleanup(dir: string): void {
  if (tempDirs.size === 0) {
    process.on("exit", () => {
      for (const d of tempDirs) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch {
          // best-effort cleanup on exit
        }
      }
    });
  }
  tempDirs.add(dir);
}

/**
 * Create a unique temporary directory for this conversion batch.
 */
function createTempDir(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const dir = path.join(os.tmpdir(), `relight-heic-${ts}-${rand}`);
  fs.mkdirSync(dir, { recursive: true });
  registerExitCleanup(dir);
  return dir;
}

/**
 * Check if heif-convert CLI is available on this system.
 * Result is memoized — the check runs at most once per process lifetime.
 */
let _availabilityCheck: { checked: boolean; available: boolean } = {
  checked: false,
  available: false,
};

async function checkAvailability(): Promise<boolean> {
  if (_availabilityCheck.checked) return _availabilityCheck.available;

  return new Promise<boolean>((resolve) => {
    execFile("heif-convert", ["--version"], { timeout: 5_000 }, (err) => {
      _availabilityCheck = { checked: true, available: !err };
      resolve(_availabilityCheck.available);
    });
  });
}

/**
 * Create a HeicDecoder backed by the heif-convert CLI.
 * The `available` property reflects runtime detection (memoized).
 */
export function createHeicDecoder(): HeicDecoder {
  return {
    get available() {
      // Synchronous approximation — once check completes, returns memoized result.
      // For accurate detection, callers should await ensureAvailability() first.
      return _availabilityCheck.available;
    },
    async convertToJpeg(input: string, output: string): Promise<void> {
      // 1. Path validation
      const realInput = validateInputPath(input);

      // 2. Ensure CLI is available
      const avail = await checkAvailability();
      if (!avail) {
        throw new Error("heif-convert CLI is not available on this system");
      }

      // 3. Create temp dir and intermediate file (must have .jpg extension for heif-convert)
      const tempDir = createTempDir();
      const intermediate = path.join(tempDir, `heic-intermediate-${Date.now()}.jpg`);

      try {
        // 4. Convert HEIC → JPEG via CLI (uses AbortController for timeout)
        await convertWithTimeout(realInput, intermediate);

        // 5. Move intermediate to the requested output path
        await fsp.rename(intermediate, output);
      } finally {
        // Clean up temp directory
        tempDirs.delete(tempDir);
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    },
  };
}

/**
 * Execute heif-convert with a 30s timeout.
 */
function convertWithTimeout(input: string, output: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`heif-convert timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    // -q 85: quality 85 for JPEG output
    // Output path must include a recognized extension (.jpg, .png, etc.)
    execFile(
      "heif-convert",
      ["-q", "85", input, output],
      {
        signal: controller.signal,
        timeout: TIMEOUT_MS,
      },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        if (err) {
          const msg = stderr?.trim() || err.message;
          reject(new Error(`heif-convert failed: ${msg}`));
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * Convenience: check availability explicitly (useful for callers that need to
 * know before attempting conversion).
 */
export async function ensureHeicDecoderAvailable(): Promise<boolean> {
  return checkAvailability();
}

/**
 * Reset the memoized availability check. For testing only.
 * Allows tests to simulate different CLI availability states without process restart.
 */
export function __resetAvailabilityCheck(): void {
  _availabilityCheck = { checked: false, available: false };
}
