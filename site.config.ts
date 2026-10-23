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
  homeTag: '首页',
  ui: {
    contentDisplay: {
      文章: { mode: 'excerpt' },
      想法: { mode: 'full-if-short', maxChars: 400 },
      闪念: { mode: 'full' },
      收藏: { mode: 'link' },
    },
  },
  chain: {
    enabled: true,
    name: 'base-mainnet',
    chainId: 8453,
    address: '0xDCd2AC2bcd55E1C4E6B313bE189f8366163c6492',
    contract: '0x210B7AeF6411eceeC16485Ad24f2762562FbfFe4',
    deployBlock: 52996129,
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    confirmations: 2,
  },
} satisfies SiteConfig;

export default config;
