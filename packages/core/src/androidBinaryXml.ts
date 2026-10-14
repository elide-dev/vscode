/**
 * The application ID an APK installs as: the `package` attribute of its compiled `AndroidManifest.xml`.
 *
 * Source and merged manifests cannot answer this: `aapt2 --rename-manifest-package` and `applicationId` placeholders
 * apply while linking. Only the root element is read; anything malformed yields `undefined`.
 */
export function binaryManifestPackage(data: Uint8Array): string | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  try {
    if (u16(0) !== XML_CHUNK) return undefined;
    let strings: (index: number) => string | undefined = () => undefined;
    for (let chunk = u16(2); chunk + 8 <= data.byteLength;) {
      const type = u16(chunk);
      const size = u32(chunk + 4);
      if (size < 8 || chunk + size > data.byteLength) return undefined;
      if (type === STRING_POOL_CHUNK) strings = stringPool(data, view, chunk);
      else if (type === START_ELEMENT_CHUNK) {
        // ResXMLTree_attrExt follows the node header: ns, name, attributeStart, attributeSize, attributeCount.
        const ext = chunk + u16(chunk + 2);
        if (strings(u32(ext + 4)) !== "manifest") return undefined;
        const attributeSize = u16(ext + 10);
        for (let index = 0, count = u16(ext + 12); index < count; index++) {
          const attribute = ext + u16(ext + 8) + index * attributeSize;
          if (u32(attribute) !== NO_INDEX || strings(u32(attribute + 4)) !== "package") continue;
          const raw = u32(attribute + 8);
          // Res_value: size, res0, dataType, data.
          const value = raw !== NO_INDEX ? raw : view.getUint8(attribute + 15) === TYPE_STRING ? u32(attribute + 16) : NO_INDEX;
          return value === NO_INDEX ? undefined : strings(value);
        }
        return undefined;
      }
      chunk += size;
    }
  } catch {
    // A truncated chunk reads past the end of the view.
  }
  return undefined;
}

const XML_CHUNK = 0x0003;
const STRING_POOL_CHUNK = 0x0001;
const START_ELEMENT_CHUNK = 0x0102;
const UTF8_FLAG = 1 << 8;
const NO_INDEX = 0xffffffff;
const TYPE_STRING = 0x03;

/** ResStringPool: lengths are one or two units, high bit marking the two-unit form. */
function stringPool(data: Uint8Array, view: DataView, chunk: number): (index: number) => string | undefined {
  const count = view.getUint32(chunk + 8, true);
  const utf8 = (view.getUint32(chunk + 16, true) & UTF8_FLAG) !== 0;
  const start = chunk + view.getUint32(chunk + 20, true);
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  const utf16Decoder = new TextDecoder("utf-16le", { fatal: true });
  return (index) => {
    if (index >= count) return undefined;
    let offset = start + view.getUint32(chunk + 28 + index * 4, true);
    if (utf8) {
      // UTF-16 length, then the UTF-8 byte length this decode uses.
      offset += view.getUint8(offset) & 0x80 ? 2 : 1;
      let length = view.getUint8(offset);
      if (length & 0x80) length = ((length & 0x7f) << 8) | view.getUint8(++offset);
      return utf8Decoder.decode(data.subarray(offset + 1, offset + 1 + length));
    }
    let length = view.getUint16(offset, true);
    if (length & 0x8000) {
      length = ((length & 0x7fff) << 16) | view.getUint16(offset + 2, true);
      offset += 2;
    }
    return utf16Decoder.decode(data.subarray(offset + 2, offset + 2 + length * 2));
  };
}
