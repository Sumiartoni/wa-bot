declare module "qrcode/lib/browser" {
  export function toString(text: string, options: { margin?: number; width?: number; type: "svg" }): Promise<string>;
}
