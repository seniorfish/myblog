# IcebergAnchor

Base 主网的事件存证合约。它只做一件事：把 `(sender, commit)` 写进事件日志，不存状态、没有 owner、不可升级。

## 生产部署

| 项 | 值 |
|---|---|
| 网络 | Base 主网（chainId 8453） |
| 合约 | `0x00000000009de13419d7cff80f6d2e1e992146aa` |
| 浏览器 | https://basescan.org/address/0x00000000009de13419d7cff80f6d2e1e992146aa |
| 部署区块 | 53014502 |
| 部署 tx | `0xf2495a463c50ae1434afd600f988ba0578c8464369715cc74866c6da7f981c9d` |

完整记录（含 salt、init code hash、caller）见 `deployments/base-mainnet-vanity.json`；站点通过 `site.config.ts` 指向这个合约与 sender。

### CREATE2 注记

这个 10 零地址由 CREATE2 代理部署。代理的 fallback 期望**原始 calldata** `salt ++ initCode`，不是 ABI 的 `deploy(bytes32,bytes)`：

```bash
cast send 0x4e59b44847b379578588920cA78FbF26c0B4956C \
  --data 0x<salt><initCode> \
  --rpc-url https://mainnet.base.org --browser
```

地址可用 `cast create2 --deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C --salt <salt> --init-code <initCode>` 复算。ABI 写法会成功上链，但不会在目标地址创建合约。

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
cast logs --address 0x00000000009DE13419D7CFf80F6D2e1e992146aA \
  --from-block 53014502 \
  --rpc-url https://mainnet.base.org
```

按 sender / commit 过滤时，把地址和 commit 各自补成 32 字节 topic。

## commit 编码

Git commit 是 40 hex（20 字节），合约参数是 `bytes32`。约定：

```text
bytes32 = 0x + <40-hex commit> + 24 个 0
```

站点、CLI 和验证器必须使用同一条规则；`core/anchor-index.ts` 的 `encodeCommitBytes32()` 是唯一实现。SHA-256 仓库的 64 hex commit 原样使用。

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

合约已经部署，通常不需要再动。真要重新部署（普通 CREATE，不是 10 零合约）：

```bash
forge create contracts/src/IcebergAnchor.sol:IcebergAnchor \
  --rpc-url https://mainnet.base.org \
  --account <keystore-account> --password-file <path> \
  --broadcast
```

部署后在 `deployments/` 追加记录，并更新 `site.config.ts` 的 `chain.contract` / `chain.deployBlock`。私钥、助记词和 keystore 密码不得进入仓库或对话，规则见 [../AGENTS.md](../AGENTS.md)。

## 边界

- 合约不可变；事件 schema 变化只能部署新合约，旧记录靠记录里的 `contract` 字段继续可验证。
- 任何地址都能调用 `anchor()`；站点只认 `site.config.ts` 里配置的 sender，索引和页面按 sender 过滤。
- 链上只证明“某个 commit 在某个区块时间之前存在”，不证明文件内容；内容验证依赖 GitHub tree/blob 与本地哈希。
