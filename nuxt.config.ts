export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@element-plus/nuxt'],
  devtools: { enabled: false },
  typescript: { strict: true },
  routeRules: {
    '/': { headers: { 'cache-control': 'private, no-store' } },
    '/tasks/**': { headers: { 'cache-control': 'private, no-store' } },
  },
  app: {
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      title: 'AI Grading Workspace',
      meta: [{ name: 'robots', content: 'noindex, nofollow' }],
    },
  },
})
