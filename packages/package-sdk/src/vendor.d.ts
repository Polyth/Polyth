declare module "yazl" {
  export class ZipFile {
    addFile(path: string, data: Buffer | string): void;
    end(): void;
    outputStream: NodeJS.ReadableStream;
  }
}
