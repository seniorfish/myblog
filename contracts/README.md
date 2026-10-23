# IcebergAnchor

Base 主网的事件存证合约。它只做一件事：把 `(sender, commit)` 写进事件日志，不存状态、没有 owner、不可升级。

## 已部署

| 项 | 值 |
|---|---|
| 网络 | Base 主网（chainId 8453） |
| 合约 | `0x210B7AeF6411eceeC16485Ad24f2762562FbfFe4` |
| 区块 | 52996129 |
| 部署 tx | `0x4a49fe95d7941122c51286a7f23b2f11a86165748e4e165846df2c373014baba` |
| 浏览器 | https://basescan.org/address/0x210B7AeF6411eceeC16485Ad24f2762562FbfFe4 |

完整记录见 `deployments/base-mainnet.json`。

## 事件

```solidity
event Anchored(address indexed sender, bytes32 indexed commit);
```

- `topic0` = `keccak256("Anchored(address,bytes32)")` = `0xee1610244dfc4b116b1433dd4459fd7b1d3d2bf737a05fc3f6d8f173005d7147`
- `topic1` = 锚定地址（32 字节左补零）
- `topic2` = commit（Git SHA-1 是 20 字节，右补零到 32 字节）
- `data` 为空

枚举全部锚定：

```bash
cast logs --address 0x210B7AeF6411eceeC16485Ad24f2762562FbfFe4 \
  --from-block 52996129 \
  --rpc-url https://mainnet.base.org
```

按 sender/commit 过滤时，把地址和 commit 各自补成 32 字节 topic。

## commit 编码

Git commit 是 40 hex（20 字节），合约参数是 `bytes32`。约定：

```text
bytes32 = 0x + <40-hex commit> + 24 个 0
```

站点、CLI 和验证器必须使用同一条规则；`core/anchor-index.ts` 的 `encodeCommitBytes32()` 是唯一实现。

## 构建与测试

```bash
npm run contract:build
npm run contract:test
```

或直接：

```bash
forge build --root contracts
forge test --root contracts -vvv
```

## 部署

合约已经部署，通常不需要再动。真要重新部署：

```bash
forge create contracts/src/IcebergAnchor.sol:IcebergAnchor \
  --rpc-url https://mainnet.base.org \
  --account <keystore-account> --password-file <path> \
  --broadcast
```

私钥、助记词和 keystore 密码不得进入仓库或对话。部署后在 `deployments/` 追加记录，并更新 `site.config.ts` 的 `chain.contract` / `chain.deployBlock`。

## 边界

- 合约不可变；事件 schema 变化只能部署新合约，旧记录靠记录里的 `contract` 字段继续可验证。
- 任何地址都能调用 `anchor()`；站点只认 `site.config.ts` 里配置的 sender，索引和页面都会按 sender 过滤。
- 链上只证明“某个 commit 在某个区块时间之前存在”，不证明文件内容；内容验证依赖 GitHub tree/blob 和本地哈希。
