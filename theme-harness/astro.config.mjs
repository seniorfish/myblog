import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

const themeId = process.env.THEME_ID ?? 'default';

export default defineConfig({
  site: process.env.SITE_URL ?? 'http://localhost:4321',
  output: 'static',
  build: {
    format: 'file',
    inlineStylesheets: 'never',
  },
  trailingSlash: 'never',
  compressHTML: true,
  vite: {
    plugins: [tailwindcss()],
    build: {
      assetsInlineLimit: 0,
    },
    define: {
      __THEME_ID__: JSON.stringify(themeId),
      __THEME_MODEL__: JSON.stringify(process.env.THEME_MODEL ?? ''),
      __THEME_GIT_HASH__: JSON.stringify(process.env.THEME_GIT_HASH ?? 'dev'),
      __THEME_UPDATED_AT__: JSON.stringify(process.env.THEME_UPDATED_AT ?? ''),
      __CONTENT_GIT_HASH__: JSON.stringify(process.env.CONTENT_GIT_HASH ?? 'dev'),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
  },
});
