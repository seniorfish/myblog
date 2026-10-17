import type { SiteConfig } from './core/contract.ts';

const config = {
  title: 'seniorfish 的博客',
  description: '个人数字史记',
  author: 'seniorfish',
  url: 'https://blog.example.com',
  lang: 'zh-CN',
  timezone: 'Asia/Shanghai',
  repo: 'seniorfish/myblog',
  defaultTheme: 'default',
  themes: ['default', 'terminal'],
  ui: {
    contentDisplay: {
      文章: { mode: 'excerpt' },
      想法: { mode: 'full-if-short', maxChars: 400 },
      闪念: { mode: 'full' },
      收藏: { mode: 'link' },
    },
  },
  chain: {
    enabled: false,
    name: 'base-sepolia',
    chainId: 84532,
    address: '0x0000000000000000000000000000000000000000',
    rpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    confirmations: 2,
  },
} satisfies SiteConfig;

export default config;
