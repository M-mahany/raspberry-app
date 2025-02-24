declare module "mic" {
  import { Stream } from "stream";

  interface MicOptions {
    rate?: string;
    channels?: string;
    debug?: boolean;
    exitOnSilence?: number;
    fileType?: string;
    device?: string;
    endian?: "big" | "little";
    bitwidth?: string;
    encoding?: "signed-integer" | "unsigned-integer" | "floating-point";
    threshold?: number;
    thresholdStart?: number;
    thresholdEnd?: number;
    suppressInitialSilence?: boolean;
  }

  interface MicInputStream extends Stream {
    on(event: "data", listener: (data: Buffer) => void): this;
    on(event: "error", listener: (err: any) => void): this;
    on(event: "startComplete", listener: () => void): this;
    on(event: "stopComplete", listener: () => void): this;
    on(event: "pauseComplete", listener: () => void): this;
    on(event: "resumeComplete", listener: () => void): this;
    on(event: "silence", listener: () => void): this;
    on(event: "processExitComplete", listener: () => void): this;
  }

  interface MicInstance {
    start: () => void;
    stop: () => void;
    pause: () => void;
    resume: () => void;
    getAudioStream: () => MicInputStream;
  }

  export default function mic(options?: MicOptions): MicInstance;
}
