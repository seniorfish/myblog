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
    address: '0x000000000007C44d92De38e7CdBA161fE9CfBC4e',
    contract: '0x00000000009DE13419D7CFf80F6D2e1e992146aA',
    deployBlock: 53014502,
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    confirmations: 2,
  },
} satisfies SiteConfig;

export default config;
