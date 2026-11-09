declare module "yauzl" {
  export interface Entry {
    fileName: string;
    generalPurposeBitFlag: number;
    compressedSize: number;
    uncompressedSize: number;
    versionMadeBy: number;
    externalFileAttributes: number;
    getLastModDate(): Date;
  }
  export interface ZipFile {
    on(event: "entry", handler: (entry: Entry) => void): void;
    on(event: "end", handler: () => void): void;
    on(event: "error", handler: (err: Error) => void): void;
    /** The archive comment; `git archive` stores the commit id there. */
    comment: string;
    readEntry(): void;
    close(): void;
    openReadStream(
      entry: Entry,
      callback: (err: Error | null, stream?: import("node:stream").Readable) => void,
    ): void;
  }
  export function open(
    path: string,
    options: { lazyEntries?: boolean; autoClose?: boolean; validateEntrySizes?: boolean },
    callback: (err: Error | null, zipfile?: ZipFile) => void,
  ): void;
  export function fromBuffer(
    buffer: Buffer,
    options: { lazyEntries?: boolean; validateEntrySizes?: boolean },
    callback: (err: Error | null, zipfile?: ZipFile) => void,
  ): void;
}
