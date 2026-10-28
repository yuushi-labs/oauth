import type { MetadataRoute } from 'next';

/**
 * 全ページをクロール対象外にする。認証・管理画面しか持たないアプリのため、
 * インデックスさせる正当な理由がない（middleware の `X-Robots-Tag: noindex` と二重に防ぐ）。
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: '/',
    },
  };
}
