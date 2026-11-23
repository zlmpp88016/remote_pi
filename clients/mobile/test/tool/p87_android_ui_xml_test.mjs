import assert from 'node:assert/strict';
import test from 'node:test';
import {
  androidUiNodeLabel,
  decodeAndroidXmlAttribute,
  parseAndroidUiNode,
  parseAndroidUiNodes,
} from '../../tool/history_perf/p87_android_ui_xml.mjs';

test('parses mixed single- and double-quoted Android UI attributes', () => {
  const node = parseAndroidUiNode(`<node index='1' package="com.example.remotepi.p90" text='Synthetic history rp87-large-0008 / 4970&#10;Entry: R&amp;D' content-desc="P87_LARGE_8&#10;只读" bounds='[0,451][1080,2159]' />`);
  assert.equal(node.package, 'com.example.remotepi.p90');
  assert.equal(node.text, 'Synthetic history rp87-large-0008 / 4970\nEntry: R&D');
  assert.equal(node['content-desc'], 'P87_LARGE_8\n只读');
  assert.equal(node.bounds, '[0,451][1080,2159]');
  assert.equal(androidUiNodeLabel(node), 'Synthetic history rp87-large-0008 / 4970 Entry: R&D P87_LARGE_8 只读');
});

test('decodes XML named and decimal/hexadecimal references without corrupting invalid code points', () => {
  assert.equal(decodeAndroidXmlAttribute('&quot;A&amp;B&apos; &lt;C&gt; &#10; &#x1f642;'), '"A&B\' <C> \n 🙂');
  assert.equal(decodeAndroidXmlAttribute('bad &#x110000; &#xD800; &#xzz;'), 'bad &#x110000; &#xD800; &#xzz;');
  assert.equal(decodeAndroidXmlAttribute(null), '');
});

test('filters node tags by package and ignores malformed/non-node input', () => {
  const xml = `<hierarchy><node package='com.example.remotepi.p90' text='visible' /><node package="com.other" text="private" /><view package='com.example.remotepi.p90' text='not a node' /></hierarchy>`;
  const nodes = parseAndroidUiNodes(xml, {packageName: 'com.example.remotepi.p90'});
  assert.equal(nodes.length, 1);
  assert.equal(androidUiNodeLabel(nodes[0]), 'visible');
  assert.deepEqual(parseAndroidUiNodes(xml, {packageName: ''}), []);
  assert.deepEqual(parseAndroidUiNodes(null, {packageName: 'com.example.remotepi.p90'}), []);
  assert.equal(parseAndroidUiNode('<view package="com.example.remotepi.p90"/>'), null);
});