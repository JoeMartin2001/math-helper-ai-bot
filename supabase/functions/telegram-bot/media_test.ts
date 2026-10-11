import { assertEquals } from "@std/assert";
import { encodeBase64, sniffImageType } from "./media.ts";

Deno.test("detects image formats from magic bytes, not names", () => {
  assertEquals(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assertEquals(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), "image/png");
  assertEquals(sniffImageType(new TextEncoder().encode("GIF89a")), "image/gif");
  assertEquals(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  // HEIC (iPhone "send as file"): ftypheic
  assertEquals(sniffImageType(new TextEncoder().encode("\0\0\0\x18ftypheic")), null);
});

Deno.test("base64 round-trips large inputs (chunked encoding)", () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
  const decoded = Uint8Array.from(atob(encodeBase64(bytes)), (c) => c.charCodeAt(0));
  assertEquals(decoded, bytes);
  assertEquals(encodeBase64(new Uint8Array([104, 105])), "aGk=");
});
