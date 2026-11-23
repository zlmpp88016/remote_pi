const NAMED_XML_ENTITIES = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
});

/** Decode XML attribute character references emitted by Android UiAutomator. */
export function decodeAndroidXmlAttribute(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (match, body) => {
    if (body[0] !== '#') return NAMED_XML_ENTITIES[body.toLowerCase()] ?? match;
    const hexadecimal = body[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)) return match;
    try { return String.fromCodePoint(codePoint); } catch { return match; }
  });
}

/** Parse one UiAutomator node tag without assuming one quote style. */
export function parseAndroidUiNode(tag) {
  if (typeof tag !== 'string' || !/^<node(?:\s|\/?>)/.test(tag)) return null;
  const attributes = {};
  const pattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of tag.matchAll(pattern)) {
    attributes[match[1]] = decodeAndroidXmlAttribute(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

/** Parse only nodes owned by the requested application package. */
export function parseAndroidUiNodes(xml, { packageName } = {}) {
  if (typeof xml !== 'string' || typeof packageName !== 'string' || packageName.length === 0) return [];
  const result = [];
  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const node = parseAndroidUiNode(match[0]);
    if (node?.package === packageName) result.push(node);
  }
  return result;
}

/** Combine accessible text after entity decoding; layout whitespace is not semantic. */
export function androidUiNodeLabel(node) {
  if (!node || typeof node !== 'object') return '';
  return [node.text, node['content-desc']]
    .filter(value => typeof value === 'string' && value.length > 0)
    .join(' ')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}