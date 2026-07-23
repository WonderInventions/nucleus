import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { isUrlEmbeddingManifestKey, rewriteManifestBaseUrl } from '../manifestUrls';

describe('isUrlEmbeddingManifestKey', () => {
  const manifestKeys = [
    'app/chan/win32/x64/RELEASES',
    'app/chan/win32/ia32/37/RELEASES',
    'app/chan/darwin/arm64/RELEASES.json',
    'app/chan/darwin/x64/0/RELEASES.json',
    'app/chan/linux/app.repo',
  ];

  for (const key of manifestKeys) {
    it(`should match ${key}`, () => {
      assert.strictEqual(isUrlEmbeddingManifestKey(key), true);
    });
  }

  const otherKeys = [
    'app/chan/win32/x64/MyApp-1.0.0-full.nupkg',
    'app/chan/darwin/x64/MyApp.zip',
    'app/temp/save1/evil.repo',
    'app/temp/save1/RELEASES',
    'app/chan/linux/redhat/repodata/repomd.xml',
    'app/chan/versions.json',
    'app/chan/_index/1.0.0/win32/x64/MyApp-full.nupkg',
    'app/.lock',
    '__deepcheck',
    'RELEASES',
  ];

  for (const key of otherKeys) {
    it(`should not match ${key}`, () => {
      assert.strictEqual(isUrlEmbeddingManifestKey(key), false);
    });
  }
});

describe('rewriteManifestBaseUrl', () => {
  const rewrite = (content: string, from: string, to: string) =>
    rewriteManifestBaseUrl(Buffer.from(content), from, to).toString();

  it('should rewrite every occurrence in a RELEASES file', () => {
    const releases = [
      'ABC123 https://download.example.com/app/chan/win32/x64/MyApp-1.0.0-full.nupkg 100',
      'DEF456 https://download.example.com/app/chan/win32/x64/MyApp-1.0.1-full.nupkg 200',
    ].join('\n');

    assert.strictEqual(
      rewrite(releases, 'https://download.example.com', 'https://mirror.example.com'),
      [
        'ABC123 https://mirror.example.com/app/chan/win32/x64/MyApp-1.0.0-full.nupkg 100',
        'DEF456 https://mirror.example.com/app/chan/win32/x64/MyApp-1.0.1-full.nupkg 200',
      ].join('\n'),
    );
  });

  it('should rewrite urls inside a RELEASES.json file', () => {
    const releasesJson = JSON.stringify({
      currentRelease: '1.0.0',
      releases: [{
        version: '1.0.0',
        updateTo: { url: 'https://download.example.com/app/chan/darwin/x64/MyApp.zip' },
      }],
    });

    const rewritten = rewrite(releasesJson, 'https://download.example.com', 'https://mirror.example.com');
    assert.strictEqual(
      JSON.parse(rewritten).releases[0].updateTo.url,
      'https://mirror.example.com/app/chan/darwin/x64/MyApp.zip',
    );
  });

  it('should rewrite the baseurl line in a .repo file', () => {
    assert.strictEqual(
      rewrite('[app]\nbaseurl=https://download.example.com/app/chan/linux/redhat\n', 'https://download.example.com', 'https://mirror.example.com'),
      '[app]\nbaseurl=https://mirror.example.com/app/chan/linux/redhat\n',
    );
  });

  it('should be a no-op when the base urls are equal', () => {
    const content = 'ABC https://download.example.com/app/file.nupkg 100';
    assert.strictEqual(rewrite(content, 'https://download.example.com', 'https://download.example.com'), content);
  });

  it('should normalize trailing slashes on both base urls', () => {
    assert.strictEqual(
      rewrite('url=https://download.example.com/file', 'https://download.example.com/', 'https://mirror.example.com//'),
      'url=https://mirror.example.com/file',
    );
  });

  it('should not touch content that does not contain the base url', () => {
    const content = 'some unrelated content';
    assert.strictEqual(rewrite(content, 'https://download.example.com', 'https://mirror.example.com'), content);
  });

  it('should be a no-op when the from base url is empty', () => {
    const content = 'url=https://download.example.com/file';
    assert.strictEqual(rewrite(content, '', 'https://mirror.example.com'), content);
  });

  it('should handle an empty buffer', () => {
    assert.strictEqual(rewrite('', 'https://download.example.com', 'https://mirror.example.com'), '');
  });
});
