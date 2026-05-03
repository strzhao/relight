declare module "heic-decode" {
  interface DecodeOptions {
    buffer: Buffer;
  }

  interface DecodeResult {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }

  function decode(options: DecodeOptions): Promise<DecodeResult>;

  namespace decode {
    function all(options: DecodeOptions): Promise<
      Array<{
        width: number;
        height: number;
        decode: () => Promise<DecodeResult>;
      }> & { dispose: () => void }
    >;
  }

  export = decode;
}
